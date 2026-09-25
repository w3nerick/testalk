/**
 * Config de producto para `pad`. Sin este archivo el deploy sube el contenido
 * pero no escribe el manifest ni los text records en DotNS.
 * `icon` es obligatorio y solo acepta png o jpeg.
 */
export default {
  domain: 'devnet-test-talk26.dot',
  displayName: 'testalk',
  description: 'Graba tu charla, ánclala a bloques de Polkadot y fírmala con tu wallet.',
  icon: { path: './icon.png', format: 'png' },
  executables: [
    { kind: 'app', path: './dist', appVersion: [0, 1, 0] },
  ],
};
