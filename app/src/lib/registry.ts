/**
 * Lectura de TalkRegistry (pallet-revive) sin firmar: una simulación de
 * `get(huella)` con la runtime API ReviveApi.call. Funciona igual con el
 * provider del host o con un WebSocket público.
 */
import { Binary, type PolkadotClient } from 'polkadot-api';
import { decodeFunctionResult, encodeFunctionData, type Abi } from 'viem';
import abiJson from './TalkRegistry.abi.json' with { type: 'json' };
import { REGISTRY_ADDRESS } from './network.ts';

const abi = abiJson as Abi;

/** Cualquier cuenta sirve de origen para una lectura; esta es la pública de desarrollo. */
const READ_ORIGIN = '5DfhGyQdFobKM8NsWvEeAKk5EQQgYe9AydgJ7rMB6E1EqRzV';

export interface OnChainSeal {
  pubkey: string;
  blockNumber: bigint;
  sealedAt: bigint;
  anchorBlock: number;
  submitter: string;
  sig: string;
  cid: string;
  title: string;
}

/** Devuelve el sello, `null` si el recibo no está anclado, o lanza si no se pudo consultar. */
export async function readSeal(client: PolkadotClient, receiptHash: string): Promise<OnChainSeal | null> {
  const api = client.getUnsafeApi();
  const data = encodeFunctionData({ abi, functionName: 'get', args: [receiptHash as `0x${string}`] });
  // `dest` es [u8; 20]: en polkadot-api 2.2 va como texto hex; los Vec<u8> son Uint8Array.
  // La api sin descriptors no tipa el resultado.
  const r = (await api.apis.ReviveApi.call(READ_ORIGIN, REGISTRY_ADDRESS, 0n, undefined, undefined, Binary.fromHex(data))) as {
    result?: { success: boolean; value: { flags: number; data: Uint8Array | string } };
  };
  const v = r?.result?.success ? r.result.value : null;
  if (!v || v.flags) throw new Error('el registro no respondió');
  const out = (typeof v.data === 'string' ? v.data : Binary.toHex(v.data)) as `0x${string}`;
  const seal = decodeFunctionResult({ abi, functionName: 'get', data: out }) as OnChainSeal;
  return /^0x0{40}$/i.test(seal.submitter) ? null : seal;
}
