import './style.css';
import { renderHome } from './views/home';
import { renderPresenter } from './views/presenter';
import { isCid, renderVerifier } from './views/verifier';
import type { Cleanup } from './ui';

const root = document.getElementById('app')!;
let cleanup: Cleanup | undefined;

/**
 * Rutas por hash: la app se sirve desde un content hash y rutas profundas sin
 * fallback darían 404. `#/<cid>` es el mismo formato que usa proofoftalk.dot.
 */
function route() {
  cleanup?.();
  window.scrollTo(0, 0);
  const path = location.hash.replace(/^#\/?/, '').split('?')[0];
  if (path === 'presentar') cleanup = renderPresenter(root);
  else if (path === 'verificar') cleanup = renderVerifier(root);
  else if (isCid(path)) cleanup = renderVerifier(root, path);
  else cleanup = renderHome(root);
}

window.addEventListener('hashchange', route);
route();
