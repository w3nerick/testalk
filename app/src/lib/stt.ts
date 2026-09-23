/**
 * Cliente del transcriptor local (stt/testalk_stt.py).
 *
 * El script corre en la laptop del speaker, escucha el micrófono con
 * faster-whisper y emite cada frase terminada por ws://localhost:8787. Mismo
 * esquema que el companion de Karim, más un mensaje `seal` que cierra el WAV y
 * devuelve su hash para atarlo a la firma.
 */
import type { AudioSeal } from './artifact';

export const STT_URL = 'ws://localhost:8787';

export type SttStatus = 'off' | 'connecting' | 'on';

export interface SttHandlers {
  onStatus(s: SttStatus): void;
  onSentence(text: string): void;
}

let ws: WebSocket | null = null;
let retry: ReturnType<typeof setTimeout> | undefined;
let wanted = false;
let pendingSeal: ((a: AudioSeal | null) => void) | null = null;

export function startStt(h: SttHandlers): void {
  wanted = true;
  const open = () => {
    if (!wanted) return;
    h.onStatus('connecting');
    try {
      ws = new WebSocket(STT_URL);
    } catch {
      h.onStatus('off');
      retry = setTimeout(open, 2500);
      return;
    }
    ws.onopen = () => h.onStatus('on');
    ws.onmessage = ev => {
      let m: { type?: string; text?: string } & Partial<AudioSeal>;
      try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.type === 'final' && m.text?.trim()) h.onSentence(m.text.trim());
      if (m.type === 'audio' && pendingSeal) {
        pendingSeal(m.hash ? { alg: 'blake2b-256', hash: m.hash, bytes: m.bytes ?? 0, seconds: m.seconds ?? 0 } : null);
        pendingSeal = null;
      }
    };
    ws.onclose = () => {
      h.onStatus('off');
      ws = null;
      if (wanted) retry = setTimeout(open, 2500);
    };
  };
  open();
}

export function stopStt(): void {
  wanted = false;
  clearTimeout(retry);
  ws?.close();
  ws = null;
}

/**
 * Pide al transcriptor cerrar la grabación y devolver el hash del WAV.
 * Si no hay transcriptor o no contesta en 8 s, se sella sin audio.
 */
export function sealAudio(ms = 8000): Promise<AudioSeal | null> {
  if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.resolve(null);
  return new Promise(resolve => {
    const t = setTimeout(() => { pendingSeal = null; resolve(null); }, ms);
    pendingSeal = a => { clearTimeout(t); resolve(a); };
    ws!.send(JSON.stringify({ type: 'seal' }));
  });
}
