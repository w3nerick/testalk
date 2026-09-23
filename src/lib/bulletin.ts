/**
 * Subida y lectura del artefacto en Bulletin.
 *
 * Orden verificado en doomarcade00.dot: BulletinAllowance primero, luego el
 * permiso PreimageSubmit (no ChainSubmit), luego pm.submit(). Sin el permiso
 * correcto la llamada no falla: simplemente no hace nada.
 *
 * Bulletin borra a los 14 días y solo el host resuelve el preimage.
 */
import {
  getPreimageManager,
  isInsideContainerSync,
  requestPermission,
  requestResourceAllocation,
  type HostSubscription,
} from '@parity/product-sdk-host';
import { waitForHost, withTimeout, describeError, TIMED_OUT, HOST_QUERY_MS, HOST_SUBMIT_MS } from './host';

let access: Promise<void> | null = null;

function ensureAccess(): Promise<void> {
  access ??= (async () => {
    if (!(await waitForHost())) throw new Error('Sin canal con el host.');
    const alloc = await withTimeout(requestResourceAllocation([{ tag: 'BulletinAllowance', value: undefined }]), HOST_SUBMIT_MS);
    if (alloc === TIMED_OUT) throw new Error('El host no respondió a la cuota de Bulletin.');
    if (!alloc.ok) throw new Error(`Cuota de Bulletin: ${describeError(alloc.error)}`);
    if (alloc.value[0] !== 'Allocated') throw new Error(`Cuota de Bulletin: ${alloc.value[0]}`);
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

export async function uploadArtifact(bytes: Uint8Array): Promise<void> {
  await ensureAccess();
  const pm = await withTimeout(getPreimageManager(), HOST_QUERY_MS);
  if (pm === TIMED_OUT || !pm) throw new Error('Bulletin no está disponible en este host.');
  const r = await withTimeout(pm.submit(bytes), HOST_SUBMIT_MS);
  if (r === TIMED_OUT) throw new Error('Bulletin no confirmó la subida.');
}

export async function fetchPreimage(key: `0x${string}`, ms = HOST_QUERY_MS): Promise<Uint8Array | null> {
  if (!(await waitForHost())) throw new Error('Abre este enlace desde Polkadot App para leer el recibo.');
  const pm = await withTimeout(getPreimageManager(), HOST_QUERY_MS);
  if (pm === TIMED_OUT || !pm) throw new Error('Bulletin no está disponible en este host.');
  return new Promise(resolve => {
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
    sub = pm.lookup(key, p => finish(p ?? null));
    // El callback puede llegar síncrono, antes de que `sub` exista.
    if (done) { try { sub.unsubscribe(); } catch { /* ya cerrada */ } }
  });
}
