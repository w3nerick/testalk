/**
 * Verificador de recibos por línea de comandos. No necesita Polkadot App.
 *
 *   npm run verify -- ../examples/rehearsal.json
 *   npm run verify -- bafk2bza…            (lee el recibo del gateway IPFS del devnet)
 *
 * Comprueba la firma sr25519 y consulta cada block hash en Asset Hub por RPC
 * público. Sale con código 0 si el recibo es válido y 1 si no.
 */
import { readFileSync } from 'node:fs';
import { createClient } from 'polkadot-api';
import { getWsProvider } from 'polkadot-api/ws';
import { blake256Hex, cidForBytes, verifyBlocks, verifySignature, type Artifact } from '../src/lib/artifact.ts';
import { readSeal } from '../src/lib/registry.ts';
import { ASSET_HUB_GENESIS, IPFS_GATEWAY, PUBLIC_WS } from '../src/lib/network.ts';

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
  const a = JSON.parse(new TextDecoder().decode(bytes)) as Artifact;
  const blocks = a.chain.filter(e => 'full' in e).length;

  console.log(`\n${c.bold(a.title)}`);
  console.log(c.dim(`${a.speaker || a.speaker_address} · ${a.venue || 'sin evento'} · ${a.window}`));
  console.log(c.dim(`CID ${cidForBytes(bytes)}`));
  if ((a as { rehearsal?: boolean }).rehearsal) console.log(c.warn('Recibo de ensayo (cuenta de prueba)'));
  console.log();

  const sig = await verifySignature(a);
  console.log(sig.ok ? c.ok('✓ Firma válida') : c.bad(`✗ Firma inválida: ${sig.reason}`), c.dim(`(${sig.crypto ?? '?'}, ${a.pubkey.slice(0, 10)}…)`));

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
  console.log(a.audio ? c.ok(`✓ Huella del audio ${a.audio.hash.slice(0, 18)}… (${a.audio.seconds} s)`) : c.dim('· Sin huella de audio'));

  const valid = sig.ok && b.status !== 'fail';
  console.log(`\n${valid ? c.ok(c.bold('CHARLA VERIFICADA')) : c.bad(c.bold('RECIBO NO VÁLIDO'))}\n`);
  process.exit(valid ? 0 : 1);
}

main().catch(e => {
  console.error(c.bad(`error: ${(e as Error).message}`));
  process.exit(2);
});
