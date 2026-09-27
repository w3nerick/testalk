/**
 * Banco de pruebas de la transcripción: corta un WAV en frases y las transcribe
 * con el mismo código que la app (src/lib/speech.ts + src/lib/whisper.ts), en
 * la CPU con onnxruntime-web (WASM, un hilo; ver scripts/ort-web-node.mjs).
 * Sirve para comparar ajustes antes de tocar la app. Los tiempos solo sirven
 * para comparar corridas entre sí, no para estimar la velocidad en Desktop.
 *
 *   npm run bench-stt -- grabacion.wav                       (solo el texto)
 *   npm run bench-stt -- grabacion.wav --ref guion.txt       (+ % de error por palabra)
 *   npm run bench-stt -- grabacion.wav --run 12s:gpu:-,20s:q8:vocab --json salida.json
 *
 * Cada corrida es corte:modelo:contexto
 *   corte     app = lo que usa la app (SEGMENTER_DEFAULTS) ·
 *             viejo = como la app hasta 27 sep (perdía 256 de cada 4096 muestras) ·
 *             12s = pausa 0.5 s, tope 12 s (corta en el hueco más silencioso) ·
 *             duro = igual, pero corta justo en el tope · 20s = pausa 0.8 s, tope 20 s ·
 *             28s = pausa 0.8 s, tope 28 s (Whisper escucha ventanas de 30 s)
 *   modelo    gpu = encoder fp32 + decoder q4 (~206 MB, lo que baja WebGPU) ·
 *             q4 = todo q4 (~142 MB) · q8 = todo q8 (~77 MB, lo que baja WASM)
 *   contexto  - = sin vocabulario · vocab = BASE_VOCAB de src/lib/speech.ts (o --vocab "…")
 *
 * El WAV debe ser mono a 16 kHz; para convertir:
 *   ffmpeg -i entrada.m4a -ac 1 -ar 16000 -c:a pcm_s16le salida.wav
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { BASE_VOCAB, RATE, Segmenter, cleanText, maxTokens, type SegmenterOptions } from '../src/lib/speech.ts';
import { loadAsr, transcribeSegment, type Asr, type Dtype } from '../src/lib/whisper.ts';

const CUTS: Record<string, { opts: Partial<SegmenterOptions>; chunk: number }> = {
  app: { opts: {}, chunk: 4096 },
  viejo: { opts: { endFrames: 17, maxSeconds: 12 }, chunk: 3840 },
  duro: { opts: { endFrames: 17, maxSeconds: 12, splitFrames: 0 }, chunk: 4096 },
  '12s': { opts: { endFrames: 17, maxSeconds: 12 }, chunk: 4096 },
  '20s': { opts: { endFrames: 27, maxSeconds: 20 }, chunk: 4096 },
  '28s': { opts: { endFrames: 27, maxSeconds: 28 }, chunk: 4096 },
};
const MODELS: Record<string, Dtype> = {
  gpu: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
  q4: 'q4',
  q8: 'q8',
};

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const refPath = flag('--ref');
const runsArg = flag('--run') ?? 'app:gpu:vocab';
const vocab = flag('--vocab') ?? BASE_VOCAB;
const jsonOut = flag('--json');
const lang = (flag('--lang') ?? 'es') as 'es' | 'en';
const wavPath = args[0];
if (!wavPath) {
  console.error('uso: npm run bench-stt -- grabacion.wav [--ref texto.txt] [--run corte:modelo:contexto,…] [--json salida.json]');
  process.exit(1);
}

/** WAV PCM de 16 bits, mono, 16 kHz → muestras en [-1, 1]. */
function readWav(path: string): Float32Array {
  const b = readFileSync(path);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`${path} no es WAV`);
  let off = 12;
  let fmt: { channels: number; rate: number; bits: number } | null = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { channels: b.readUInt16LE(off + 10), rate: b.readUInt32LE(off + 12), bits: b.readUInt16LE(off + 22) };
    if (id === 'data') {
      if (!fmt || fmt.channels !== 1 || fmt.rate !== RATE || fmt.bits !== 16) {
        throw new Error(`${path}: hace falta mono, ${RATE} Hz, 16 bits (ffmpeg -i … -ac 1 -ar 16000 -c:a pcm_s16le salida.wav)`);
      }
      const n = Math.min(size, b.length - off - 8) / 2;
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = b.readInt16LE(off + 8 + i * 2) / 32768;
      return out;
    }
    off += 8 + size + (size % 2);
  }
  throw new Error(`${path}: sin datos de audio`);
}

/** Corta como el micrófono de la app: bloques de 4096 muestras al segmentador. */
function segment(audio: Float32Array, cut: (typeof CUTS)[string]): Float32Array[] {
  const segs: Float32Array[] = [];
  const s = new Segmenter(a => segs.push(a), cut.opts);
  // El corte "viejo" solo pasaba 3840 de cada 4096 muestras (8 tramos de 480).
  for (let i = 0; i < audio.length; i += 4096) s.push(audio.subarray(i, Math.min(i + cut.chunk, audio.length)));
  s.flush();
  return segs;
}

const norm = (t: string) =>
  t.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);

/** Error por palabra: (sustituciones + borradas + insertadas) / palabras de la referencia. */
function wer(ref: string[], hyp: string[]): number {
  let prev = Array.from({ length: hyp.length + 1 }, (_, j) => j);
  for (let i = 1; i <= ref.length; i++) {
    const cur = [i];
    for (let j = 1; j <= hyp.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[hyp.length] / Math.max(1, ref.length);
}

/** Términos del vocabulario que aparecen en la referencia: cuántas veces los escribió bien. */
function terms(ref: string, hyp: string): { ok: number; total: number; missed: string[] } {
  const r = ` ${norm(ref).join(' ')} `;
  const h = ` ${norm(hyp).join(' ')} `;
  let ok = 0;
  let total = 0;
  const missed: string[] = [];
  for (const term of vocab.split(/[,.]/).map(t => norm(t).join(' ')).filter(Boolean)) {
    const count = (s: string) => s.split(` ${term} `).length - 1;
    const want = count(r);
    if (!want) continue;
    const got = Math.min(want, count(h));
    total += want;
    ok += got;
    if (got < want) missed.push(term);
  }
  return { ok, total, missed };
}

const audio = readWav(wavPath);
const ref = refPath ? readFileSync(refPath, 'utf8') : null;
console.log(`${wavPath}: ${(audio.length / RATE).toFixed(1)} s${ref ? `, referencia ${norm(ref).length} palabras` : ''}\n`);

const loaded = new Map<string, Asr>();
const results: Record<string, unknown>[] = [];
for (const run of runsArg.split(',')) {
  const [cutName, modelName, ctx] = run.split(':');
  const cut = CUTS[cutName];
  const dtype = MODELS[modelName];
  if (!cut || !dtype) throw new Error(`corrida desconocida: ${run}`);
  let asr = loaded.get(modelName);
  if (!asr) {
    asr = await loadAsr('wasm', () => undefined, dtype);
    loaded.set(modelName, asr);
  }
  const segs = segment(audio, cut);
  const t0 = performance.now();
  const lines: string[] = [];
  for (const seg of segs) {
    const raw = await transcribeSegment(asr, seg, { language: lang, maxNewTokens: maxTokens(seg.length), prompt: ctx === 'vocab' ? vocab : undefined });
    const text = cleanText(raw);
    if (text) lines.push(text);
  }
  const secs = (performance.now() - t0) / 1000;
  const text = lines.join(' ');
  const row: Record<string, unknown> = { run, segments: segs.length, seconds: +secs.toFixed(1), text, lines };
  let head = `── ${run}  ·  ${segs.length} frases  ·  ${secs.toFixed(1)} s`;
  if (ref) {
    const w = wer(norm(ref), norm(text));
    const t = terms(ref, text);
    Object.assign(row, { wer: +(w * 100).toFixed(1), terms: `${t.ok}/${t.total}`, missed: t.missed });
    head += `  ·  error ${(w * 100).toFixed(1)} %  ·  términos ${t.ok}/${t.total}${t.missed.length ? ` (falló: ${t.missed.join(', ')})` : ''}`;
  }
  console.log(head);
  for (const l of lines) console.log(`   ${l}`);
  console.log();
  results.push(row);
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ wav: wavPath, vocab, results }, null, 2));
