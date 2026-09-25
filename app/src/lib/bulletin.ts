/**
 * Subida y lectura del recibo en Bulletin.
 *
 * Orden: BulletinAllowance, permiso PreimageSubmit (no ChainSubmit), submit().
 * Sin el permiso correcto la llamada no falla: simplemente no hace nada.
 *
 * Medido por TWR.DOT en Polkadot Desktop 0.1.1: la cuota responde
 * `NotAvailable` y aun así la subida funciona, en ~64 s. Por eso `NotAvailable`
 * es un aviso, no un error. En Android la subida falla con un error de codec:
 * sellar desde Desktop.
 *
 * Bulletin borra a los 14 días.
 */
import {
  getPreimageManager,
  isInsideContainerSync,
  requestPermission,
  requestResourceAllocation,
  type HostSubscription,
} from '@parity/product-sdk-host';
import { waitForHost, withTimeout, describeError, TIMED_OUT, HOST_QUERY_MS, HOST_SUBMIT_MS, HOST_UPLOAD_MS } from './host';
import { IPFS_GATEWAY } from './network';
import { blake256Hex } from './artifact';

let access: Promise<void> | null = null;

/**
 * Pide cuota y permiso. Llamarlo al empezar la charla, no al sellar: así el
 * diálogo aparece con el gesto de "Empezar" y el sellado no espera por él.
 */
export function prepareBulletin(): Promise<void> {
  access ??= (async () => {
    if (!(await waitForHost())) throw new Error('Sin canal con el host.');
    const alloc = await withTimeout(requestResourceAllocation([{ tag: 'BulletinAllowance', value: undefined }]), HOST_SUBMIT_MS);
    if (alloc === TIMED_OUT) throw new Error('El host no respondió a la cuota de Bulletin.');
    if (!alloc.ok) throw new Error(`Cuota de Bulletin: ${describeError(alloc.error)}`);
    if (alloc.value[0] === 'Rejected') throw new Error('Rechazaste la cuota de Bulletin.');
    if (alloc.value[0] !== 'Allocated') console.warn('[bulletin] cuota:', alloc.value[0], '(se intenta subir igual)');
    const perm = await withTimeout(requestPermission({ tag: 'PreimageSubmit', value: undefined }), HOST_SUBMIT_MS);
    if (perm === TIMED_OUT) throw new Error('El host no respondió al permiso de subida.');
    if (!perm.ok || !perm.value) throw new Error('Permiso de subida denegado.');
  })();
  access.catch(() => { access = null; });
  return access;
}

export function canUseBulletin(): boolean {
  return isInsideContainerSync();
}

/**
 * Sube el recibo y comprueba que la clave que devuelve el host sea el
 * blake2b-256 de los bytes: es lo que va dentro del CID del QR. Si no
 * coincidiera, el QR apuntaría a nada y nadie se enteraría.
 *
 * `checkFirst`: en un reintento, la subida anterior pudo terminar después del
 * tope; se busca primero para no subir dos veces.
 */
export async function uploadArtifact(bytes: Uint8Array, opts: { checkFirst?: boolean } = {}): Promise<`0x${string}`> {
  const expected = blake256Hex(bytes).toLowerCase() as `0x${string}`;
  await prepareBulletin();
  if (opts.checkFirst && (await lookupViaHost(expected, 10_000))) return expected;
  const pm = await withTimeout(getPreimageManager(), HOST_QUERY_MS);
  if (pm === TIMED_OUT || !pm) throw new Error('Bulletin no está disponible en este host.');
  const r = await withTimeout(pm.submit(bytes), HOST_UPLOAD_MS);
  if (r === TIMED_OUT) throw new Error(`Bulletin no confirmó la subida en ${HOST_UPLOAD_MS / 1000} s. Puede terminar sola: Reintentar revisa primero.`);
  if (typeof r === 'string' && r.toLowerCase() !== expected) {
    throw new Error(`Bulletin guardó el recibo con otra clave (${r.slice(0, 12)}…, esperada ${expected.slice(0, 12)}…): el QR no lo encontraría.`);
  }
  return expected;
}

/**
 * El host entrega el preimage por una suscripción que reporta `null` hasta
 * encontrarlo (TWR.DOT/chirp). Se ignoran los null y se espera hasta el tope.
 */
export function lookupViaHost(key: `0x${string}`, ms: number): Promise<Uint8Array | null> {
  return new Promise(async resolve => {
    const pm = await withTimeout(getPreimageManager(), HOST_QUERY_MS).catch(() => null);
    if (!pm || pm === TIMED_OUT) return resolve(null);
    let done = false;
    let sub: HostSubscription | undefined;
    const finish = (v: Uint8Array | null) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      try { sub?.unsubscribe(); } catch { /* ya cerrada */ }
      resolve(v);
    };
    const t = setTimeout(() => finish(null), ms);
    try {
      sub = pm.lookup(key, p => { if (p) finish(p); });
      // El callback puede llegar síncrono, antes de que `sub` exista.
      if (done) { try { sub.unsubscribe(); } catch { /* ya cerrada */ } }
    } catch {
      finish(null);
    }
  });
}

export async function viaGateway(cid: string): Promise<Uint8Array | null> {
  try {
    const r = await fetch(`${IPFS_GATEWAY}/${cid}`, { signal: AbortSignal.timeout(20_000) });
    return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

/**
 * Lee el recibo: primero por el host, luego por el gateway IPFS del devnet.
 * Fuera del contenedor solo queda el gateway, que puede no servir preimages.
 */
export async function fetchReceipt(cid: string, key: `0x${string}`): Promise<Uint8Array | null> {
  if (isInsideContainerSync() && (await waitForHost())) {
    const b = await lookupViaHost(key, 20_000);
    if (b) return b;
  }
  return viaGateway(cid);
}
