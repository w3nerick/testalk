import { isInsideContainerSync, subscribeConnectionStatus } from '@parity/product-sdk-host';

/** TWR.DOT usa 12s para abrir el canal y 8s para las consultas. */
export const HOST_CONNECT_MS = 12000;
export const HOST_QUERY_MS = 8000;
/** Firmas y diálogos del wallet: la persona tiene que ir al celular y aprobar. */
export const HOST_SUBMIT_MS = 90000;
/**
 * Subir a Bulletin espera inclusión en bloque. TWR.DOT midió 64 s para 37 bytes
 * en Polkadot Desktop 0.1.1; un recibo de 15 minutos pesa unos 30 KB.
 */
export const HOST_UPLOAD_MS = 180000;

export const TIMED_OUT = Symbol('timed_out');

/**
 * Toda llamada al host necesita un tope.
 *
 * Una promesa encolada en un canal trabado no rechaza: se queda pendiente para
 * siempre, y un try/catch no la salva. Es lo que dejaba el botón en
 * "Registrando..." sin error ni firma.
 */
export function withTimeout<T>(p: Promise<T>, ms: number = HOST_QUERY_MS): Promise<T | typeof TIMED_OUT> {
  return Promise.race([
    p,
    new Promise<typeof TIMED_OUT>(resolve => setTimeout(() => resolve(TIMED_OUT), ms)),
  ]);
}

/**
 * Espera a que el canal con el host esté realmente establecido.
 *
 * `isInsideContainerSync()` es solo una heurística (iframe / webview / message
 * port): dice que estamos dentro, no que el canal funcione. Llamar mientras el
 * estado sigue en "connecting" deja la llamada encolada y nunca resuelve.
 *
 * Además, suscribirse NO es pasivo: según la doc del SDK, el primer subscribe
 * fuera de un canal establecido es lo que construye el cliente y el provider.
 * O sea que esto no solo espera — también dispara la conexión.
 */
export function waitForHost(ms: number = HOST_CONNECT_MS): Promise<boolean> {
  if (!isInsideContainerSync()) return Promise.resolve(false);

  return new Promise<boolean>(resolve => {
    let unsub: (() => void) | undefined;
    let settled = false;

    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { unsub?.(); } catch { /* ya desuscrito */ }
      resolve(ok);
    };

    const timer = setTimeout(() => finish(false), ms);

    try {
      // El callback puede dispararse de forma síncrona con el estado actual,
      // antes de que `unsub` exista; por eso se limpia también abajo.
      unsub = subscribeConnectionStatus(status => {
        if (status === 'connected') finish(true);
      });
      if (settled) { try { unsub(); } catch { /* ya desuscrito */ } }
    } catch {
      finish(false);
    }
  });
}

/** Los errores del host son uniones etiquetadas; extrae algo legible. */
export function describeError(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object') {
    const tag = (e as { tag?: unknown }).tag;
    const value = (e as { value?: unknown }).value;
    const reason = value && typeof value === 'object' ? (value as { reason?: unknown }).reason : undefined;
    if (typeof tag === 'string') return reason ? `${tag}: ${String(reason)}` : tag;
    try { return JSON.stringify(e); } catch { /* sigue abajo */ }
  }
  return String(e);
}
