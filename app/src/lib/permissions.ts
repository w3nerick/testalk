/**
 * Permisos que la app pide una sola vez, al arrancar.
 *
 * En el contenedor la red está detrás de permisos: un fetch o WebSocket hacia
 * un dominio no aprobado falla en silencio (TWR.DOT, docs/devnet-issues.md).
 * Eso incluye el transcriptor en localhost, el gateway IPFS y los RPC públicos
 * que sirven de respaldo.
 * Pedirlos a mitad de un gesto ya es tarde. Fuera del contenedor no hace nada.
 */
import { isInsideContainerSync, requestDevicePermission, requestPermission } from '@parity/product-sdk-host';
import { waitForHost } from './host';
import { IPFS_GATEWAY, PUBLIC_WS } from './network';

const DOMAINS = ['localhost', new URL(IPFS_GATEWAY).hostname, ...PUBLIC_WS.map(u => new URL(u).hostname)];

let asked: Promise<void> | null = null;

export function requestHostPermissions(): Promise<void> {
  asked ??= (async () => {
    if (!isInsideContainerSync() || !(await waitForHost())) return;
    // Acotado: el arranque no puede ser una de las cosas que esperan a un canal trabado.
    await Promise.race([
      Promise.all([
        requestPermission({ tag: 'Remote', value: { domains: DOMAINS } }).catch(() => undefined),
        requestDevicePermission('Clipboard').catch(() => undefined),
      ]),
      new Promise(r => setTimeout(r, 4000)),
    ]);
  })().catch(() => undefined);
  return asked;
}
