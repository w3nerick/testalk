/**
 * Cliente del transcriptor local (stt/testalk_stt.py).
 *
 * El script corre en la laptop del speaker, escucha el micrófono con
 * faster-whisper y emite cada frase terminada por ws://localhost:8787. Mismo
 * esquema que el companion de Karim. La app solo usa el texto: el recibo no
 * lleva audio.
 */

export const STT_URL = 'ws://localhost:8787';

export type SttStatus = 'off' | 'connecting' | 'on';

export interface SttHandlers {
  onStatus(s: SttStatus): void;
  onSentence(text: string): void;
}

let ws: WebSocket | null = null;
let retry: ReturnType<typeof setTimeout> | undefined;
let wanted = false;

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
      let m: { type?: string; text?: string };
      try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.type === 'final' && m.text?.trim()) h.onSentence(m.text.trim());
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
