// Ancla un recibo de testalk en TalkRegistry.
//
//   npm run anchor -- ../examples/recibo.json
//
// 1. Verifica la firma del recibo en local (no se ancla basura).
// 2. Calcula su huella blake2b-256 (el digest de su CID en Bulletin).
// 3. Simula la llamada seal() contra pallet-revive.
// 4. Pide la semilla, vuelve a simular desde tu cuenta y solo firma si escribes SELLAR.
//
// Los recibos de ensayo (firmados con //Alice) se rechazan salvo --ensayo.
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { Binary } from 'polkadot-api';
import { verifySignature, blake256Hex, cidForBytes, parseBlk } from '../../app/src/lib/artifact.ts';
import { connect, registryAddress, encode, simulateCall, readSeal, decodeRevert, loadSigner, pas, hex, WEIGHT_CAP } from './lib.mjs';

const file = process.argv.slice(2).find(a => !a.startsWith('--'));
if (!file) { console.error('uso: npm run anchor -- <recibo.json> [--ensayo]'); process.exit(2); }
const dest = registryAddress();
if (!dest) { console.error('No hay contrato desplegado (falta contract/deployments.json).'); process.exit(1); }

const bytes = new Uint8Array(readFileSync(file));
const a = JSON.parse(new TextDecoder().decode(bytes));
const receiptHash = blake256Hex(bytes);
const firstBlk = a.chain.find(e => 'full' in e);

console.log(`Recibo:   ${a.title}`);
console.log(`CID:      ${cidForBytes(bytes)}`);
console.log(`Huella:   ${receiptHash}`);
console.log(`Contrato: ${dest}\n`);

const sig = await verifySignature(a);
if (!sig.ok) { console.error(`Firma inválida: ${sig.reason}. No se ancla.`); process.exit(1); }
if (a.rehearsal && !process.argv.includes('--ensayo')) { console.error('Es un recibo de ensayo (//Alice). Usa --ensayo si de verdad quieres anclarlo.'); process.exit(1); }
if (!firstBlk) { console.error('El recibo no tiene bloques.'); process.exit(1); }

const { client, api } = connect();
const exit = (code, msg) => { if (msg) console.error(msg); client.destroy(); process.exit(code); };

const existing = await readSeal(api, dest, receiptHash);
if (existing) exit(0, `Ya estaba sellado en el bloque #${existing.blockNumber}. Nada que hacer.`);

const data = encode('seal', [receiptHash, a.pubkey, a.sig, parseBlk(firstBlk.blk), cidForBytes(bytes), String(a.title).slice(0, 200)]);
const simulate = async origin => {
  const r = await simulateCall(api, dest, data, origin);
  const v = r.result?.success ? r.result.value : null;
  if (!v) return { ok: false, why: JSON.stringify(r.result, (k, x) => (typeof x === 'bigint' ? x.toString() : x)) };
  if (v.flags) return { ok: false, why: decodeRevert(hex(v.data)) };
  return { ok: true, r };
};

let sim = await simulate();
console.log(`Simulación: ${sim.ok ? 'OK' : `FALLA: ${sim.why}`}`);
if (!sim.ok) exit(1);

let who;
try { who = await loadSigner(); } catch (e) { exit(1, e.message); }
const acc = await api.query.System.Account.getValue(who.address);
console.log(`Cuenta:   ${who.address}  (${pas(BigInt(acc?.data?.free ?? 0n))})`);

sim = await simulate(who.address);
if (!sim.ok) exit(1, `La simulación desde tu cuenta falló: ${sim.why}. No se firmó nada.`);
const deposit = sim.r.storage_deposit?.type === 'Charge' ? sim.r.storage_deposit.value : 0n;
console.log(`Depósito: ${pas(deposit)}`);

const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = (await rl.question('\nEscribe SELLAR para firmar y enviar: ')).trim();
rl.close();
if (answer !== 'SELLAR') exit(0, 'Cancelado. No se firmó nada.');

const need = sim.r.weight_required;
const res = await api.tx.Revive.call({
  dest: Binary.fromHex(dest),
  value: 0n,
  weight_limit: {
    ref_time: need.ref_time * 2n < WEIGHT_CAP.ref_time ? need.ref_time * 2n : WEIGHT_CAP.ref_time,
    proof_size: need.proof_size * 2n < WEIGHT_CAP.proof_size ? need.proof_size * 2n : WEIGHT_CAP.proof_size,
  },
  storage_deposit_limit: (deposit * 3n) / 2n + 10n ** 9n,
  data: Binary.fromHex(data),
}).signAndSubmit(who.signer);
if (!res.ok) exit(1, `Falló: ${JSON.stringify(res.dispatchError, (k, v) => (typeof v === 'bigint' ? v.toString() : v))}`);

const seal = await readSeal(api, dest, receiptHash);
console.log(seal ? `\nSellado en el bloque #${seal.blockNumber} (tx ${res.txHash})` : `\nEnviado en el bloque ${res.block?.number}, pero la lectura aún no lo ve.`);
exit(0);
