/**
 * Lo que la transcripción necesita sin depender del navegador ni de Whisper:
 * cortar el audio en frases, limpiar lo que Whisper devuelve y el vocabulario
 * que se le da como contexto. Lo usan InAppMic y el banco de pruebas
 * (scripts/bench-stt.ts), así la prueba corta y limpia igual que la app.
 *
 * El corte es un detector de voz por energía: abre la frase tras unos 90 ms de
 * voz y la cierra tras un silencio o al llegar al tope de duración.
 */

export const RATE = 16_000;
const FRAME = 480; // 30 ms

export interface SegmenterOptions {
  /** Tramos de 30 ms con voz que abren la frase. */
  startFrames: number;
  /** Tramos de 30 ms de silencio que la cierran. */
  endFrames: number;
  /** Tramos de 30 ms antes de la voz que entran a la frase, para no cortar la primera sílaba. */
  prerollFrames: number;
  /** Tope de una frase, en segundos: al llegar se corta aunque siga la voz. */
  maxSeconds: number;
  /** Frases más cortas que esto se descartan (golpes, clics). */
  minSeconds: number;
  /**
   * Al llegar al tope hablando de corrido, tramos de 30 ms hacia atrás donde se
   * busca el hueco más silencioso para cortar. 0 = cortar justo en el tope.
   */
  splitFrames: number;
}

/**
 * Frases largas: Whisper escucha ventanas de 30 s y con más contexto se
 * equivoca menos. Con una grabación real leyendo stt/guion-demo.txt, pasar de
 * 0.5 s / 12 s a 0.8 s / 20 s bajó el error de 21 % a 16 % (más que cambiar a
 * Whisper small). El costo: el texto aparece en pantalla en bloques más largos.
 */
export const SEGMENTER_DEFAULTS: SegmenterOptions = {
  startFrames: 3,
  endFrames: 27,
  prerollFrames: 10,
  maxSeconds: 20,
  minSeconds: 0.4,
  splitFrames: 50,
};

export class Segmenter {
  private opts: SegmenterOptions;
  private onSegment: (audio: Float32Array) => void;
  private rest = new Float32Array(0);
  private noiseDb = -60;
  private voicedRun = 0;
  private silentRun = 0;
  private seg: Float32Array[] = [];
  private segDb: number[] = [];
  private segSamples = 0;
  private segMinDb = 0;
  private preroll: Float32Array[] = [];
  speaking = false;

  constructor(onSegment: (audio: Float32Array) => void, opts: Partial<SegmenterOptions> = {}) {
    this.onSegment = onSegment;
    this.opts = { ...SEGMENTER_DEFAULTS, ...opts };
  }

  /**
   * Recibe audio a 16 kHz en bloques de cualquier tamaño y devuelve el pico del
   * bloque en dBFS. Lo que no completa un tramo de 30 ms espera al bloque
   * siguiente: el micrófono entrega 4096 muestras, que no son múltiplo de 480.
   */
  push(chunk: Float32Array): number {
    const x = new Float32Array(this.rest.length + chunk.length);
    x.set(this.rest);
    x.set(chunk, this.rest.length);
    let peak = -120;
    let off = 0;
    for (; off + FRAME <= x.length; off += FRAME) {
      const frame = x.subarray(off, off + FRAME);
      let sum = 0;
      for (const v of frame) sum += v * v;
      const db = 20 * Math.log10(Math.sqrt(sum / FRAME) + 1e-9);
      peak = Math.max(peak, db);
      this.vad(frame, db);
    }
    this.rest = x.slice(off);
    return peak;
  }

  /** Cierra la frase en curso, si la hay. */
  flush() {
    if (this.speaking) this.endSegment();
  }

  /** Olvida el piso de ruido (al volver a encender el micrófono). */
  resetNoise() {
    this.noiseDb = -60;
    this.rest = new Float32Array(0);
  }

  private vad(frame: Float32Array, db: number) {
    const o = this.opts;
    // Piso de ruido: baja rápido y sube despacio, para no confundir voz con ruido.
    if (!this.speaking) this.noiseDb = db < this.noiseDb ? db : this.noiseDb * 0.995 + db * 0.005;
    const voiced = db > Math.max(this.noiseDb + 10, -55);
    if (!this.speaking) {
      this.preroll.push(frame);
      if (this.preroll.length > o.prerollFrames) this.preroll.shift();
      this.voicedRun = voiced ? this.voicedRun + 1 : 0;
      if (this.voicedRun >= o.startFrames) {
        this.speaking = true;
        this.silentRun = 0;
        this.seg = [...this.preroll];
        this.segDb = this.preroll.map(() => Infinity);
        this.segSamples = this.seg.length * FRAME;
        this.segMinDb = db;
        this.preroll = [];
      }
      return;
    }
    this.seg.push(frame);
    this.segDb.push(db);
    this.segSamples += FRAME;
    this.segMinDb = Math.min(this.segMinDb, db);
    this.silentRun = voiced ? 0 : this.silentRun + 1;
    if (this.silentRun >= o.endFrames) this.endSegment();
    else if (this.segSamples >= o.maxSeconds * RATE) {
      // Llegó al tope sin una sola pausa: con ruido constante (aire acondicionado,
      // ventiladores) por encima del piso aprendido, todo parece voz y el piso no
      // se actualiza mientras "habla". Lo más bajo de la frase es el ruido real.
      this.noiseDb = Math.max(this.noiseDb, this.segMinDb);
      this.splitAtQuietest();
    }
  }

  /**
   * Quien lee de corrido no hace pausas de medio segundo: la frase llega al
   * tope y cortarla ahí parte palabras ("mientras hablo esta | [app] transcribe").
   * Se corta en el tramo más silencioso de los últimos splitFrames (el hueco
   * entre dos palabras) y lo que sigue abre la frase siguiente.
   */
  private splitAtQuietest() {
    let at = this.seg.length;
    let min = Infinity;
    for (let i = Math.max(1, this.seg.length - this.opts.splitFrames); i < this.seg.length; i++) {
      if (this.segDb[i] < min) { min = this.segDb[i]; at = i; }
    }
    const rest = this.seg.splice(at);
    const restDb = this.segDb.splice(at);
    this.segSamples = this.seg.length * FRAME;
    this.endSegment();
    if (!rest.length) return;
    this.speaking = true;
    this.silentRun = 0;
    this.seg = rest;
    this.segDb = restDb;
    this.segSamples = rest.length * FRAME;
    this.segMinDb = Math.min(...restDb);
  }

  private endSegment() {
    this.speaking = false;
    this.voicedRun = 0;
    if (this.segSamples >= this.opts.minSeconds * RATE) {
      const audio = new Float32Array(this.segSamples);
      let at = 0;
      for (const f of this.seg) { audio.set(f, at); at += f.length; }
      this.onSegment(audio);
    }
    this.seg = [];
    this.segDb = [];
    this.segSamples = 0;
  }
}

/** Tokens máximos por tramo: unos 8 por segundo de audio. Un bucle no puede crecer más allá. */
export const maxTokens = (samples: number) => Math.min(160, Math.ceil((samples / RATE) * 8) + 10);

/**
 * Frases que Whisper inventa sobre silencio o ruido; no son de quien habla.
 * Incluye una dirección web sola ("www.apet.com"): sale del ruido al final.
 */
const HALLUCINATION = /amara\.org|subt[ií]tul|suscr[ií]b|gracias por ver|^\s*[[(].*[\])]\s*$|^[\s\p{P}]*$|^\s*(?:www\.|https?:\/\/)\S+\s*$/iu;

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

/**
 * Términos que salen en casi cualquier charla de testalk. Sin contexto, Whisper
 * base escribe "polcador", "Vuelletin" o "de asset"; con él, bien.
 */
export const BASE_VOCAB = 'Polkadot, Polkadot App, Asset Hub, Bulletin, blockchain, hash, wallet, código QR.';

/** Contexto para Whisper: el vocabulario base más lo que agregue quien presenta (evento, nombres, siglas). */
export function vocabPrompt(...extra: string[]): string {
  return [BASE_VOCAB, ...extra.map(e => e.trim()).filter(Boolean)].join(' ');
}
