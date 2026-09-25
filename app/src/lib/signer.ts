/**
 * Quién firma la charla.
 *
 * Dentro del contenedor hay dos llaves posibles:
 *
 * - **identity**: la cuenta dueña del username en People chain. Es la que ata
 *   el recibo a una persona: el verificador consulta el mismo registro. Se firma
 *   con `getLegacyAccountSigner(...).signBytes`, igual que Proof of Talk y que
 *   `signMessageWithDotNsIdentity` del SDK.
 * - **app**: la cuenta de producto que el host deriva para este dominio.
 *   `SignerManager` solo entrega esta ("the host exposes only per-dapp product
 *   accounts and never the user's identity account"). Firma, pero nadie puede
 *   ligarla a un username. Queda de respaldo si el host no firma con identidad.
 *
 * Fuera del contenedor: cuenta de desarrollo (Alice), para ensayar el flujo en
 * un navegador normal; el recibo sale marcado como ensayo.
 */
import { getAccountsProvider, isInsideContainerSync } from '@parity/product-sdk-host';
import type { SignerManager as SM } from '@parity/product-sdk-signer';
import type { PolkadotSigner } from 'polkadot-api';
import { hexToU8a, u8aToHex } from '@polkadot/util';
import { encodeAddress } from '@polkadot/util-crypto';
import { waitForHost, withTimeout, describeError, TIMED_OUT, HOST_QUERY_MS, HOST_SUBMIT_MS } from './host';
import { APP_DOTNS } from './network';
import { usernameOwner } from './people';

export type SignerKind = 'identity' | 'app' | 'rehearsal';

export interface Speaker {
  /** SS58 de la llave que va a firmar. */
  address: string;
  pubkey: string;
  /** Username del host. Solo queda comprobado si `kind` es `identity`. */
  username: string | null;
  kind: SignerKind;
  rehearsal: boolean;
}

interface Key {
  address: string;
  pubkey: string;
}

let manager: SM | null = null;
let appKey: Key | null = null;
let identity: (Key & { signer: PolkadotSigner }) | null = null;
let username: string | null = null;
let identityNote: string | null = null;
let speaker: Speaker | null = null;

export function currentSpeaker(): Speaker | null {
  return speaker;
}

/** Por qué no se firma con la identidad, para explicarlo en pantalla. */
export function identityUnavailableReason(): string | null {
  return identityNote;
}

export function hasIdentitySigner(): boolean {
  return identity !== null;
}

/** Abre un diálogo: llamar solo desde un gesto del usuario. */
export async function connectSpeaker(): Promise<Speaker> {
  const inside = isInsideContainerSync();
  if (inside && !(await waitForHost())) throw new Error(`No hay canal con Polkadot App. Abre ${APP_DOTNS} desde la app.`);

  const { SignerManager } = await import('@parity/product-sdk-signer');
  manager ??= new SignerManager({ dappName: APP_DOTNS });

  // Además de la cuenta de la app, connect() pide el permiso ChainSubmit: sin él
  // una petición de firma se queda colgada sin levantar la hoja del wallet.
  const r = await withTimeout(manager.connect(inside ? 'host' : 'dev'), HOST_SUBMIT_MS);
  if (r === TIMED_OUT) throw new Error('El wallet no respondió a tiempo.');
  if (!r.ok) throw new Error(describeError(r.error));
  const acc = r.value[0];
  if (!acc) {
    // En *.dev-dot.li el web shell no deriva cuentas de producto (TWR.DOT, DEVFEEDBACK #18).
    throw new Error(inside ? 'El host no entregó ninguna cuenta. Presenta desde Polkadot Desktop: en el navegador (dev-dot.li) no se puede firmar.' : 'No hay cuenta de ensayo.');
  }
  manager.selectAccount(acc.address);
  appKey = { address: acc.address, pubkey: u8aToHex(acc.publicKey) };

  if (!inside) {
    speaker = { ...appKey, username: null, kind: 'rehearsal', rehearsal: true };
    return speaker;
  }

  const u = await withTimeout(manager.getUserId(), HOST_QUERY_MS).catch(() => null);
  username = u && u !== TIMED_OUT && u.ok ? u.value.primaryUsername || null : null;
  identity = null;
  identityNote = null;
  if (!username) {
    identityNote = 'tu cuenta no tiene username';
  } else {
    try {
      const owner = await usernameOwner(username);
      if (!owner) {
        identityNote = `${username} no aparece en People chain`;
      } else {
        const ap = await withTimeout(getAccountsProvider(), HOST_QUERY_MS);
        if (ap === TIMED_OUT || !ap) {
          identityNote = 'el host no entregó el proveedor de cuentas';
        } else {
          const publicKey = hexToU8a(owner);
          identity = {
            address: encodeAddress(publicKey, 42),
            pubkey: owner,
            signer: ap.getLegacyAccountSigner({ publicKey, name: username }),
          };
        }
      }
    } catch (e) {
      identityNote = `no se pudo consultar People chain (${(e as Error).message})`;
    }
  }

  speaker = identity
    ? { address: identity.address, pubkey: identity.pubkey, username, kind: 'identity', rehearsal: false }
    : { ...appKey, username, kind: 'app', rehearsal: false };
  return speaker;
}

/** Respaldo: firmar con la cuenta de la app si el host no firma con identidad. */
export function useAppAccount(): Speaker {
  if (!appKey) throw new Error('Conecta tu wallet primero.');
  identityNote ??= 'se eligió la cuenta de la app';
  speaker = { ...appKey, username, kind: 'app', rehearsal: false };
  return speaker;
}

/** Firma con la llave indicada (por defecto, la del speaker actual). Devuelve hex. */
export async function signBytes(bytes: Uint8Array, kind: SignerKind | undefined = speaker?.kind): Promise<string> {
  if (!manager || !speaker || !kind) throw new Error('Conecta tu wallet antes de sellar.');
  if (kind === 'identity') {
    if (!identity) throw new Error(identityNote ? `Sin firma con identidad: ${identityNote}.` : 'Sin firma con identidad.');
    let sig: Uint8Array | typeof TIMED_OUT;
    try {
      sig = await withTimeout(identity.signer.signBytes(bytes), HOST_SUBMIT_MS);
    } catch (e) {
      throw new Error(`Firma con identidad rechazada: ${describeError(e instanceof Error ? e.message : e)}`);
    }
    if (sig === TIMED_OUT) throw new Error('La firma con tu identidad no llegó a tiempo. Revisa el celular.');
    return u8aToHex(sig);
  }
  const r = await withTimeout(manager.signRaw(bytes), HOST_SUBMIT_MS);
  if (r === TIMED_OUT) throw new Error('La firma no llegó a tiempo. Revisa el celular.');
  if (!r.ok) throw new Error(`Firma rechazada: ${describeError(r.error)}`);
  return u8aToHex(r.value);
}

/** Llave (hex) con la que firma cada camino, para comprobar firmas en el diagnóstico. */
export function keyFor(kind: SignerKind): string | null {
  if (kind === 'identity') return identity?.pubkey ?? null;
  return appKey?.pubkey ?? null;
}
