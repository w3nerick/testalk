/**
 * ¿Quedó todo el deploy on-chain, y hasta cuándo? Correr después de `npm run deploy`.
 *
 *   npm run check-deploy
 *
 * 1. DotNS: el CID al que apunta el nombre (con el CLI `dotns`).
 * 2. Reconstruye desde dist/ los chunks del deploy con el mismo código de `pad`
 *    y comprueba que dan ese CID.
 * 3. Bulletin: busca la raíz y cada chunk en TransactionStorage.TransactionByContentHash,
 *    que dice en qué bloque se guardó cada uno; de ahí sale cuándo caduca.
 * 4. Gateway IPFS: baja el deploy y lo compara byte por byte con dist/.
 *
 * `pad` no vuelve a subir los chunks que ya venían en el deploy anterior, así que
 * esos conservan la caducidad de su primera subida: la fecha que importa es
 * "lo primero que caduca". Sale con código 0 si todo está y 1 si no.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createClient } from 'polkadot-api';
import { getWsProvider } from 'polkadot-api/ws';
import { Blake2128Concat, Twox128 } from '@polkadot-api/substrate-bindings';
import { CID } from 'multiformats/cid';
import { APP_LABEL, IPFS_GATEWAY, WEB_GATEWAY } from '../src/lib/network.ts';

/** Bulletin del Products Devnet, los mismos que usa `pad`. */
const BULLETIN_WS = ['wss://bulletin-paseo.tservices.es:8443', 'wss://bullet.sik.rocks'];
const DIST = new URL('../dist', import.meta.url).pathname;

const c = {
  ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
  bad: (s: string) => `\x1b[31m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};
let fails = 0;
const check = (good: boolean, s: string) => {
  console.log(`${good ? c.ok('✓') : c.bad('✗')} ${s}`);
  if (!good) fails++;
};

// 1. DotNS
const dotns = execFileSync('dotns', ['content', 'view', APP_LABEL, '--env', 'devnet'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const onchain = /cid:\s+(\S+)/.exec(dotns)?.[1];
if (!onchain) throw new Error(`dotns no devolvió un CID para ${APP_LABEL}.dot`);
console.log(`${c.bold(`${APP_LABEL}.dot`)} → ${onchain}`);

// 2. Reconstrucción con el código de pad. DotNS no apunta al directorio sino a
//    un nodo que enlaza los chunks del CAR (computeStorageCid).
const pad = join(dirname(realpathSync(execFileSync('which', ['pad'], { encoding: 'utf8' }).trim())), '../dist');
const { merkleizeWithStableOrder } = await import(join(pad, 'merkle.js'));
const { computeStorageCid } = await import(join(pad, 'deploy.js'));
const manifest = JSON.parse(readFileSync(join(DIST, '.bulletin-deploy/manifest.json'), 'utf8'));
const log = console.log;
console.log = () => {};
const car: { chunks: Uint8Array[]; chunkCids: string[]; carBytes: Uint8Array } =
  await merkleizeWithStableOrder(DIST, manifest.stableBlockOrder, { useKubo: false });
console.log = log;
const root: string = computeStorageCid(car.chunks);
check(root === onchain, `dist/ reconstruido da el mismo CID ${c.dim(`(${car.chunkCids.length} chunks, ${(car.carBytes.length / 1e6).toFixed(2)} MB)`)}`);

// 3. Bulletin
const client = createClient(getWsProvider(BULLETIN_WS));
const rpc = (method: string, params: unknown[] = []) => client._request<any, unknown[]>(method, params);
const retention = Number(await client.getUnsafeApi().query.TransactionStorage.RetentionPeriod.getValue());
const current = parseInt((await rpc('chain_getHeader')).number, 16);
const prefix = Buffer.concat([Twox128(new TextEncoder().encode('TransactionStorage')), Twox128(new TextEncoder().encode('TransactionByContentHash'))]);
const key = (cid: string) => '0x' + Buffer.concat([prefix, Blake2128Concat(CID.parse(cid).multihash.digest)]).toString('hex');
const cids = [root, ...car.chunkCids];
const [changes] = await rpc('state_queryStorageAt', [cids.map(key)]);
client.destroy();
const stored = new Map<string, string | null>(changes?.changes ?? []);

const when = (blocks: number, secs: number) => new Date(Date.now() + blocks * secs * 1000).toISOString().slice(0, 16).replace('T', ' ');
let first = Infinity;
for (const cid of cids) {
  const v = stored.get(key(cid));
  const name = `${cid === root ? 'raíz ' : 'chunk'} ${cid.slice(0, 20)}…`;
  if (!v || v === '0x') {
    check(false, `${name} no está en Bulletin`);
    continue;
  }
  const block = Buffer.from(v.slice(2), 'hex').readUInt32LE(0);
  const left = block + retention - current;
  first = Math.min(first, left);
  // Bloques reales de 6.5 a 7.2 s: la fecha es aproximada.
  check(true, `${name} bloque ${block} ${c.dim(`→ caduca ~${when(left, 6.9)} UTC`)}`);
}
if (first < Infinity) {
  console.log(`  Lo primero que caduca: en ${first} bloques, ${c.bold(`entre ${when(first, 6)} y ${when(first, 7.2)} UTC`)}`);
}

// 4. El gateway sirve el CID como el CAR completo del deploy.
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
try {
  const r = await fetch(`${IPFS_GATEWAY}/${onchain}`, { signal: AbortSignal.timeout(120_000) });
  const remote = new Uint8Array(await r.arrayBuffer());
  check(r.ok && sha(remote) === sha(car.carBytes), `el gateway IPFS entrega el deploy idéntico byte por byte a dist/`);
} catch (e) {
  check(false, `gateway IPFS: ${(e as Error).message}`);
}
const web = await fetch(WEB_GATEWAY, { signal: AbortSignal.timeout(30_000) }).catch((e: Error) => ({ ok: false, status: e.message }));
check(web.ok, `${WEB_GATEWAY} responde ${web.status}`);

console.log(fails ? c.bad(`\n${fails} problema(s)`) : c.ok('\nTodo on-chain y legible.'));
process.exit(fails ? 1 : 0);
