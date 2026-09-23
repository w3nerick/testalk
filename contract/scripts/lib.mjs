// Utilidades compartidas por deploy, anchor y check.
//
// Todo va contra pallet-revive del Asset Hub del Products Devnet, con
// polkadot-api sin descriptors (getUnsafeApi): solo se necesitan un par de
// extrínsecos y runtime APIs que se leen de la metadata de la propia cadena.
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, Binary, AccountId } from 'polkadot-api';
import { getWsProvider } from 'polkadot-api/ws';
import { encodeFunctionData, decodeFunctionResult, decodeErrorResult } from 'viem';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const RPC = ['wss://asset-hub-paseo-rpc.n.dwellir.com', 'wss://sys.turboflakes.io/asset-hub-paseo'];
export const GENESIS = '0xd6eec26135305a8ad257a20d003357284c8aa03d0bdb2b357ab0a22371e11ef2';
export const PVM = resolve(HERE, '../out/TalkRegistry.sol:TalkRegistry.pvm');
export const ABI = JSON.parse(readFileSync(resolve(HERE, '../out-evm/TalkRegistry.abi'), 'utf8'));
export const DEPLOYMENTS = resolve(HERE, '../deployments.json');

/**
 * Cuenta de desarrollo pública con fondos en el devnet. Solo se usa como
 * `origin` de simulaciones (dry-run): no firma nada, su llave es conocida por
 * todos y por eso jamás debe desplegar ni sellar.
 */
export const SIM_ORIGIN = '5DfhGyQdFobKM8NsWvEeAKk5EQQgYe9AydgJ7rMB6E1EqRzV';

// Techos medidos: por encima de ~900G el extrínseco vuelve como InvalidTxError.
export const WEIGHT_CAP = { ref_time: 900_000_000_000n, proof_size: 3_000_000n };

export function connect() {
  const client = createClient(getWsProvider(RPC));
  return { client, api: client.getUnsafeApi() };
}

export function registryAddress() {
  if (!existsSync(DEPLOYMENTS)) return null;
  return JSON.parse(readFileSync(DEPLOYMENTS, 'utf8')).devnet?.address ?? null;
}

// En polkadot-api 2.2 los Vec<u8> llegan como Uint8Array y los [u8; N] como texto hex.
export const hex = v =>
  typeof v === 'string' ? v : v instanceof Uint8Array ? '0x' + Buffer.from(v).toString('hex') : v?.asHex ? v.asHex() : null;
export const pas = planck => `${(Number(planck) / 1e10).toFixed(4)} PAS`;

export function encode(functionName, args) {
  return encodeFunctionData({ abi: ABI, functionName, args });
}

export function decodeResult(functionName, data) {
  return decodeFunctionResult({ abi: ABI, functionName, data });
}

export function decodeRevert(data) {
  try {
    const e = decodeErrorResult({ abi: ABI, data });
    return `${e.errorName}(${(e.args ?? []).join(', ')})`;
  } catch {
    return data;
  }
}

/** Simula la instanciación con el bytecode PolkaVM real, sin firmar. */
export async function simulateInstantiate(api, origin = SIM_ORIGIN) {
  const code = readFileSync(PVM);
  const r = await api.apis.ReviveApi.instantiate(
    origin, 0n, undefined, undefined,
    { type: 'Upload', value: Binary.fromHex('0x' + code.toString('hex')) },
    Binary.fromHex('0x'), undefined,
  );
  return { code, r };
}

/** Simula una llamada al contrato (dry-run). Sirve para leer y para probar escrituras. */
export async function simulateCall(api, dest, data, origin = SIM_ORIGIN) {
  // `dest` es [u8; 20]: en papi 2.2 va como texto hex, no como Binary.
  return api.apis.ReviveApi.call(origin, dest, 0n, undefined, undefined, Binary.fromHex(data));
}

/** Lee `get(hash)` sin firmar. Devuelve null si el recibo no está sellado. */
export async function readSeal(api, dest, receiptHash) {
  const r = await simulateCall(api, dest, encode('get', [receiptHash]));
  const ok = r.result?.success ? r.result.value : null;
  if (!ok || ok.flags) throw new Error('la lectura del contrato falló');
  const seal = decodeResult('get', hex(ok.data));
  return /^0x0{40}$/i.test(seal.submitter) ? null : seal;
}

/** Pide la frase semilla sin eco y sin pasar por el historial del shell. */
export async function promptSecret(question) {
  const { createInterface } = await import('node:readline');
  const output = process.stdout;
  return new Promise(res => {
    const rl = createInterface({ input: process.stdin, output, terminal: true });
    let muted = false;
    const write = output.write.bind(output);
    output.write = (chunk, ...rest) => (muted ? true : write(chunk, ...rest));
    rl.question(question, answer => {
      output.write = write;
      output.write('\n');
      rl.close();
      res(answer);
    });
    muted = true;
  });
}

export async function loadSigner() {
  const { sr25519CreateDerive } = await import('@polkadot-labs/hdkd');
  const { entropyToMiniSecret, mnemonicToEntropy } = await import('@polkadot-labs/hdkd-helpers');
  const { getPolkadotSigner } = await import('polkadot-api/signer');
  if (!process.stdin.isTTY) throw new Error('Se necesita una terminal interactiva para pedir la frase semilla.');
  console.log('Pega o escribe tu frase semilla y pulsa Enter. No se mostrará nada mientras escribes.\n');
  const mnemonic = (await promptSecret('Frase semilla: ')).trim();
  const words = mnemonic.split(/\s+/).filter(Boolean).length;
  if (words < 12) throw new Error(`Llegaron ${words} palabras; se esperan 12 o 24.`);
  const pair = sr25519CreateDerive(entropyToMiniSecret(mnemonicToEntropy(mnemonic)))('');
  return {
    address: AccountId().dec(pair.publicKey),
    signer: getPolkadotSigner(pair.publicKey, 'Sr25519', pair.sign),
  };
}
