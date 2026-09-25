/**
 * People chain del devnet: de quién es un username.
 *
 * `Resources.UsernameOwnerOf(username)` es la misma consulta que hace
 * `signMessageWithDotNsIdentity` del SDK y la que usaba Proof of Talk. Sirve a
 * los dos lados: el presentador busca la cuenta con la que firmar y el
 * verificador comprueba que el username del recibo sea de la llave que firmó.
 */
import { createClient, type PolkadotClient } from 'polkadot-api';
import { getWsProvider } from 'polkadot-api/ws';
import { getHostProvider, isInsideContainerSync } from '@parity/product-sdk-host';
import { decodeAddress } from '@polkadot/util-crypto';
import { u8aToHex } from '@polkadot/util';
import { waitForHost, withTimeout, TIMED_OUT, HOST_QUERY_MS } from './host';
import { PEOPLE_GENESIS, PEOPLE_WS } from './network';

/**
 * La primera consulta baja la metadata de la cadena. Un endpoint lento tardó
 * 23 s el 25 sep; los rápidos, 3 s. Si uno se vence se reintenta con el siguiente.
 */
const PEOPLE_QUERY_MS = 15_000;

let hostClient: Promise<PolkadotClient> | null = null;
let publicClient: PolkadotClient | null = null;
let rotation = 0;

function viaHost(): Promise<PolkadotClient> {
  hostClient ??= (async () => {
    if (!(await waitForHost())) throw new Error('sin canal con el host');
    const p = await withTimeout(getHostProvider(PEOPLE_GENESIS), HOST_QUERY_MS);
    if (p === TIMED_OUT || !p) throw new Error('el host no entregó People chain');
    return createClient(p);
  })();
  hostClient.catch(() => { hostClient = null; });
  return hostClient;
}

function viaPublic(): PolkadotClient {
  publicClient ??= createClient(getWsProvider([...PEOPLE_WS.slice(rotation), ...PEOPLE_WS.slice(0, rotation)]));
  return publicClient;
}

/** Consulta por RPC público; si se vence, un intento más empezando por el siguiente endpoint. */
async function ownerViaPublic(username: string): Promise<string | null> {
  try {
    return await ownerVia(viaPublic(), username);
  } catch {
    try { publicClient?.destroy(); } catch { /* ya cerrado */ }
    publicClient = null;
    rotation = (rotation + 1) % PEOPLE_WS.length;
    return ownerVia(viaPublic(), username);
  }
}

async function ownerVia(client: PolkadotClient, username: string): Promise<string | null> {
  // polkadot-api 2.2: la clave `Vec<u8>` va como Uint8Array y el AccountId vuelve en SS58.
  const q = client.getUnsafeApi().query.Resources.UsernameOwnerOf.getValue(new TextEncoder().encode(username)) as Promise<string | undefined>;
  const r = await withTimeout(q, PEOPLE_QUERY_MS);
  if (r === TIMED_OUT) throw new Error('People chain no respondió');
  return r ? u8aToHex(decodeAddress(r)) : null;
}

/**
 * Llave pública (hex) dueña de `username`, o `null` si el username no existe.
 * Lanza si no se pudo consultar: eso es "sin comprobar", no "falso".
 */
export async function usernameOwner(username: string): Promise<string | null> {
  if (!isInsideContainerSync()) return ownerViaPublic(username);
  try {
    return await ownerVia(await viaHost(), username);
  } catch {
    // El host puede no servir People chain: RPC público (permiso Remote pedido al arrancar).
    return ownerViaPublic(username);
  }
}
