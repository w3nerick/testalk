/**
 * Transcripción dentro de la app: micrófono del contenedor + Whisper en el
 * navegador (transformers.js, con WebGPU o WebAssembly). Hace lo mismo que
 * stt/testalk_stt.py sin instalar nada en la laptop.
 *
 * El micrófono entrega bloques de audio al segmentador (speech.ts), que los
 * corta en frases; se transcribe una frase a la vez para que la latencia no se
 * acumule. El audio no se guarda: cada tramo se descarta en cuanto se
 * transcribe. El recibo lleva solo el texto; la referencia externa es el video
 * de la charla.
 *
 * El modelo (~80-200 MB) se descarga de Hugging Face. Polkadot Desktop no
 * conserva el almacenamiento de las apps al cerrarse: se vuelve a descargar en
 * cada arranque. En un evento, se carga antes de subir al escenario y Desktop
 * no se cierra hasta terminar.
 */
import { isInsideContainerSync, requestDevicePermission } from '@parity/product-sdk-host';
import { withTimeout, TIMED_OUT } from './host';
import { RATE, Segmenter, cleanText, maxTokens } from './speech';
import type { Device, LoadProgress, TranscribeOptions } from './whisper';

export type { LoadProgress };
export type Backend = Exclude<Device, 'cpu'>;

/** Transcribe una frase de audio a 16 kHz; devuelve el texto tal cual lo da Whisper. */
type Transcribe = (audio: Float32Array, options: TranscribeOptions) => Promise<string>;

let transcribe: Transcribe | null = null;
let backend: Backend | null = null;
let loading: Promise<Backend> | null = null;

async function hasWebGPU(): Promise<boolean> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  return !!(gpu && (await gpu.requestAdapter().catch(() => null)));
}

export function whisperBackend(): Backend | null {
  return backend;
}

/** Carga Whisper en un Web Worker (la interfaz no se congela). Si el contenedor no deja crear workers, en el hilo principal. */
function viaWorker(device: Backend, onProgress: (p: LoadProgress) => void): Promise<Transcribe> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./whisper.worker.ts', import.meta.url), { type: 'module' });
    } catch (e) {
      return reject(e);
    }
    let seq = 0;
    const pending = new Map<number, { ok: (t: string) => void; fail: (e: Error) => void }>();
    worker.onmessage = (e: MessageEvent) => {
      const m = e.data as { type: string; id?: number; text?: string; error?: string; message?: string } & LoadProgress;
      if (m.type === 'progress') onProgress({ loaded: m.loaded, total: m.total, progress: m.progress });
      else if (m.type === 'ready') {
        resolve((audio, options) =>
          new Promise<string>((ok, fail) => {
            const id = ++seq;
            pending.set(id, { ok, fail });
            worker.postMessage({ type: 'transcribe', id, audio, options }, [audio.buffer]);
          }));
      } else if (m.type === 'error') {
        worker.terminate();
        reject(new Error(m.message));
      } else if (m.type === 'result' && m.id !== undefined) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) p?.fail(new Error(m.error));
        else p?.ok(m.text ?? '');
      }
    };
    worker.onerror = e => {
      worker.terminate();
      reject(new Error(e.message || 'no se pudo iniciar el worker de Whisper'));
    };
    worker.postMessage({ type: 'load', device });
  });
}

async function viaMainThread(device: Backend, onProgress: (p: LoadProgress) => void): Promise<Transcribe> {
  const [{ env }, { loadAsr, transcribeSegment }] = await Promise.all([import('@huggingface/transformers'), import('./whisper')]);
  env.allowLocalModels = false;
  const asr = await loadAsr(device, onProgress);
  return (audio, options) => transcribeSegment(asr, audio, options);
}

/** Carga Whisper una sola vez: WebGPU si hay, si no WebAssembly; en un worker si se puede. */
export function loadWhisper(onProgress: (p: LoadProgress) => void): Promise<Backend> {
  loading ??= (async () => {
    const devices: Backend[] = (await hasWebGPU()) ? ['webgpu', 'wasm'] : ['wasm'];
    let lastError: unknown;
    for (const device of devices) {
      for (const load of [viaWorker, viaMainThread]) {
        try {
          transcribe = await load(device, onProgress);
          backend = device;
          return device;
        } catch (e) {
          lastError = e;
          console.warn(`[mic] Whisper ${device} (${load === viaWorker ? 'worker' : 'hilo principal'}) falló:`, (e as Error)?.message);
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error('no se pudo cargar Whisper');
  })();
  loading.catch(() => { loading = null; });
  return loading;
}

const AUDIO: MediaStreamConstraints = {
  audio: { channelCount: 1, echoCancellation: false, noiseSuppression: true, autoGainControl: true },
};

export interface MicHandlers {
  onSentence(text: string): void;
  /** Nivel del micrófono en dBFS, unas cuatro veces por segundo. */
  onLevel?(db: number, speaking: boolean): void;
  onError?(message: string): void;
}

export class InAppMic {
  private ctx?: AudioContext;
  private stream?: MediaStream;
  private src?: MediaStreamAudioSourceNode;
  private node?: ScriptProcessorNode;
  private segmenter = new Segmenter(audio => {
    this.queue.push(audio);
    void this.pump();
  });
  private queue: Float32Array[] = [];
  private busy = false;
  private idle: (() => void)[] = [];
  private paused = false;
  private resuming: Promise<void> | null = null;
  private closed = false;
  private prompt = '';
  private h: MicHandlers;

  constructor(private language: string, handlers: MicHandlers) {
    this.h = handlers;
  }

  setHandlers(h: MicHandlers) {
    this.h = h;
  }

  /** Vocabulario de la charla (ver vocabPrompt): Whisper lo usa para escribir bien nombres y términos. */
  setPrompt(prompt: string) {
    this.prompt = prompt;
  }

  /** Abre el micrófono. Llamar desde un gesto del usuario. */
  async open(): Promise<void> {
    // Antes de cualquier await: creado dentro del gesto, el navegador no lo suspende.
    this.ctx = new AudioContext({ sampleRate: RATE });
    try {
      await this.connect();
    } catch (e) {
      this.close();
      throw e;
    }
  }

  private async connect(): Promise<void> {
    const ctx = this.ctx!;
    if (isInsideContainerSync()) {
      const r = await withTimeout(requestDevicePermission('Microphone'), 30_000).catch(() => null);
      if (r && r !== TIMED_OUT && r.ok && r.value === false) throw new Error('Polkadot App negó el permiso del micrófono.');
    }
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Este contenedor no da acceso al micrófono.');
    this.stream = await navigator.mediaDevices.getUserMedia(AUDIO);
    this.src = ctx.createMediaStreamSource(this.stream);
    // ScriptProcessor y no AudioWorklet: no necesita cargar un módulo aparte, que
    // en un contenedor con CSP propia es una cosa más que puede fallar.
    this.node = ctx.createScriptProcessor(4096, 1, 1);
    this.node.onaudioprocess = e => this.onAudio(e.inputBuffer.getChannelData(0));
    this.src.connect(this.node);
    this.node.connect(ctx.destination); // sin salida audible: el buffer de salida queda en ceros
    if (ctx.state === 'suspended') await ctx.resume();
  }

  isPaused(): boolean {
    return this.paused;
  }

  /**
   * Apaga el micrófono: termina de transcribir la frase en curso y suelta el
   * dispositivo (se apaga el indicador del sistema). Lo que se diga apagado no
   * se transcribe ni entra al recibo.
   */
  pause() {
    if (this.paused) return;
    this.paused = true;
    this.segmenter.flush();
    this.src?.disconnect();
    this.stream?.getTracks().forEach(t => t.stop());
    this.src = undefined;
    this.stream = undefined;
    this.h.onLevel?.(-120, false);
  }

  /**
   * Vuelve a encenderlo. El permiso ya está dado: el contenedor no pregunta otra vez.
   * Un segundo toque mientras abre no pide otro micrófono: dos abiertos dejaban uno
   * sin apagar.
   */
  resume(): Promise<void> {
    if (!this.paused || this.closed || !this.ctx || !this.node) return Promise.resolve();
    this.resuming ??= this.reopen().finally(() => { this.resuming = null; });
    return this.resuming;
  }

  private async reopen() {
    const stream = await navigator.mediaDevices.getUserMedia(AUDIO);
    // Se selló o se salió de la vista mientras abría: se suelta sin usarlo.
    if (this.closed || !this.ctx || !this.node) {
      stream.getTracks().forEach(t => t.stop());
      return;
    }
    this.stream = stream;
    this.src = this.ctx.createMediaStreamSource(stream);
    this.src.connect(this.node);
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.segmenter.resetNoise();
    this.paused = false;
  }

  private onAudio(chunk: Float32Array) {
    // Apagado, el nodo sigue recibiendo silencio: no se analiza.
    if (this.paused) return;
    const peak = this.segmenter.push(chunk);
    this.h.onLevel?.(peak, this.segmenter.speaking);
  }

  private async pump() {
    if (this.busy) return;
    const audio = this.queue.shift();
    if (!audio) {
      this.idle.splice(0).forEach(f => f());
      return;
    }
    // Frases dichas mientras Whisper se descarga: se descartan (aún no empezó la charla).
    if (!transcribe) return void this.pump();
    this.busy = true;
    try {
      const text = cleanText(await transcribe(audio, { language: this.language === 'en' ? 'en' : 'es', maxNewTokens: maxTokens(audio.length), prompt: this.prompt }));
      if (text) this.h.onSentence(text);
    } catch (e) {
      this.h.onError?.((e as Error).message);
    } finally {
      this.busy = false;
      void this.pump();
    }
  }

  /** Cierra la frase en curso y espera a que se transcriba lo pendiente (con tope). */
  async drain(ms = 60_000): Promise<void> {
    this.segmenter.flush();
    if (!this.busy && this.queue.length === 0) return;
    await Promise.race([new Promise<void>(r => this.idle.push(r)), new Promise(r => setTimeout(r, ms))]);
  }

  /**
   * Al sellar: suelta el micrófono al instante (lo que se diga después no entra al
   * recibo) y luego transcribe lo que ya estaba dicho.
   */
  async stop(): Promise<void> {
    this.closed = true;
    this.pause();
    await this.drain();
    this.close();
  }

  /** Suelta el micrófono sin sellar (al salir de la vista). */
  close() {
    this.closed = true;
    this.node?.disconnect();
    this.src?.disconnect();
    this.stream?.getTracks().forEach(t => t.stop());
    this.ctx?.close().catch(() => undefined);
  }
}
