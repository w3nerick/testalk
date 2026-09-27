/// <reference lib="webworker" />
/**
 * Whisper en un Web Worker. La inferencia tarda segundos por frase: en el hilo
 * principal congelaba la página (reloj, bloques, el botón de sellar). Aquí la
 * interfaz sigue respondiendo mientras transcribe.
 *
 * Protocolo:
 *   → { type: 'load', device }                    ← progress… , ready | error
 *   → { type: 'transcribe', id, audio, options }  ← { type: 'result', id, text } | { type: 'result', id, error }
 */
import { env } from '@huggingface/transformers';
import { loadAsr, transcribeSegment, type Asr, type Device, type TranscribeOptions } from './whisper';

env.allowLocalModels = false;

let asr: Asr | null = null;

const post = (m: unknown, transfer: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(m, transfer);

self.onmessage = async (e: MessageEvent) => {
  const m = e.data as
    | { type: 'load'; device: Device }
    | { type: 'transcribe'; id: number; audio: Float32Array; options: TranscribeOptions };

  if (m.type === 'load') {
    try {
      asr = await loadAsr(m.device, p => post({ type: 'progress', ...p }));
      post({ type: 'ready', device: m.device });
    } catch (err) {
      post({ type: 'error', message: (err as Error)?.message ?? String(err) });
    }
    return;
  }

  if (m.type === 'transcribe') {
    try {
      if (!asr) throw new Error('Whisper no está cargado');
      post({ type: 'result', id: m.id, text: await transcribeSegment(asr, m.audio, m.options) });
    } catch (err) {
      post({ type: 'result', id: m.id, error: (err as Error)?.message ?? String(err) });
    }
  }
};
