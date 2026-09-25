import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

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

// base relativo: la app se sirve desde su content hash en Bulletin, no desde /.
export default defineConfig({
  base: './',
  build: { target: 'es2022' },
  define: { __SDK__: JSON.stringify(sdk) },
});
