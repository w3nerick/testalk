/**
 * Ícono de testalk, generado y no dibujado: la onda ASCII de la portada
 * congelada, con un bloque clavado en el centro. Tu voz, anclada a Polkadot.
 *
 * Usa el mismo RAMP que src/lib/ascii.ts y los glifos de Space Mono
 * convertidos a trazos, así los SVG no dependen de ninguna fuente.
 *
 *   npm run icon                  escribe los archivos del repo
 *   npm run icon -- --out /tmp/x  los escribe en otra carpeta para probar
 *
 * Salida:
 *   icon.png, public/icon.png  512 px, ícono de la app (pad, README)
 *   brand/icon.svg             el mismo en vector, para diapositivas
 *   brand/favicon.svg          versión chica en píxeles con fondo: a 16-32 px
 *   brand/favicon-32.png       los caracteres serían ruido, así que la onda
 *                              pasa a barras con la misma silueta
 *   brand/mark.svg             la versión chica en currentColor, sin fondo,
 *                              para la barra superior (cambia con el tema)
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import opentype from 'opentype.js';
import resvg from '@resvg/resvg-js';
import { RAMP } from '../src/lib/ascii.ts';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const outArg = process.argv.indexOf('--out');
const OUT = outArg > 0 ? process.argv[outArg + 1] : APP;

const INK = '#111111';
const PAPER = '#f5f2eb';
const MUTED = '#9a978f';
const GLYPH = '#cfcbc1'; // más claro que MUTED: a 64 px la textura tiene que seguir viéndose

/**
 * Una frase corta, irregular como la voz. Cada número es el volumen de una
 * columna (0 a 1); `null` es el poste del bloque.
 */
const VOICE: (number | null)[] = [0.2, 0.72, 0.45, 0.97, 0.7, 0.44, null, 0.46, 1, 0.74, 0.42, 0.68, 0.18];
const POST = VOICE.indexOf(null);

// Space Mono Bold: a tamaño de ícono el peso regular se deshace.
const woff = readFileSync(join(APP, 'node_modules/@fontsource/space-mono/files/space-mono-latin-700-normal.woff'));
const mono = opentype.parse(woff.buffer.slice(woff.byteOffset, woff.byteOffset + woff.byteLength) as ArrayBuffer);

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Glifo del RAMP para una celda, con la misma fórmula que la onda de la portada. */
function glyphAt(amp: number, d: number, mid: number): string | null {
  const reach = amp * (mid + 0.5);
  if (d > reach) return null;
  const k = (1 - d / (reach + 0.001)) * amp;
  return RAMP[Math.min(RAMP.length - 1, 1 + Math.floor(k * (RAMP.length - 1)))];
}

/** Ícono grande: caracteres reales. */
function bigIcon(): string {
  const S = 512;
  const ROWS = 7;
  const mid = (ROWS - 1) / 2;
  const F = 49; // px por em
  const CW = (F * 612) / 1000; // avance de Space Mono: 612/1000
  const LH = F * 0.8;
  const GAP = CW * 2.4; // el poste ocupa más que una columna: el bloque es el protagonista
  const W = (VOICE.length - 1) * CW + GAP;
  const H = ROWS * LH;
  const x0 = (S - W) / 2;
  const y0 = (S - H) / 2;
  const colX = (c: number) => (c < POST ? x0 + c * CW : x0 + GAP + (c - 1) * CW);
  // Centro visual de los glifos del RAMP ≈ 0.33 em sobre la línea base.
  const baseline = (r: number) => y0 + r * LH + LH / 2 + 0.33 * F;

  const glyphs: string[] = [];
  VOICE.forEach((amp, c) => {
    if (amp === null) return;
    for (let r = 0; r < ROWS; r++) {
      const ch = glyphAt(amp, Math.abs(r - mid), mid);
      if (ch && ch !== ' ') glyphs.push(mono.getPath(ch, colX(c), baseline(r), F).toPathData(2));
    }
  });

  const cx = x0 + POST * CW + GAP / 2;
  const cy = y0 + H / 2;
  const postW = 8;
  // Sombra dura desplazada: la misma firma de los botones de la app.
  const SHADOW = 7;
  const block = CW * 1.9;
  const top = y0 - LH * 0.5;
  const bottom = y0 + H + LH * 0.5;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}">
  <title>testalk</title>
  <rect width="${S}" height="${S}" fill="${INK}"/>
  <path fill="${GLYPH}" d="${glyphs.join('')}"/>
  <rect x="${r2(cx - postW / 2)}" y="${r2(top)}" width="${postW}" height="${r2(bottom - top)}" fill="${PAPER}"/>
  <rect x="${r2(cx - block / 2 + SHADOW)}" y="${r2(cy - block / 2 + SHADOW)}" width="${r2(block)}" height="${r2(block)}" fill="${MUTED}"/>
  <rect x="${r2(cx - block / 2)}" y="${r2(cy - block / 2)}" width="${r2(block)}" height="${r2(block)}" fill="${PAPER}"/>
</svg>
`;
}

/**
 * Versión chica en una rejilla de 32 (a 16 px cada unidad es medio píxel):
 * tres barras a cada lado del poste, con la misma idea de la onda grande
 * (orillas bajas, un pico a cada lado) pero alturas pensadas para leerse a
 * ese tamaño. Números = media altura de cada barra.
 */
const SMALL_BARS = [3, 9, 6, 8, 10, 3];

function smallShapes(): { bars: string; post: string } {
  const C = 16;
  const xs = [2, 6, 10, 20, 24, 28];
  const bars = SMALL_BARS.map((h, i) => `M${xs[i]} ${C - h}h2v${2 * h}h-2z`).join('');
  // Poste de 2 de ancho casi a toda altura y el bloque de 6×6 en el centro,
  // separado una unidad de las barras vecinas.
  const post = `M15 3h2v26h-2zM13 13h6v6h-6z`;
  return { bars, post };
}

function favicon(): string {
  const { bars, post } = smallShapes();
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32" shape-rendering="crispEdges">
  <rect width="32" height="32" fill="${INK}"/>
  <path fill="${MUTED}" d="${bars}"/>
  <path fill="${PAPER}" d="${post}"/>
</svg>
`;
}

function mark(): string {
  const { bars, post } = smallShapes();
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" shape-rendering="crispEdges">
  <path fill="currentColor" opacity=".55" d="${bars}"/>
  <path fill="currentColor" d="${post}"/>
</svg>
`;
}

function png(svg: string, size: number): Buffer {
  return new resvg.Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
}

const write = (rel: string, data: string | Buffer) => {
  const p = join(OUT, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data);
  console.log(`  ${rel}`);
};

const big = bigIcon();
const fav = favicon();
console.log(`Ícono generado en ${OUT}:`);
write('brand/icon.svg', big);
write('icon.png', png(big, 512));
write('public/icon.png', png(big, 512));
write('brand/favicon.svg', fav);
write('brand/favicon-32.png', png(fav, 32));
write('brand/mark.svg', mark());
