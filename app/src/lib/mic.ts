/**
 * Transcripción dentro de la app: micrófono del contenedor + Whisper en el
 * navegador (transformers.js, con WebGPU o WebAssembly). Hace lo mismo que
 * stt/testalk_stt.py sin instalar nada en la laptop.
 *
 * Mismo esquema que el script de Python: un detector de voz por energía abre
 * la frase tras ~90 ms de voz y la cierra tras ~510 ms de silencio (tope de
 * 12 s), se transcribe una frase a la vez para que la latencia no se acumule,
 * y el audio completo se guarda en WAV para atar su huella al recibo.
 *
 * El modelo (~80-200 MB) se descarga de Hugging Face la primera vez y queda en
 * la caché del navegador: en un evento, se precarga antes de subir al escenario.
 */
import { blake2b } from '@noble/hashes/blake2b';
import { u8aToHex } from '@polkadot/util';
import { isInsideContainerSync, requestDevicePermission } from '@parity/product-sdk-host';
import { withTimeout, TIMED_OUT } from './host';
import type { AudioSeal } from './artifact';

export const WHISPER_MODEL = 'onnx-community/whisper-base';

const RATE = 16_000;
const FRAME = 480; // 30 ms
const START_FRAMES = 3; // ~90 ms de voz abren la frase
const END_FRAMES = 17; // ~510 ms de silencio la cierran
const PREROLL_FRAMES = 10; // 300 ms antes de la voz, para no cortar la primera sílaba
const MAX_SAMPLES = 12 * RATE;
const MIN_SAMPLES = 0.4 * RATE;

export type Backend = 'webgpu' | 'wasm';

export interface LoadProgress {
  loaded: number;
  total: number;
  progress: number;
}

/** Transcribe un tramo de audio a 16 kHz; devuelve el texto tal cual lo da Whisper. */
type Transcribe = (audio: Float32Array, language: string) => Promise<string>;

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

/** Tokens máximos por tramo: unos 8 por segundo de audio. Un bucle no puede crecer más allá. */
const maxTokens = (samples: number) => Math.min(160, Math.ceil((samples / RATE) * 8) + 10);

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
        resolve((audio, language) =>
          new Promise<string>((ok, fail) => {
            const id = ++seq;
            pending.set(id, { ok, fail });
            worker.postMessage({ type: 'transcribe', id, audio, language, maxNewTokens: maxTokens(audio.length) }, [audio.buffer]);
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
    worker.postMessage({ type: 'load', model: WHISPER_MODEL, device });
  });
}

async function viaMainThread(device: Backend, onProgress: (p: LoadProgress) => void): Promise<Transcribe> {
  const { pipeline, env } = await import('@huggingface/transformers');
  env.allowLocalModels = false;
  const asr = (await pipeline('automatic-speech-recognition', WHISPER_MODEL, {
    device,
    dtype: device === 'webgpu' ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : 'q8',
    progress_callback: (p: { status: string; loaded?: number; total?: number; progress?: number }) => {
      if (p.status === 'progress_total') onProgress({ loaded: p.loaded ?? 0, total: p.total ?? 0, progress: p.progress ?? 0 });
    },
  })) as unknown as (audio: Float32Array, opts: Record<string, unknown>) => Promise<{ text: string } | { text: string }[]>;
  return async (audio, language) => {
    const out = await asr(audio, { language, task: 'transcribe', no_repeat_ngram_size: 3, max_new_tokens: maxTokens(audio.length) });
    return Array.isArray(out) ? out.map(o => o.text).join(' ') : out.text;
  };
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

/** Frases que Whisper inventa sobre silencio o ruido; no son de quien habla. */
const HALLUCINATION = /amara\.org|subt[ií]tul|suscr[ií]b|gracias por ver|^\s*[[(].*[\])]\s*$|^[\s\p{P}]*$/iu;

/**
 * Colapsa los bucles de Whisper: "sus-sus-sus" → "sus", "cadena cadena cadena" → "cadena".
 * Si el texto era casi todo repetición, no lo dijo nadie: se descarta.
 */
export function cleanText(t: string): string {
  const text = t.replace(/\s+/g, ' ').trim();
  if (HALLUCINATION.test(text)) return '';
  const collapsed = text
    .replace(/(?<!\p{L})(\p{L}+)(?:-\1(?!\p{L})){2,}/giu, '$1')
    .replace(/(?<!\p{L})(\p{L}+)(?:[\s,.;:!¡¿?]+\1(?!\p{L})){2,}/giu, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return collapsed.length < text.length * 0.4 ? '' : collapsed;
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
  private pcm: Int16Array[] = [];
  private samples = 0;
  private noiseDb = -60;
  private voicedRun = 0;
  private silentRun = 0;
  private speaking = false;
  private seg: Float32Array[] = [];
  private segSamples = 0;
  private preroll: Float32Array[] = [];
  private queue: Float32Array[] = [];
  private busy = false;
  private idle: (() => void)[] = [];
  private paused = false;
  private h: MicHandlers;

  constructor(private language: string, handlers: MicHandlers) {
    this.h = handlers;
  }

  setHandlers(h: MicHandlers) {
    this.h = h;
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
   * dispositivo (se apaga el indicador del sistema). La grabación se pausa: lo
   * que se diga apagado no entra al recibo ni al WAV.
   */
  pause() {
    if (this.paused) return;
    this.paused = true;
    if (this.speaking) this.endSegment();
    this.src?.disconnect();
    this.stream?.getTracks().forEach(t => t.stop());
    this.src = undefined;
    this.stream = undefined;
    this.h.onLevel?.(-120, false);
  }

  /** Vuelve a encenderlo. El permiso ya está dado: el contenedor no pregunta otra vez. */
  async resume() {
    if (!this.paused || !this.ctx || !this.node) return;
    this.stream = await navigator.mediaDevices.getUserMedia(AUDIO);
    this.src = this.ctx.createMediaStreamSource(this.stream);
    this.src.connect(this.node);
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.noiseDb = -60;
    this.paused = false;
  }

  /** Empieza la grabación que se sella: lo que se captó antes de "Empezar" no cuenta. */
  resetRecording() {
    this.pcm = [];
    this.samples = 0;
  }

  private onAudio(chunk: Float32Array) {
    // Apagado, el nodo sigue recibiendo silencio: no se graba ni se analiza.
    if (this.paused) return;
    const x = new Float32Array(chunk);
    const s16 = new Int16Array(x.length);
    for (let i = 0; i < x.length; i++) s16[i] = Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767)));
    this.pcm.push(s16);
    this.samples += x.length;

    let peak = -120;
    for (let off = 0; off + FRAME <= x.length; off += FRAME) {
      const frame = x.subarray(off, off + FRAME);
      let sum = 0;
      for (const v of frame) sum += v * v;
      const db = 20 * Math.log10(Math.sqrt(sum / FRAME) + 1e-9);
      peak = Math.max(peak, db);
      this.vad(frame, db);
    }
    this.h.onLevel?.(peak, this.speaking);
  }

  private vad(frame: Float32Array, db: number) {
    // Piso de ruido: baja rápido y sube despacio, para no confundir voz con ruido.
    if (!this.speaking) this.noiseDb = db < this.noiseDb ? db : this.noiseDb * 0.995 + db * 0.005;
    const voiced = db > Math.max(this.noiseDb + 10, -55);
    if (!this.speaking) {
      this.preroll.push(frame);
      if (this.preroll.length > PREROLL_FRAMES) this.preroll.shift();
      this.voicedRun = voiced ? this.voicedRun + 1 : 0;
      if (this.voicedRun >= START_FRAMES) {
        this.speaking = true;
        this.silentRun = 0;
        this.seg = [...this.preroll];
        this.segSamples = this.seg.length * FRAME;
        this.preroll = [];
      }
      return;
    }
    this.seg.push(frame);
    this.segSamples += FRAME;
    this.silentRun = voiced ? 0 : this.silentRun + 1;
    if (this.silentRun >= END_FRAMES || this.segSamples >= MAX_SAMPLES) this.endSegment();
  }

  private endSegment() {
    this.speaking = false;
    this.voicedRun = 0;
    if (this.segSamples >= MIN_SAMPLES) {
      const audio = new Float32Array(this.segSamples);
      let at = 0;
      for (const f of this.seg) { audio.set(f, at); at += f.length; }
      this.queue.push(audio);
      void this.pump();
    }
    this.seg = [];
    this.segSamples = 0;
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
      const text = cleanText(await transcribe(audio, this.language === 'en' ? 'english' : 'spanish'));
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
    if (this.speaking) this.endSegment();
    if (!this.busy && this.queue.length === 0) return;
    await Promise.race([new Promise<void>(r => this.idle.push(r)), new Promise(r => setTimeout(r, ms))]);
  }

  /** Detiene el micrófono y devuelve el WAV de la charla con su huella blake2b-256. */
  async stop(): Promise<{ wav: Blob; seal: AudioSeal }> {
    await this.drain();
    this.node?.disconnect();
    this.src?.disconnect();
    this.stream?.getTracks().forEach(t => t.stop());
    await this.ctx?.close().catch(() => undefined);
    const wav = encodeWav(this.pcm, this.samples);
    const hash = u8aToHex(blake2b(wav, { dkLen: 32 }));
    return {
      wav: new Blob([wav as BlobPart], { type: 'audio/wav' }),
      seal: { alg: 'blake2b-256', hash, bytes: wav.byteLength, seconds: Math.round((this.samples / RATE) * 10) / 10 },
    };
  }

  /** Suelta el micrófono sin sellar (al salir de la vista). */
  close() {
    this.node?.disconnect();
    this.src?.disconnect();
    this.stream?.getTracks().forEach(t => t.stop());
    this.ctx?.close().catch(() => undefined);
  }
}

/** PCM16 mono a 16 kHz con cabecera WAV de 44 bytes. */
function encodeWav(chunks: Int16Array[], samples: number): Uint8Array {
  const data = samples * 2;
  const out = new Uint8Array(44 + data);
  const v = new DataView(out.buffer);
  const text = (at: number, s: string) => { for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i); };
  text(0, 'RIFF'); v.setUint32(4, 36 + data, true); text(8, 'WAVE');
  text(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, RATE, true); v.setUint32(28, RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  text(36, 'data'); v.setUint32(40, data, true);
  let at = 44;
  for (const c of chunks) { out.set(new Uint8Array(c.buffer, c.byteOffset, c.byteLength), at); at += c.byteLength; }
  return out;
}
