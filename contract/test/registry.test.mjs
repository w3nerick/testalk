// Pruebas de lógica de TalkRegistry en una EVM local (@ethereumjs/vm).
//
// El destino real es pallet-revive (PolkaVM, compilado con resolc). Esto solo
// cubre la lógica del contrato: duplicados, validaciones, getters y paginado.
// El bytecode PolkaVM se prueba aparte con `npm run simulate` contra el devnet.
import { readFileSync } from 'node:fs';
import { createVM } from '@ethereumjs/vm';
import { createBlock } from '@ethereumjs/block';
import { createAddressFromString, hexToBytes, bytesToHex } from '@ethereumjs/util';
import { encodeFunctionData, decodeFunctionResult, decodeErrorResult } from 'viem';
import assert from 'node:assert/strict';

const abi = JSON.parse(readFileSync(new URL('../out-evm/TalkRegistry.abi', import.meta.url)));
const bin = '0x' + readFileSync(new URL('../out-evm/TalkRegistry.bin', import.meta.url), 'utf8').trim();

const vm = await createVM();
const block = createBlock({ header: { number: 13_620_000n, timestamp: 1_790_000_000n, gasLimit: 30_000_000n } }, { common: vm.common });
const alice = createAddressFromString('0x' + '11'.repeat(20));
const bob = createAddressFromString('0x' + '22'.repeat(20));

const deploy = await vm.evm.runCall({ data: hexToBytes(bin), gasLimit: 10_000_000n, caller: alice, block });
assert.equal(deploy.execResult.exceptionError, undefined, 'deploy');
const to = deploy.createdAddress;

async function call(fn, args, caller = alice) {
  const r = await vm.evm.runCall({ to, caller, data: hexToBytes(encodeFunctionData({ abi, functionName: fn, args })), gasLimit: 5_000_000n, block });
  const ret = bytesToHex(r.execResult.returnValue);
  if (r.execResult.exceptionError) {
    const err = ret !== '0x' ? decodeErrorResult({ abi, data: ret }) : { errorName: String(r.execResult.exceptionError.error) };
    return { reverted: err.errorName, args: err.args };
  }
  return { value: ret === '0x' ? undefined : decodeFunctionResult({ abi, functionName: fn, data: ret }) };
}

const h1 = '0x' + 'ab'.repeat(32);
const h2 = '0x' + 'cd'.repeat(32);
const pub = '0x' + 'd4'.repeat(32);
const sig = '0x' + '5a'.repeat(64);
let passed = 0;
const ok = (name) => { passed++; console.log('  ✓', name); };

console.log('TalkRegistry');

assert.deepEqual((await call('total', [])).value, 0n); ok('empieza vacío');

let r = await call('seal', [h1, pub, sig, 13_619_000, 'bafk2bzacea…', 'Cómo firmar lo que decimos']);
assert.equal(r.reverted, undefined); ok('sella un recibo');

r = await call('get', [h1]);
assert.equal(r.value.pubkey, pub);
assert.equal(r.value.sig, sig);
assert.equal(r.value.anchorBlock, 13_619_000);
assert.equal(r.value.blockNumber, 13_620_000n);
assert.equal(r.value.sealedAt, 1_790_000_000n);
assert.equal(r.value.submitter.toLowerCase(), alice.toString());
assert.equal(r.value.title, 'Cómo firmar lo que decimos'); ok('get devuelve todos los campos, con bloque y hora del sellado');

r = await call('seal', [h1, pub, sig, 1, 'otro', 'otro'], bob);
assert.equal(r.reverted, 'AlreadySealed');
assert.equal((await call('get', [h1])).value.submitter.toLowerCase(), alice.toString()); ok('no se sobrescribe: el primero gana');

r = await call('get', [h2]);
assert.equal(r.value.submitter, '0x0000000000000000000000000000000000000000'); ok('huella desconocida: submitter en cero');

assert.equal((await call('seal', [h2, pub, '0x' + '00'.repeat(63), 1, 'c', 't'])).reverted, 'BadSignatureLength'); ok('rechaza firmas que no son de 64 bytes');
assert.equal((await call('seal', ['0x' + '00'.repeat(32), pub, sig, 1, 'c', 't'])).reverted, 'EmptyHash'); ok('rechaza huella vacía');
assert.equal((await call('seal', [h2, pub, sig, 1, 'x'.repeat(101), 't'])).reverted, 'FieldTooLong'); ok('limita el CID a 100 bytes');
assert.equal((await call('seal', [h2, pub, sig, 1, 'c', 'x'.repeat(201)])).reverted, 'FieldTooLong'); ok('limita el título a 200 bytes');

assert.equal((await call('seal', [h2, pub, sig, 7, 'c2', 't2'], bob)).reverted, undefined);
assert.equal((await call('total', [])).value, 2n);
assert.deepEqual((await call('page', [0n, 10n])).value, [h1, h2]);
assert.deepEqual((await call('page', [1n, 10n])).value, [h2]);
assert.deepEqual((await call('page', [5n, 10n])).value, []); ok('total y page listan en orden de sellado');

console.log(`\n${passed} pruebas pasaron`);
