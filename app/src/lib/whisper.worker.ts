/// <reference lib="webworker" />
/**
 * Whisper en un Web Worker. La inferencia tarda segundos por frase: en el hilo
 * principal congelaba la página (reloj, bloques, el botón de sellar). Aquí la
 * interfaz sigue respondiendo mientras transcribe.
 *
 * Protocolo:
 *   → { type: 'load', model, device }        ← progress… , ready | error
 *   → { type: 'transcribe', id, audio, language, maxNewTokens }
 *                                            ← { type: 'result', id, text } | { type: 'result', id, error }
 */
import { env, pipeline } from '@huggingface/transformers';

env.allowLocalModels = false;

type Device = 'webgpu' | 'wasm';
type Asr = (audio: Float32Array, opts: Record<string, unknown>) => Promise<{ text: string } | { text: string }[]>;

let asr: Asr | null = null;

const post = (m: unknown, transfer: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(m, transfer);

self.onmessage = async (e: MessageEvent) => {
  const m = e.data as
    | { type: 'load'; model: string; device: Device }
    | { type: 'transcribe'; id: number; audio: Float32Array; language: string; maxNewTokens: number };

  if (m.type === 'load') {
    try {
      asr = (await pipeline('automatic-speech-recognition', m.model, {
        device: m.device,
        // Con WebGPU, la combinación del ejemplo oficial de transformers.js.
        dtype: m.device === 'webgpu' ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : 'q8',
        progress_callback: (p: { status: string; loaded?: number; total?: number; progress?: number }) => {
          if (p.status === 'progress_total') post({ type: 'progress', loaded: p.loaded ?? 0, total: p.total ?? 0, progress: p.progress ?? 0 });
        },
      })) as unknown as Asr;
      post({ type: 'ready', device: m.device });
    } catch (err) {
      post({ type: 'error', message: (err as Error)?.message ?? String(err) });
    }
    return;
  }

  if (m.type === 'transcribe') {
    try {
      if (!asr) throw new Error('Whisper no está cargado');
      const out = await asr(m.audio, {
        language: m.language,
        task: 'transcribe',
        // Contra los bucles de Whisper ("cadena cadena cadena…"): ningún trigrama se
        // repite y el texto no puede ser más largo de lo que cabe en el audio.
        no_repeat_ngram_size: 3,
        max_new_tokens: m.maxNewTokens,
      });
      post({ type: 'result', id: m.id, text: Array.isArray(out) ? out.map(o => o.text).join(' ') : out.text });
    } catch (err) {
      post({ type: 'result', id: m.id, error: (err as Error)?.message ?? String(err) });
    }
  }
};
