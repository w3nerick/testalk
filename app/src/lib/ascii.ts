/**
 * Arte ASCII de la app. Todo se genera: nada de dibujos a mano.
 *
 * `voiceField` es la metáfora de testalk en una banda de texto: una onda de voz
 * que corre hacia la izquierda y, cada vez que llega un bloque real, queda
 * clavado en ella un poste con su número.
 */

export const RAMP = ' .:-=+*#%@';

export interface VoiceField {
  /** Clava un bloque en la onda: un poste vertical con la etiqueta arriba. */
  stamp(label: string): void;
  stop(): void;
}

interface Col { amp: number; mark?: string }

export function voiceField(pre: HTMLElement, rows = 9): VoiceField {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const mid = (rows - 1) / 2;
  let cols: Col[] = [];
  let width = 0;
  let t = 0;
  // Voz: ráfagas de sílabas separadas por pausas cortas.
  let burst = 0;
  let pause = 0;

  const nextAmp = () => {
    t++;
    if (pause > 0) { pause--; return 0.04 + Math.random() * 0.05; }
    if (burst <= 0) {
      burst = 6 + Math.floor(Math.random() * 18);
      if (Math.random() < 0.35) pause = 3 + Math.floor(Math.random() * 6);
    }
    burst--;
    const syllable = Math.abs(Math.sin(t * 0.55)) * 0.55 + Math.abs(Math.sin(t * 1.7 + 1)) * 0.3;
    return Math.min(1, 0.12 + syllable * (0.6 + Math.random() * 0.5));
  };

  const measure = () => {
    const probe = document.createElement('span');
    probe.textContent = 'M'.repeat(20);
    probe.style.visibility = 'hidden';
    pre.append(probe);
    const cw = probe.getBoundingClientRect().width / 20 || 8;
    probe.remove();
    width = Math.max(16, Math.floor(pre.clientWidth / cw));
    while (cols.length < width) cols.unshift({ amp: nextAmp() });
    if (cols.length > width) cols = cols.slice(cols.length - width);
  };

  const render = () => {
    const grid: string[][] = Array.from({ length: rows }, () => Array<string>(width).fill(' '));
    const marks: { x: number; label: string }[] = [];
    cols.forEach((c, x) => {
      if (c.mark !== undefined) {
        for (let r = 0; r < rows; r++) grid[r][x] = r === Math.round(mid) ? '■' : '│';
        marks.push({ x, label: c.mark });
        return;
      }
      const reach = c.amp * (mid + 0.5);
      for (let r = 0; r < rows; r++) {
        const d = Math.abs(r - mid);
        if (d > reach) continue;
        // El brillo depende del volumen: en silencio solo quedan puntos.
        const k = (1 - d / (reach + 0.001)) * c.amp;
        grid[r][x] = RAMP[Math.min(RAMP.length - 1, 1 + Math.floor(k * (RAMP.length - 1)))];
      }
    });
    // Etiquetas en la fila de arriba, a la derecha de su poste, sin pisarse.
    const bold = new Set(marks.map(m => m.x));
    const top = new Set<number>();
    let free = 0;
    for (const m of marks) {
      const start = Math.max(m.x + 2, free);
      for (let i = 0; i < m.label.length && start + i < width; i++) {
        grid[0][start + i] = m.label[i];
        top.add(start + i);
      }
      free = start + m.label.length + 1;
    }
    pre.innerHTML = grid
      .map((line, r) => line.map((ch, x) => (bold.has(x) || (r === 0 && top.has(x)) ? `<b>${ch}</b>` : ch)).join(''))
      .join('\n');
  };

  measure();
  render();

  let timer = 0;
  // Los bloques llegan a ráfagas al conectar: se encolan para que cada poste
  // tenga espacio para su etiqueta.
  const queue: string[] = [];
  let sinceMark = Infinity;
  const push = (c: Col) => {
    cols.shift();
    cols.push(c);
    sinceMark = c.mark === undefined ? sinceMark + 1 : 0;
  };
  const gap = () => (queue[0]?.length ?? 0) + 4;
  const tick = () => {
    if (document.hidden) return;
    if (queue.length && sinceMark >= gap()) push({ amp: 0, mark: queue.shift() });
    else push({ amp: nextAmp() });
    render();
  };
  if (!reduce) timer = window.setInterval(tick, 90);
  const ro = new ResizeObserver(() => { measure(); render(); });
  ro.observe(pre);

  return {
    stamp(label) {
      if (reduce) {
        push({ amp: 0, mark: label });
        render();
      } else {
        queue.push(label);
        queue.splice(0, Math.max(0, queue.length - 2));
      }
    },
    stop() {
      clearInterval(timer);
      ro.disconnect();
    },
  };
}

/** Barra de progreso de texto: `[######....]`. */
export function asciiBar(done: number, total: number, size = 12): string {
  const n = total ? Math.round((done / total) * size) : 0;
  return `[${'#'.repeat(n)}${'.'.repeat(size - n)}]`;
}

/** Sello de goma en caracteres de caja; las líneas se centran en el marco. */
export function asciiStamp(lines: string[]): string {
  const w = Math.max(...lines.map(l => l.length)) + 4;
  const pad = (s: string) => {
    const left = Math.floor((w - s.length) / 2);
    return ' '.repeat(left) + s + ' '.repeat(w - s.length - left);
  };
  return [`╔${'═'.repeat(w)}╗`, ...lines.map(l => `║${pad(l)}║`), `╚${'═'.repeat(w)}╝`].join('\n');
}
