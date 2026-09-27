// Precarga para scripts/bench-stt.ts: corre el build web de transformers.js
// (onnxruntime-web, WASM) dentro de Node, el mismo motor que usa la app en el
// navegador. onnxruntime-node 1.30 ya no trae binario para Mac Intel.
//   node --import ./scripts/ort-web-node.mjs scripts/bench-stt.ts …
// Los modelos quedan en app/.stt-cache (o en STT_CACHE).
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const root = process.cwd();
const webUrl = pathToFileURL(`${root}/node_modules/@huggingface/transformers/dist/transformers.web.js`).href;
register('data:text/javascript,' + encodeURIComponent(
  `export async function resolve(s, c, n) { return s === '@huggingface/transformers' ? { url: ${JSON.stringify(webUrl)}, shortCircuit: true } : n(s, c); }`));

// El build web decide en qué entorno está al cargarse: que no se vea como Node,
// así usa onnxruntime-web (WASM) en vez de onnxruntime-node.
const release = process.release;
Object.defineProperty(process, 'release', { value: { ...release, name: 'bench' }, configurable: true });
const { env } = await import(webUrl);
Object.defineProperty(process, 'release', { value: release, configurable: true });

// fetch() de Node no lee file://: el .wasm se entrega ya leído. Un solo hilo:
// los hilos de onnxruntime-web no arrancan en Node.
const ortDist = `${root}/node_modules/onnxruntime-web/dist/`;
env.allowLocalModels = false;
env.useWasmCache = false;
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.wasmPaths = { mjs: pathToFileURL(ortDist + 'ort-wasm-simd-threaded.asyncify.mjs').href };
env.backends.onnx.wasm.wasmBinary = await readFile(ortDist + 'ort-wasm-simd-threaded.asyncify.wasm');

// Caché de modelos en disco (el build web solo sabe usar la del navegador).
const dir = process.env.STT_CACHE ?? join(root, '.stt-cache');
const file = key => join(dir, createHash('sha256').update(typeof key === 'string' ? key : key.url).digest('hex'));
env.useBrowserCache = false;
env.useCustomCache = true;
env.customCache = {
  async match(key) {
    try { return new Response(await readFile(file(key))); } catch { return undefined; }
  },
  async put(key, res) {
    await mkdir(dir, { recursive: true });
    await writeFile(file(key), Buffer.from(await res.arrayBuffer()));
  },
};
