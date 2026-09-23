// Consulta si un recibo está sellado en TalkRegistry. Solo lee.
//
//   npm run check -- ../examples/recibo.json
//   npm run check                              (resumen del registro)
import { readFileSync } from 'node:fs';
import { blake256Hex } from '../../app/src/lib/artifact.ts';
import { connect, registryAddress, readSeal, simulateCall, encode, decodeResult, hex } from './lib.mjs';

const dest = registryAddress();
if (!dest) { console.error('No hay contrato desplegado (falta contract/deployments.json).'); process.exit(1); }
const { client, api } = connect();

const file = process.argv[2];
if (!file) {
  const r = await simulateCall(api, dest, encode('total', []));
  console.log(`TalkRegistry ${dest}: ${decodeResult('total', hex(r.result.value.data))} recibos sellados`);
} else {
  const h = blake256Hex(new Uint8Array(readFileSync(file)));
  const s = await readSeal(api, dest, h);
  console.log(s
    ? `Sellado en el bloque #${s.blockNumber} (${new Date(Number(s.sealedAt) * 1000).toISOString()}), ancla inferior #${s.anchorBlock}, "${s.title}"`
    : `No está sellado: ${h}`);
  process.exitCode = s ? 0 : 1;
}
client.destroy();
