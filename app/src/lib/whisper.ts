/**
 * Whisper con transformers.js: cómo se carga y cómo se transcribe una frase.
 * Lo comparten el worker, el respaldo en el hilo principal y el banco de
 * pruebas (scripts/bench-stt.ts), así la prueba transcribe igual que la app.
 */
import { LogitsProcessorList, NoRepeatNGramLogitsProcessor, pipeline, type Tensor } from '@huggingface/transformers';

export const WHISPER_MODEL = 'onnx-community/whisper-base';

export type Device = 'webgpu' | 'wasm' | 'cpu';
type Precision = 'fp32' | 'fp16' | 'q8' | 'q4';
export type Dtype = Precision | { encoder_model: Precision; decoder_model_merged: Precision };

/** Con WebGPU, la combinación del ejemplo oficial de transformers.js; si no, todo en 8 bits. */
export const dtypeFor = (device: Device): Dtype =>
  device === 'webgpu' ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : 'q8';

export interface LoadProgress {
  loaded: number;
  total: number;
  progress: number;
}

/** Las piezas del pipeline de transformers.js que se usan por separado para poder dar contexto. */
export interface Asr {
  processor(audio: Float32Array): Promise<{ input_features: Tensor }>;
  model: { generate(o: Record<string, unknown>): Promise<unknown> };
  tokenizer: {
    encode(text: string, o?: { add_special_tokens?: boolean }): number[];
    decode(ids: number[], o?: { skip_special_tokens?: boolean }): string;
    convert_tokens_to_ids(tokens: string[]): number[];
  };
}

export async function loadAsr(device: Device, onProgress: (p: LoadProgress) => void, dtype: Dtype = dtypeFor(device)): Promise<Asr> {
  return (await pipeline('automatic-speech-recognition', WHISPER_MODEL, {
    device,
    dtype,
    progress_callback: (p: { status: string; loaded?: number; total?: number; progress?: number }) => {
      if (p.status === 'progress_total') onProgress({ loaded: p.loaded ?? 0, total: p.total ?? 0, progress: p.progress ?? 0 });
    },
  })) as unknown as Asr;
}

/** No repite trigramas en lo que genera, pero sí puede repetir los del contexto (el vocabulario). */
class NoRepeatAfter extends NoRepeatNGramLogitsProcessor {
  private skip: number;
  constructor(n: number, skip: number) {
    super(n);
    this.skip = skip;
  }
  calcBannedNgramTokens(prevInputIds: bigint[]): number[] {
    return super.calcBannedNgramTokens(prevInputIds.slice(this.skip));
  }
}

export interface TranscribeOptions {
  language: 'es' | 'en';
  maxNewTokens: number;
  /**
   * Texto que Whisper toma como "lo dicho antes": sirve para que escriba bien
   * nombres propios y términos técnicos (Polkadot, Bulletin, UANL…). No aparece
   * en el resultado.
   */
  prompt?: string;
}

/** Transcribe una frase de audio a 16 kHz; devuelve el texto tal cual lo da Whisper. */
export async function transcribeSegment(asr: Asr, audio: Float32Array, o: TranscribeOptions): Promise<string> {
  const { input_features } = await asr.processor(audio);
  const prompt = o.prompt?.trim();
  if (!prompt) return generate(asr, input_features, o, '');
  const text = await generate(asr, input_features, o, prompt);
  // El contexto tiene dos fallas conocidas: sobre ruido Whisper copia el
  // vocabulario ("Polkadot App, Polkadota App" donde nadie habló), y con audio
  // difícil se rinde ("¿Qué pasa?" por 20 s de voz). En los dos casos se
  // transcribe otra vez sin contexto: lo copiado se descarta siempre, y de lo
  // corto se queda la versión con más palabras.
  if (looksCopied(text, prompt)) return generate(asr, input_features, o, '');
  if (words(text).length >= 0.8 * (audio.length / 16_000 - 1)) return text;
  const plain = await generate(asr, input_features, o, '');
  return words(plain).length > words(text).length ? plain : text;
}

async function generate(asr: Asr, input_features: Tensor, o: TranscribeOptions, prompt: string): Promise<string> {
  const tk = asr.tokenizer;
  const id = (t: string) => tk.convert_tokens_to_ids([t])[0];
  const context = prompt ? [id('<|startofprev|>'), ...tk.encode(' ' + prompt, { add_special_tokens: false }).slice(-150)] : [];
  const prefix = [...context, id('<|startoftranscript|>'), id(`<|${o.language}|>`), id('<|transcribe|>'), id('<|notimestamps|>')];
  // Contra los bucles de Whisper ("cadena cadena cadena…"): ningún trigrama se
  // repite y el texto no puede ser más largo de lo que cabe en el audio.
  const noRepeat = new LogitsProcessorList();
  noRepeat.push(new NoRepeatAfter(3, prefix.length));
  const out = (await asr.model.generate({
    inputs: input_features,
    decoder_input_ids: prefix,
    max_new_tokens: o.maxNewTokens,
    logits_processor: noRepeat,
  })) as Tensor;
  const ids = (out.tolist() as bigint[][])[0].slice(prefix.length).map(Number);
  return tk.decode(ids, { skip_special_tokens: true });
}

const words = (t: string) => t.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * Casi todo lo escrito sale del vocabulario (o empieza como una palabra suya:
 * "Polkadota"): puede ser copia y no lo dicho. Una frase que de verdad solo diga
 * "Polkadot App" pierde la ortografía, no el contenido.
 */
function looksCopied(text: string, prompt: string): boolean {
  const w = words(text);
  if (!w.length) return false;
  const vocab = words(prompt);
  const known = w.filter(x => vocab.some(v => x === v || (v.length >= 5 && x.startsWith(v)))).length;
  return known / w.length >= 0.6;
}
