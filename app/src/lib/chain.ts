/**
 * Conexión a Asset Hub del Products Devnet (el Asset Hub de Paseo, genesis
 * 0xd6eec261…).
 *
 * Dentro del contenedor (Polkadot App, Desktop o el gateway dev-dot.li) se
 * pide al host con `getHostProvider(genesis)`. Si el host no la entrega a
 * tiempo, o la entrega pero no llegan bloques, se usa el RPC público: la
 * cadena es la misma y los hashes valen igual. Fuera del contenedor, RPC
 * público directo.
 */
import { createClient, type PolkadotClient } from 'polkadot-api';
import { getWsProvider } from 'polkadot-api/ws';
import { getHostProvider, isInsideContainerSync } from '@parity/product-sdk-host';
import { waitForHost, withTimeout, TIMED_OUT, HOST_CONNECT_MS, HOST_QUERY_MS } from './host';
import { ASSET_HUB_GENESIS, PUBLIC_WS } from './network';

export { ASSET_HUB_GENESIS, NETWORK } from './network';

export interface Block {
  number: number;
  hash: string;
}

let clientPromise: Promise<PolkadotClient> | null = null;
/** Por dónde llegó Asset Hub, para mostrarlo; y por qué no fue el host, si no lo fue. */
let source: 'host' | 'public' | null = null;
let hostProblem: string | null = null;

export function chainSource(): { source: 'host' | 'public' | null; hostProblem: string | null } {
  return { source, hostProblem };
}

async function hostClient(): Promise<PolkadotClient> {
  if (!(await waitForHost())) throw new Error('sin canal con el host');
  // 12 s como TWR.DOT: el cliente ligero del host puede tardar en arrancar.
  const p = await withTimeout(getHostProvider(ASSET_HUB_GENESIS), HOST_CONNECT_MS);
  if (p === TIMED_OUT) throw new Error(`el host no entregó Asset Hub en ${HOST_CONNECT_MS / 1000} s`);
  if (!p) throw new Error('el host no entregó Asset Hub');
  return createClient(p);
}

function publicClientFor(): PolkadotClient {
  source = 'public';
  return createClient(getWsProvider(PUBLIC_WS));
}

export function getClient(): Promise<PolkadotClient> {
  if (!clientPromise) {
    clientPromise = (async () => {
      if (!isInsideContainerSync()) return publicClientFor();
      try {
        const c = await hostClient();
        source = 'host';
        return c;
      } catch (e) {
        // Respaldo: permiso Remote para estos RPC pedido al arrancar (permissions.ts).
        hostProblem = (e as Error).message;
        console.warn('[chain] Asset Hub por RPC público:', hostProblem);
        return publicClientFor();
      }
    })();
    clientPromise.catch(() => { clientPromise = null; });
  }
  return clientPromise;
}

/** Deja el host y pasa al RPC público (el host entregó Asset Hub pero no llegan bloques). */
function switchToPublic(reason: string): Promise<PolkadotClient> {
  hostProblem = reason;
  console.warn('[chain] Asset Hub por RPC público:', reason);
  clientPromise = Promise.resolve(publicClientFor());
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
  let got = false;
  let stopped = false;
  const watch = (client: PolkadotClient) =>
    client.finalizedBlock$.subscribe({
      next: b => { got = true; onBlock({ number: b.number, hash: b.hash }); },
      error: onError,
    });
  let sub = watch(await getClient());
  // Si el host entregó Asset Hub pero en 30 s no llegó ningún bloque, RPC público.
  const watchdog = source === 'host'
    ? setTimeout(() => {
        if (got || stopped) return;
        sub.unsubscribe();
        switchToPublic('el host no entregó bloques en 30 s').then(c => { if (!stopped) sub = watch(c); });
      }, 30_000)
    : undefined;
  return () => {
    stopped = true;
    clearTimeout(watchdog);
    sub.unsubscribe();
  };
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

/**
 * Corre una lectura con el cliente principal y, si falla dentro del
 * contenedor, la repite contra un RPC público.
 */
export async function withReadClient<T>(fn: (c: PolkadotClient) => Promise<T>): Promise<T> {
  try {
    return await fn(await getClient());
  } catch (e) {
    if (!isInsideContainerSync()) throw e;
    publicClient ??= createClient(getWsProvider(PUBLIC_WS));
    return fn(publicClient);
  }
}
