// Re-firma un recibo de testalk con tu propia cuenta.
//
//   npm run sign -- ../examples/recibo.json [--dotns nombre.dot] [--salida otro.json]
//
// Sirve para dos cosas:
// - Convertir un recibo de ensayo (firmado con //Alice fuera de Polkadot App)
//   en uno auténtico tuyo.
// - Plan B en el evento: si la firma dentro de la app falla, se descarga el
//   JSON y se firma aquí.
//
// 1. Verifica la firma actual: si el contenido se alteró, no se firma encima.
// 2. Quita `rehearsal` y pone speaker, speaker_address y pubkey de tu cuenta.
// 3. Firma los bytes canónicos envueltos en <Bytes>…</Bytes>, igual que signRaw
//    de una wallet, así el recibo es idéntico a uno hecho dentro de la app.
// 4. Escribe un archivo nuevo; el original no se toca. No envía nada a la red.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { u8aToHex, u8aWrapBytes } from '@polkadot/util';
import { verifySignature, canonicalBytes, cidForBytes } from '../../app/src/lib/artifact.ts';
import { loadKeypair } from './lib.mjs';

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const file = args.find((a, i) => !a.startsWith('--') && !['--dotns', '--salida'].includes(args[i - 1]));
if (!file) { console.error('uso: npm run sign -- <recibo.json> [--dotns nombre.dot] [--salida otro.json]'); process.exit(2); }
const out = opt('--salida') ?? file.replace(/\.json$/i, '') + '.firmado.json';
if (existsSync(out)) { console.error(`Ya existe ${out}. Bórralo o usa --salida.`); process.exit(1); }

const a = JSON.parse(readFileSync(file, 'utf8'));
const before = await verifySignature(a);
if (!before.ok) { console.error(`La firma actual no valida (${before.reason}). No se firma encima de un recibo alterado.`); process.exit(1); }

console.log(`Recibo:  ${a.title}`);
console.log(`Firmado: ${a.rehearsal ? 'ensayo (//Alice)' : a.speaker_address}\n`);

let pair;
try { pair = await loadKeypair(); } catch (e) { console.error(e.message); process.exit(1); }

const dotns = opt('--dotns') ?? '';
const { rehearsal: _r, sig: _s, pubkey: _p, sig_alg: _a, ...rest } = a;
const unsigned = {
  ...rest,
  speaker: dotns || `${pair.address.slice(0, 6)}…${pair.address.slice(-6)}`,
  dotns,
  speaker_address: pair.address,
};
const sig = u8aToHex(pair.sign(u8aWrapBytes(canonicalBytes(unsigned))));
const signed = { ...unsigned, pubkey: u8aToHex(pair.publicKey), sig, sig_alg: 'sr25519' };

const after = await verifySignature(signed);
if (!after.ok) { console.error(`La firma nueva no valida (${after.reason}). No se escribió nada.`); process.exit(1); }

// Mismo formato que la app (JSON.stringify sin espacios): la huella y el CID dependen de cada byte.
const bytes = new TextEncoder().encode(JSON.stringify(signed));
writeFileSync(out, bytes);
console.log(`\nCuenta:  ${pair.address}`);
console.log(`CID:     ${cidForBytes(bytes)}`);
console.log(`Listo:   ${out}`);
