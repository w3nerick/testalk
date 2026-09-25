/**
 * Permisos que la app pide una sola vez, al arrancar.
 *
 * En el contenedor la red está detrás de permisos: un fetch o WebSocket hacia
 * un dominio no aprobado falla en silencio (TWR.DOT, docs/devnet-issues.md).
 * Pedirlos a mitad de un gesto ya es tarde. Fuera del contenedor no hace nada.
 *
 * `localhost` (el transcriptor) y los dominios de Whisper solo los piden el
 * presentador y el diagnóstico: quien abre un QR para verificar no tiene por
 * qué ver esa petición.
 */
import { isInsideContainerSync, requestDevicePermission, requestPermission } from '@parity/product-sdk-host';
import { waitForHost } from './host';
import { IPFS_GATEWAY, PEOPLE_WS, PUBLIC_WS } from './network';

const host = (u: string) => new URL(u).hostname;
/** Gateway IPFS, RPC públicos de Asset Hub y de People chain: respaldos de lectura. */
const BASE = [host(IPFS_GATEWAY), ...PUBLIC_WS.map(host), ...PEOPLE_WS.map(host)];

/** Whisper en la app: modelo de Hugging Face (y su CDN) y el motor ONNX de jsDelivr. */
const WHISPER = ['huggingface.co', 'us.aws.cdn.hf.co', 'cas-bridge.xethub.hf.co', 'cdn-lfs.hf.co', 'cdn.jsdelivr.net'];

export function remoteDomains(presenter: boolean): string[] {
  return presenter ? ['localhost', ...BASE, ...WHISPER] : BASE;
}

const asked = new Map<boolean, Promise<void>>();

/** `presenter`: además `localhost` (transcriptor de Python) y los dominios de Whisper en la app. */
export function requestHostPermissions(opts: { presenter?: boolean } = {}): Promise<void> {
  const localhost = opts.presenter ?? false;
  let p = asked.get(localhost);
  if (!p) {
    p = (async () => {
      if (!isInsideContainerSync() || !(await waitForHost())) return;
      // Acotado: el arranque no puede ser una de las cosas que esperan a un canal trabado.
      await Promise.race([
        Promise.all([
          requestPermission({ tag: 'Remote', value: { domains: remoteDomains(localhost) } }).catch(() => undefined),
          requestDevicePermission('Clipboard').catch(() => undefined),
        ]),
        new Promise(r => setTimeout(r, 4000)),
      ]);
    })().catch(() => undefined);
    asked.set(localhost, p);
  }
  return p;
}
