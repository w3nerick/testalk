/**
 * Verificador de recibos por línea de comandos. No necesita Polkadot App.
 *
 *   npm run verify -- ../examples/rehearsal.json
 *   npm run verify -- bafk2bza…            (lee el recibo del gateway IPFS del devnet)
 *
 * Comprueba la firma sr25519, que el username declarado sea dueño de la llave
 * en People chain y cada block hash en Asset Hub, por RPC público. Sale con
 * código 0 si el recibo es válido y 1 si no.
 */
import { readFileSync } from 'node:fs';
import { createClient } from 'polkadot-api';
import { getWsProvider } from 'polkadot-api/ws';
import { decodeAddress, encodeAddress } from '@polkadot/util-crypto';
import { hexToU8a, u8aToHex } from '@polkadot/util';
import {
  artifactShapeError,
  blake256Hex,
  cidForBytes,
  signerAddress,
  verifyBlocks,
  verifyIdentity,
  verifySignature,
  type Artifact,
} from '../src/lib/artifact.ts';
import { readSeal } from '../src/lib/registry.ts';
import { ASSET_HUB_GENESIS, IPFS_GATEWAY, PEOPLE_WS, PUBLIC_WS } from '../src/lib/network.ts';

const c = {
  ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
  bad: (s: string) => `\x1b[31m${s}\x1b[0m`,
  warn: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

async function load(arg: string): Promise<Uint8Array> {
  if (/^b[a-z2-7]{50,}$/.test(arg)) {
    const r = await fetch(`${IPFS_GATEWAY}/${arg}`, { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`el gateway respondió ${r.status}; el recibo pudo expirar (Bulletin guarda 14 días)`);
    return new Uint8Array(await r.arrayBuffer());
  }
  return new Uint8Array(readFileSync(arg));
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('uso: npm run verify -- <recibo.json | CID>');
    process.exit(2);
  }

  const bytes = await load(arg);
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  const bad = artifactShapeError(parsed);
  if (bad) {
    console.error(c.bad(`No es un recibo de testalk: ${bad}`));
    process.exit(1);
  }
  const a = parsed as Artifact;
  const blocks = a.chain.filter(e => 'full' in e).length;
  const addr = signerAddress(a);

  console.log(`\n${c.bold(a.title)}`);
  console.log(c.dim(`${a.speaker || addr} (declarado) · ${a.venue || 'sin evento'} · ${a.window}`));
  console.log(c.dim(`CID ${cidForBytes(bytes)}`));
  if ((a as { rehearsal?: boolean }).rehearsal) console.log(c.warn('Recibo de ensayo (cuenta de prueba)'));
  console.log();

  const sig = await verifySignature(a);
  console.log(sig.ok ? c.ok('✓ Firma válida') : c.bad(`✗ Firma inválida: ${sig.reason}`), c.dim(`(${sig.crypto ?? '?'}, ${addr})`));

  // Identidad: lo que el recibo declara contra lo que la firma prueba.
  const people = createClient(getWsProvider(PEOPLE_WS));
  const ownerOf = async (username: string) => {
    const q = people.getUnsafeApi().query.Resources.UsernameOwnerOf.getValue(new TextEncoder().encode(username)) as Promise<string | undefined>;
    const r = await Promise.race([q, new Promise<'timeout'>(res => setTimeout(() => res('timeout'), 15_000))]);
    if (r === 'timeout') throw new Error('People chain no respondió');
    return r ? u8aToHex(decodeAddress(r)) : null;
  };
  const id = await verifyIdentity(a, ownerOf);
  people.destroy();
  if (id.status === 'verified') console.log(c.ok(`✓ Identidad: la llave es la dueña de ${id.username} en People chain`));
  else if (id.status === 'none') console.log(c.warn('! Sin identidad comprobable: el recibo no declara username'));
  else if (id.status === 'address') console.log(c.bad(`✗ Dirección falsa: el recibo dice ${id.claimed}, la firma es de ${addr}`));
  else if (id.status === 'mismatch') {
    console.log(c.bad(id.owner
      ? `✗ Identidad falsa: ${id.username} es de ${encodeAddress(hexToU8a(id.owner), 42)}, no de ${addr}`
      : `✗ Identidad falsa: ${id.username} no existe en People chain`));
  } else console.log(c.warn(`! Identidad sin comprobar: ${id.reason}`));

  const client = createClient(getWsProvider(PUBLIC_WS));
  // Sin red, una consulta pendiente nunca resuelve: tope de 10 s y cuenta como "sin respuesta".
  const capped = <T,>(p: Promise<T>) =>
    Promise.race([p, new Promise<null>(r => setTimeout(() => r(null), 10_000))]).catch(() => null);
  const hashAt = async (n: number) => {
    const r = await capped(client._request<string[] | string | null>('archive_v1_hashByHeight', [n]));
    const h = Array.isArray(r) ? r[0] : r;
    return h || capped(client._request<string | null>('chain_getBlockHash', [n]));
  };
  const b = await verifyBlocks(a, hashAt, ASSET_HUB_GENESIS, (d, t) => process.stdout.write(c.dim(`\r  consultando ${d}/${t} bloques…`)));
  process.stdout.write('\r\x1b[K');
  // undefined = no se pudo consultar; null = consultado y no está sellado.
  const seal = await Promise.race([
    readSeal(client, blake256Hex(bytes)),
    new Promise<undefined>(r => setTimeout(() => r(undefined), 10_000)),
  ]).catch(() => undefined);
  client.destroy();

  if (b.status === 'ok') console.log(c.ok(`✓ ${b.matched}/${blocks} bloques existen en Asset Hub`));
  else if (b.status === 'fail') console.log(c.bad(`✗ ${b.mismatched.length} bloques no coinciden (primero #${b.mismatched[0].blk})`));
  else if (b.status === 'partial') console.log(c.warn(`! ${b.matched} confirmados, ${b.unknown} sin respuesta`));
  else console.log(c.warn(`! Bloques sin comprobar: ${b.reason}`));

  if (seal) console.log(c.ok(`✓ Sello permanente en Asset Hub, bloque #${Number(seal.blockNumber).toLocaleString('en-US')} (${new Date(Number(seal.sealedAt) * 1000).toISOString()})`));
  else if (seal === null) console.log(c.warn('! Sin sello permanente: Bulletin lo borra a los 14 días'));
  else console.log(c.dim('· Registro permanente sin consultar'));

  const idBad = id.status === 'address' || id.status === 'mismatch';
  const valid = sig.ok && b.status !== 'fail' && !idBad;
  const verdict = valid ? 'CHARLA VERIFICADA' : sig.ok && idBad ? 'IDENTIDAD FALSA' : 'RECIBO NO VÁLIDO';
  console.log(`\n${valid ? c.ok(c.bold(verdict)) : c.bad(c.bold(verdict))}\n`);
  process.exit(valid ? 0 : 1);
}

main().catch(e => {
  console.error(c.bad(`error: ${(e as Error).message}`));
  process.exit(2);
});
