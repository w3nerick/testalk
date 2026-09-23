/**
 * Conexión a Asset Hub del Products Devnet.
 *
 * Dentro del contenedor (Polkadot App / Desktop) todo pasa por el host con
 * `getHostProvider(genesis)`. Fuera, en un navegador normal (útil para
 * ensayar), se abre un WebSocket público directo.
 */
import { createClient, type PolkadotClient } from 'polkadot-api';
import { getWsProvider } from 'polkadot-api/ws';
import { getHostProvider, isInsideContainerSync } from '@parity/product-sdk-host';
import { waitForHost, withTimeout, TIMED_OUT, HOST_QUERY_MS } from './host';
import { ASSET_HUB_GENESIS, PUBLIC_WS } from './network';

export { ASSET_HUB_GENESIS, NETWORK } from './network';

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

let publicClient: PolkadotClient | null = null;

export async function hashVia(client: PolkadotClient, n: number): Promise<string | null> {
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

/**
 * Hash canónico de un bloque por altura. Devuelve null si nadie responde: eso
 * es "no verificable", no "falso".
 *
 * El provider del host es un cliente ligero y puede no servir consultas
 * históricas; en ese caso se pregunta a un RPC público (permiso Remote pedido
 * al arrancar, ver permissions.ts).
 */
export async function hashAtHeight(n: number): Promise<string | null> {
  const h = await hashVia(await getClient(), n).catch(() => null);
  if (h || !isInsideContainerSync()) return h;
  publicClient ??= createClient(getWsProvider(PUBLIC_WS));
  return hashVia(publicClient, n);
}
