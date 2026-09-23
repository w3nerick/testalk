/**
 * Conexión a Asset Hub del Products Devnet.
 *
 * Dentro del contenedor (Polkadot App / Desktop) todo pasa por el host con
 * `getHostProvider(genesis)`. Fuera — el navegador normal, útil para ensayar —
 * se abre un WebSocket público directo.
 *
 * Genesis medido por RPC el 23 sep 2026. Los de Karim (0xf388dc…) eran de la
 * red del Summit y aquí no existen.
 */
import { createClient, type PolkadotClient } from 'polkadot-api';
import { getWsProvider } from 'polkadot-api/ws';
import { getHostProvider, isInsideContainerSync, type HexString } from '@parity/product-sdk-host';
import { waitForHost, withTimeout, TIMED_OUT, HOST_QUERY_MS } from './host';

export const NETWORK = 'products-devnet';
export const ASSET_HUB_GENESIS: HexString =
  '0xd6eec26135305a8ad257a20d003357284c8aa03d0bdb2b357ab0a22371e11ef2';

const PUBLIC_WS = [
  'wss://asset-hub-paseo-rpc.n.dwellir.com',
  'wss://sys.turboflakes.io/asset-hub-paseo',
];

export interface Block {
  number: number;
  hash: string;
}

let clientPromise: Promise<PolkadotClient> | null = null;

export function getClient(): Promise<PolkadotClient> {
  if (!clientPromise) {
    clientPromise = (async () => {
      if (isInsideContainerSync()) {
        if (!(await waitForHost())) throw new Error('host_no_conectado');
        const p = await withTimeout(getHostProvider(ASSET_HUB_GENESIS), HOST_QUERY_MS);
        if (p === TIMED_OUT || !p) throw new Error('el host no entregó Asset Hub del devnet');
        return createClient(p);
      }
      return createClient(getWsProvider(PUBLIC_WS));
    })();
    clientPromise.catch(() => { clientPromise = null; });
  }
  return clientPromise;
}

/**
 * Bloques finalizados, no "best".
 *
 * Karim usa `bestBlocks$`: un bloque best puede quedar huérfano en un reorg y
 * entonces su hash ya no existe en la cadena, así que el verificador lo daría
 * por falso. Finalizado tarda unos segundos más pero nunca se revierte.
 */
export async function subscribeFinalized(
  onBlock: (b: Block) => void,
  onError: (e: unknown) => void,
): Promise<() => void> {
  const client = await getClient();
  const sub = client.finalizedBlock$.subscribe({
    next: b => onBlock({ number: b.number, hash: b.hash }),
    error: onError,
  });
  return () => sub.unsubscribe();
}

/**
 * Hash canónico de un bloque por altura. Prueba el método nuevo (archive) y
 * cae al legacy; algunos providers solo exponen uno de los dos.
 * Devuelve null si ninguno responde: eso es "no verificable", no "falso".
 */
export async function hashAtHeight(n: number): Promise<string | null> {
  const client = await getClient();
  try {
    const r = await withTimeout(client._request<string[] | string | null>('archive_v1_hashByHeight', [n]), HOST_QUERY_MS);
    if (r !== TIMED_OUT) {
      const h = Array.isArray(r) ? r[0] : r;
      if (h) return h;
    }
  } catch { /* sigue con el legacy */ }
  try {
    const r = await withTimeout(client._request<string | null>('chain_getBlockHash', [n]), HOST_QUERY_MS);
    if (r !== TIMED_OUT && r) return r;
  } catch { /* sin método disponible */ }
  return null;
}
