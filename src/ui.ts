import { icon } from './lib/icons';

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
  return `
  <header class="shell topbar">
    <a class="brand" href="#/"><span class="brand-mark">${icon('waveform')}</span>testalk</a>
    <div class="grow">${extra}</div>
  </header>`;
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

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export type Cleanup = () => void;
