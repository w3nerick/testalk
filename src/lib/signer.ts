/**
 * Quién firma la charla.
 *
 * Dentro del contenedor: SignerManager, el camino que sí abre la hoja de firma
 * en este devnet (ver TWR.DOT/peoplebook). Karim usa getLegacyAccountSigner,
 * que aquí se queda colgado sin levantar nada.
 *
 * Fuera del contenedor: cuenta de desarrollo (Alice). Sirve para ensayar el
 * flujo completo en un navegador normal; el artefacto sale marcado como ensayo.
 */
import { isInsideContainerSync } from '@parity/product-sdk-host';
import type { SignerManager as SM } from '@parity/product-sdk-signer';
import { u8aToHex } from '@polkadot/util';
import { waitForHost, withTimeout, describeError, TIMED_OUT, HOST_QUERY_MS, HOST_SUBMIT_MS } from './host';

export const APP_DOTNS = 'testalk.dot';

export interface Speaker {
  address: string;
  pubkey: string;
  username: string | null;
  rehearsal: boolean;
}

let manager: SM | null = null;
let speaker: Speaker | null = null;

export function currentSpeaker(): Speaker | null {
  return speaker;
}

/** Abre un diálogo: llamar solo desde un gesto del usuario. */
export async function connectSpeaker(): Promise<Speaker> {
  const inside = isInsideContainerSync();
  if (inside && !(await waitForHost())) throw new Error('No hay canal con Polkadot App. Abre testalk.dot desde la app.');

  const { SignerManager } = await import('@parity/product-sdk-signer');
  manager ??= new SignerManager({ dappName: APP_DOTNS });

  const r = await withTimeout(manager.connect(inside ? 'host' : 'dev'), HOST_SUBMIT_MS);
  if (r === TIMED_OUT) throw new Error('El wallet no respondió a tiempo.');
  if (!r.ok) throw new Error(describeError(r.error));
  const acc = r.value[0];
  if (!acc) throw new Error('El wallet no entregó ninguna cuenta.');
  manager.selectAccount(acc.address);

  let username: string | null = null;
  if (inside) {
    const u = await withTimeout(manager.getUserId(), HOST_QUERY_MS).catch(() => null);
    if (u && u !== TIMED_OUT && u.ok) username = u.value.primaryUsername || null;
  }

  speaker = { address: acc.address, pubkey: u8aToHex(acc.publicKey), username, rehearsal: !inside };
  return speaker;
}

export async function signBytes(bytes: Uint8Array): Promise<string> {
  if (!manager || !speaker) throw new Error('Conecta tu wallet antes de sellar.');
  const r = await withTimeout(manager.signRaw(bytes), HOST_SUBMIT_MS);
  if (r === TIMED_OUT) throw new Error('La firma no llegó a tiempo. Revisa el celular.');
  if (!r.ok) throw new Error(`Firma rechazada: ${describeError(r.error)}`);
  return u8aToHex(r.value);
}
