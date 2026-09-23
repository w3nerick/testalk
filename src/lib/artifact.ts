/**
 * Formato del artefacto — compatible con el v1 de Proof of Talk (Karim Jedda).
 *
 * Mismas claves y misma convención de firma, así un artefacto suyo se verifica
 * aquí y uno nuestro se verificaría en proofoftalk.dot. Lo que añadimos va en
 * claves nuevas (`network`, `genesis`, `lang`, `audio`, `speaker_address`) que su
 * verificador ignora pero que sí quedan cubiertas por la firma.
 */
import { blake2b } from '@noble/hashes/blake2b';
import { CID } from 'multiformats/cid';
import { create as createDigest } from 'multiformats/hashes/digest';
import { cryptoWaitReady, signatureVerify } from '@polkadot/util-crypto';
import { hexToU8a, u8aToHex } from '@polkadot/util';

export type ChainEntry =
  | { s: string }
  | { h: string; blk: string; time: string; full: string };

export interface AudioSeal {
  alg: 'blake2b-256';
  hash: string;
  bytes: number;
  seconds: number;
}

export interface Artifact {
  v: 1;
  speaker: string;
  dotns: string;
  title: string;
  venue: string;
  started_at: string;
  ended_at: string;
  window: string;
  anchor_block: string;
  total_sentences: number;
  total_blocks: number;
  chain: ChainEntry[];
  network?: string;
  genesis?: string;
  lang?: string;
  speaker_address?: string;
  audio?: AudioSeal | null;
  pubkey: string;
  sig: string;
  sig_alg: 'sr25519' | string;
}

export type UnsignedArtifact = Omit<Artifact, 'pubkey' | 'sig' | 'sig_alg'>;

// CID de Bulletin: CIDv1 + codec raw + multihash blake2b-256.
const CODEC_RAW = 0x55;
const MH_BLAKE2B_256 = 0xb220;

/**
 * Bytes que se firman: sin sig/pubkey/sig_alg, claves de primer nivel
 * ordenadas, JSON.stringify, UTF-8. Idéntico al de Karim — si cambia un byte,
 * ninguna firma vieja vuelve a validar.
 */
export function canonicalBytes(a: Record<string, unknown>): Uint8Array {
  const { sig: _s, pubkey: _p, sig_alg: _a, ...rest } = a;
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(rest).sort()) sorted[k] = rest[k];
  return new TextEncoder().encode(JSON.stringify(sorted));
}

export function blake256Hex(bytes: Uint8Array): string {
  return u8aToHex(blake2b(bytes, { dkLen: 32 }));
}

export function cidForBytes(bytes: Uint8Array): string {
  const digest = blake2b(bytes, { dkLen: 32 });
  return CID.createV1(CODEC_RAW, createDigest(MH_BLAKE2B_256, digest)).toString();
}

/** Clave del preimage en Bulletin = el digest dentro del CID. */
export function preimageKeyFromCid(cid: string): `0x${string}` {
  return u8aToHex(CID.parse(cid).multihash.digest) as `0x${string}`;
}

export function blockEntry(b: { number: number; hash: string }, at = new Date()): ChainEntry {
  return {
    h: `${b.hash.slice(0, 6)}…${b.hash.slice(-4)}`,
    blk: b.number.toLocaleString('en-US'),
    time: at.toTimeString().slice(0, 8),
    full: b.hash,
  };
}

export function parseBlk(blk: string): number {
  return Number(blk.replace(/[^0-9]/g, ''));
}

export interface SigCheck {
  ok: boolean;
  reason?: string;
  crypto?: string;
}

export async function verifySignature(a: Artifact): Promise<SigCheck> {
  if (!a || typeof a !== 'object') return { ok: false, reason: 'el artefacto no es un objeto' };
  if (!a.sig || !a.pubkey) return { ok: false, reason: 'falta sig o pubkey' };
  await cryptoWaitReady();
  try {
    // signatureVerify detecta el esquema y si el firmante envolvió el mensaje
    // en <Bytes>…</Bytes>, que es lo que hacen los signers de Polkadot.
    const r = signatureVerify(canonicalBytes(a as unknown as Record<string, unknown>), hexToU8a(a.sig), hexToU8a(a.pubkey));
    if (!r.isValid) return { ok: false, reason: 'la firma no corresponde al contenido', crypto: r.crypto };
    if (a.sig_alg && r.crypto !== 'none' && a.sig_alg !== r.crypto) {
      return { ok: false, reason: `sig_alg dice ${a.sig_alg} pero la firma es ${r.crypto}`, crypto: r.crypto };
    }
    return { ok: true, crypto: r.crypto };
  } catch (e) {
    return { ok: false, reason: `error al verificar: ${(e as Error).message}` };
  }
}

export type BlockStatus = 'ok' | 'mismatch' | 'unknown';

export interface BlocksCheck {
  status: 'ok' | 'fail' | 'partial' | 'skipped';
  checked: number;
  matched: number;
  mismatched: { blk: string; expected: string; onchain: string }[];
  unknown: number;
  reason?: string;
}

/**
 * Comprueba que cada block hash del artefacto exista en la cadena a esa altura.
 * Karim no lo hace: su verificador solo revisa la firma, así que un artefacto
 * con hashes inventados pero bien firmado le pasaría.
 */
export async function verifyBlocks(
  a: Artifact,
  hashAt: (n: number) => Promise<string | null>,
  expectedGenesis: string,
  onProgress?: (done: number, total: number) => void,
): Promise<BlocksCheck> {
  const blocks = a.chain.filter((e): e is Extract<ChainEntry, { full: string }> => 'full' in e);
  const empty = { checked: 0, matched: 0, mismatched: [], unknown: 0 };
  if (!a.genesis) return { ...empty, status: 'skipped', reason: 'el artefacto no dice de qué red son los bloques' };
  if (a.genesis.toLowerCase() !== expectedGenesis.toLowerCase()) {
    return { ...empty, status: 'skipped', reason: `bloques de otra red (${a.genesis.slice(0, 10)}…)` };
  }

  const out: BlocksCheck = { status: 'ok', checked: blocks.length, matched: 0, mismatched: [], unknown: 0 };
  let done = 0;
  const queue = [...blocks];
  const worker = async () => {
    for (let b = queue.shift(); b; b = queue.shift()) {
      const onchain = await hashAt(parseBlk(b.blk)).catch(() => null);
      if (!onchain) out.unknown++;
      else if (onchain.toLowerCase() === b.full.toLowerCase()) out.matched++;
      else out.mismatched.push({ blk: b.blk, expected: b.full, onchain });
      onProgress?.(++done, blocks.length);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));

  if (out.mismatched.length) out.status = 'fail';
  else if (out.unknown) out.status = out.matched ? 'partial' : 'skipped';
  if (out.status === 'skipped') out.reason = 'la red no respondió consultas por altura';
  return out;
}
