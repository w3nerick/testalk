// Despliega TalkRegistry en pallet-revive (Asset Hub, Products Devnet).
//
//   npm run simulate   Simula con el bytecode PolkaVM real. No pide semilla ni gasta nada.
//   npm run deploy     Pide la semilla (sin eco), simula desde TU cuenta, muestra
//                      el costo y solo firma si escribes DESPLEGAR.
//
// Instancia directo con Revive.instantiate_with_code: `cdm deploy` revierte al
// registrar nombres nuevos (TWR.DOT).
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { Binary } from 'polkadot-api';
import { connect, simulateInstantiate, loadSigner, pas, hex, WEIGHT_CAP, DEPLOYMENTS, PVM } from './lib.mjs';

const SIMULATE = process.argv.includes('--simulate');
const { client, api } = connect();
const exit = (code, msg) => { if (msg) console.error(msg); client.destroy(); process.exit(code); };

function report(r) {
  const ok = r.result?.success && !r.result.value.result.flags;
  const deposit = r.storage_deposit?.type === 'Charge' ? r.storage_deposit.value : 0n;
  console.log(`Simulación:   ${ok ? 'OK' : 'FALLA'}`);
  console.log(`Depósito:     ${pas(deposit)} (queda bloqueado mientras exista el contrato)`);
  console.log(`Peso:         ref_time ${r.weight_required.ref_time}, proof_size ${r.weight_required.proof_size}`);
  if (!ok) console.log('Detalle:', JSON.stringify(r.result, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  return { ok, deposit };
}

console.log(`Bytecode PolkaVM: ${readFileSync(PVM).length} bytes\n`);

if (SIMULATE) {
  const { r } = await simulateInstantiate(api);
  const { ok } = report(r);
  exit(ok ? 0 : 1, ok ? '\nListo para desplegar: npm run deploy' : undefined);
}

let who;
try { who = await loadSigner(); } catch (e) { exit(1, e.message); }
const acc = await api.query.System.Account.getValue(who.address);
const free = BigInt(acc?.data?.free ?? 0n);
console.log(`Cuenta:       ${who.address}`);
console.log(`Saldo:        ${pas(free)}\n`);

const { code, r } = await simulateInstantiate(api, who.address);
const { ok, deposit } = report(r);
if (!ok) exit(1, '\nLa simulación desde tu cuenta falló: no se firmó nada.');
if (free < deposit + 10n ** 10n) exit(1, `\nSaldo insuficiente: hace falta al menos ${pas(deposit + 10n ** 10n)}.`);

const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = (await rl.question('\nEscribe DESPLEGAR para firmar y enviar: ')).trim();
rl.close();
if (answer !== 'DESPLEGAR') exit(0, 'Cancelado. No se firmó nada.');

console.log('Enviando…');
const res = await api.tx.Revive.instantiate_with_code({
  value: 0n,
  weight_limit: WEIGHT_CAP,
  storage_deposit_limit: (deposit * 3n) / 2n,
  code: Binary.fromHex('0x' + code.toString('hex')),
  data: Binary.fromHex('0x'),
  salt: undefined,
}).signAndSubmit(who.signer);

if (!res.ok) exit(1, `Deploy fallido: ${JSON.stringify(res.dispatchError, (k, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
const ev = res.events.find(e => e.type === 'Revive' && e.value?.type === 'Instantiated');
// Con la api sin tipar la dirección es un Binary: sin asHex() se imprime [object Object] y se pierde.
const address = hex(ev?.value?.value?.contract);
if (!address) exit(1, `Sin evento Instantiated. Bloque ${res.block?.number}, tx ${res.txHash}`);

writeFileSync(DEPLOYMENTS, JSON.stringify({
  devnet: { address, block: res.block?.number, tx: res.txHash, deployer: who.address, deployedAt: new Date().toISOString() },
}, null, 2) + '\n');
console.log(`\nTalkRegistry: ${address}`);
console.log(`Bloque ${res.block?.number}, tx ${res.txHash}`);
console.log('Guardado en contract/deployments.json');
exit(0);
