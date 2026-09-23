import { defineConfig } from 'vite';

// base relativo: la app se sirve desde su content hash en Bulletin, no desde /.
export default defineConfig({
  base: './',
  build: { target: 'es2022' },
});
