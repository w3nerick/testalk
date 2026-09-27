/**
 * Lectura de TalkRegistry (pallet-revive) sin firmar: una simulación de
 * `get(huella)` con la runtime API ReviveApi.call. Funciona igual con el
 * provider del host o con un WebSocket público.
 */
import { Binary, type PolkadotClient } from 'polkadot-api';
import { decodeErrorResult, decodeFunctionResult, encodeFunctionData, type Abi } from 'viem';
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

/** Saldo mínimo para sellar: depósito (~0.019 PAS) más comisión, con margen. */
export const MIN_SEAL_BALANCE = 500_000_000n;

export const pas = (planck: bigint) => `${(Number(planck) / 1e10).toFixed(4)} PAS`;

/** Saldo libre de una cuenta en Asset Hub, en planck. */
export async function freeBalance(client: PolkadotClient, ss58: string): Promise<bigint> {
  const acc = (await client.getUnsafeApi().query.System.Account.getValue(ss58)) as { data?: { free?: bigint } } | undefined;
  return BigInt(acc?.data?.free ?? 0n);
}

/**
 * pallet-revive solo acepta llamadas de cuentas mapeadas a su dirección H160
 * (`Revive.map_account`, una transacción, una sola vez). La dirección la da el
 * propio runtime: para cuentas nativas es un keccak, para las derivadas de
 * Ethereum no (TWR.DOT/chirp se equivocó justo ahí).
 */
export async function isMapped(client: PolkadotClient, ss58: string): Promise<boolean> {
  const api = client.getUnsafeApi();
  const h160 = (await api.apis.ReviveApi.address(ss58)) as string | Uint8Array;
  const key = typeof h160 === 'string' ? h160 : Binary.toHex(h160);
  return (await api.query.Revive.OriginalAccount.getValue(key)) != null;
}

export interface SealArgs {
  receiptHash: `0x${string}`;
  pubkey: `0x${string}`;
  sig: `0x${string}`;
  anchorBlock: number;
  cid: string;
  title: string;
}

export const sealCallData = (a: SealArgs) =>
  encodeFunctionData({ abi, functionName: 'seal', args: [a.receiptHash, a.pubkey, a.sig, a.anchorBlock, a.cid, a.title.slice(0, 200)] });

export type SealSimulation =
  | { ok: true; weight: { ref_time: bigint; proof_size: bigint }; deposit: bigint }
  | { ok: false; why: string };

/** Simula `seal()` desde `origin`, sin firmar ni gastar: dice si pasaría y cuánto pide. */
export async function simulateSeal(client: PolkadotClient, origin: string, a: SealArgs): Promise<SealSimulation> {
  const api = client.getUnsafeApi();
  const r = (await api.apis.ReviveApi.call(origin, REGISTRY_ADDRESS, 0n, undefined, undefined, Binary.fromHex(sealCallData(a)))) as {
    weight_required: { ref_time: bigint; proof_size: bigint };
    storage_deposit?: { type: string; value: bigint };
    result?: { success: boolean; value: unknown };
  };
  const res = r?.result;
  if (!res?.success) return { ok: false, why: describeDispatch(res?.value) };
  const v = res.value as { flags: number; data: Uint8Array | string };
  if (v.flags) {
    const data = (typeof v.data === 'string' ? v.data : Binary.toHex(v.data)) as `0x${string}`;
    try {
      const e = decodeErrorResult({ abi, data });
      return { ok: false, why: `el contrato rechazó: ${e.errorName}` };
    } catch {
      return { ok: false, why: `el contrato rechazó (${data.slice(0, 18)}…)` };
    }
  }
  return {
    ok: true,
    weight: r.weight_required,
    deposit: r.storage_deposit?.type === 'Charge' ? BigInt(r.storage_deposit.value) : 0n,
  };
}

const DISPATCH_ES: Record<string, string> = {
  'Revive.AccountUnmapped': 'la cuenta no está mapeada en pallet-revive (falta Revive.map_account)',
  'Revive.StorageDepositNotEnoughFunds': 'el saldo no alcanza para el depósito del sello',
  'Revive.OutOfGas': 'se quedó sin peso (OutOfGas)',
};

/** Un DispatchError de la api sin descriptors, en palabras. */
function describeDispatch(e: unknown): string {
  const m = e as { type?: string; value?: { type?: string; value?: { type?: string } } } | undefined;
  if (m?.type === 'Module' && m.value?.type) {
    const name = `${m.value.type}.${m.value.value?.type ?? '?'}`;
    return DISPATCH_ES[name] ? `${DISPATCH_ES[name]} (${name})` : name;
  }
  return m?.type ?? 'la simulación falló';
}
