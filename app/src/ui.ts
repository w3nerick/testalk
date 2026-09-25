import { icon } from './lib/icons';
// La marca sale de scripts/icon.ts (npm run icon), igual que el ícono de la app.
import mark from '../brand/mark.svg?raw';

/** Escapa texto para interpolarlo en HTML. Todo lo que viene del STT o de un artefacto pasa por aquí. */
export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function $(sel: string, root: ParentNode = document): HTMLElement {
  const el = root.querySelector<HTMLElement>(sel);
  if (!el) throw new Error(`falta ${sel}`);
  return el;
}

export function topbar(extra = ''): string {
  const at = location.hash.replace(/^#\/?/, '');
  const link = (path: string, label: string) =>
    `<a href="#/${path}"${at === path ? ' class="active" aria-current="page"' : ''}>${label}</a>`;
  return `
  <header class="topbar">
    <div class="shell topbar-in">
      <a class="brand" href="#/"><span class="brand-mark" aria-hidden="true">${mark}</span>testalk</a>
      <div class="grow">${extra}</div>
      <nav class="nav">${link('presentar', 'Presentar')}${link('verificar', 'Verificar')}</nav>
    </div>
  </header>`;
}

export type Tone = 'ok' | 'bad' | 'warn' | 'wait' | 'idle';

/** Estado en texto de terminal: `[ OK ]`, `[FALLA]`, `[ !! ]`, `[ .. ]`. */
export function tag(tone: Tone): string {
  const label = { ok: ' OK ', bad: 'FALLA', warn: ' !! ', wait: '', idle: ' -- ' }[tone];
  return `<span class="tag ${tone}" aria-hidden="true">[${tone === 'wait' ? '<i class="aspin"></i>' : label}]</span>`;
}

export function shortAddr(a: string): string {
  return a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-6)}` : a;
}

export function toast(msg: string): void {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.append(t);
  setTimeout(() => t.remove(), 2200);
}

/** Copia texto al portapapeles (permiso Clipboard pedido al arrancar) y lo avisa. */
export function copyText(text: string, done: string): void {
  if (!navigator.clipboard) return toast('Este contenedor no permite copiar');
  navigator.clipboard.writeText(text).then(() => toast(done), () => toast('No se pudo copiar'));
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export type Cleanup = () => void;
