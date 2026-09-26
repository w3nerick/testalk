import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';

const read = (rel: string) => readFileSync(new URL(`./node_modules/${rel}`, import.meta.url), 'utf8');
const version = (pkg: string) => JSON.parse(read(`${pkg}/package.json`)).version as string;

/**
 * Versiones del SDK y del protocolo host ↔ app, visibles en #/diagnostico.
 * El host y la app deben hablar el mismo códec de truapi: Polkadot Desktop 0.1.3
 * (host-api 0.9.4) habla el 1; truapi 0.16 en adelante habla el 2 y el host
 * descarta sus peticiones sin responder.
 */
const sdk = {
  host: version('@parity/product-sdk-host'),
  signer: version('@parity/product-sdk-signer'),
  truapi: version('@parity/truapi'),
  codec: Number(/TRUAPI_CODEC_VERSION = (\d+)/.exec(read('@parity/truapi/dist/generated/client.js'))?.[1] ?? 0),
};

/**
 * El motor ONNX de Whisper trae `new URL("ort-wasm-…wasm", import.meta.url)` y
 * Vite copiaba ese wasm de 27 MB a dist/, aunque nunca se descarga de ahí:
 * transformers.js fija `wasmPaths` a jsDelivr al importarse. Se apunta la
 * referencia a esa misma URL y el bundle baja de ~28 MB a ~2 MB. Si una versión
 * nueva de onnxruntime-web cambia la forma de la referencia, el build falla en
 * vez de volver a subir el wasm a Bulletin sin avisar.
 */
function ortWasmFromCdn(): Plugin {
  const cdn = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${version('onnxruntime-web')}/dist/`;
  return {
    name: 'testalk:ort-wasm-from-cdn',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('/onnxruntime-web/dist/')) return;
      const out = code.replace(/new URL\((["'])(ort-[\w.-]+\.wasm)\1,\s*import\.meta\.url\)/g, (_, _q, file) => `new URL(${JSON.stringify(cdn + file)})`);
      return out === code ? undefined : { code: out, map: null };
    },
    generateBundle(_, bundle) {
      const wasm = Object.keys(bundle).filter(f => f.endsWith('.wasm'));
      if (wasm.length) this.error(`wasm en el bundle: ${wasm.join(', ')}`);
    },
  };
}

// base relativo: la app se sirve desde su content hash en Bulletin, no desde /.
export default defineConfig({
  base: './',
  build: { target: 'es2022' },
  define: { __SDK__: JSON.stringify(sdk) },
  plugins: [ortWasmFromCdn()],
  worker: { plugins: () => [ortWasmFromCdn()] },
});
