/**
 * Diagnóstico: prueba cada pieza de la plataforma desde dentro del contenedor
 * y deja un reporte copiable. Idea tomada de chirp (TWR.DOT): medir en el
 * dispositivo antes de culpar al host o de confiar en un valor de retorno.
 */
import { getAccountsProvider, isChainSupported, isInsideContainerSync, requestDevicePermission, requestPermission } from '@parity/product-sdk-host';
import { cryptoWaitReady, encodeAddress, signatureVerify } from '@polkadot/util-crypto';
import { hexToU8a } from '@polkadot/util';
import { icon } from '../lib/icons';
import { waitForHost, withTimeout, TIMED_OUT, describeError, HOST_QUERY_MS } from '../lib/host';
import { ASSET_HUB_GENESIS, getClient, hashVia, hashAtHeight, subscribeFinalized, type Block } from '../lib/chain';
import { connectSpeaker, currentSpeaker, hasIdentitySigner, identityUnavailableReason, keyFor, signBytes, type SignerKind } from '../lib/signer';
import { lookupViaHost, prepareBulletin, uploadArtifact, viaGateway } from '../lib/bulletin';
import { cidForBytes } from '../lib/artifact';
import { IPFS_GATEWAY, PEOPLE_GENESIS } from '../lib/network';
import { usernameOwner } from '../lib/people';
import { readSeal } from '../lib/registry';
import { remoteDomains, requestHostPermissions } from '../lib/permissions';
import { STT_URL } from '../lib/stt';
import { esc, tag, toast, topbar, type Cleanup } from '../ui';

type Status = 'yes' | 'no' | 'skip' | 'run';
interface Line { name: string; status: Status; detail: string; ms?: number }

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t0 = performance.now();
  const v = await fn();
  return [v, Math.round(performance.now() - t0)];
}

/** Huella del primer recibo sellado en TalkRegistry (charla "Test", 24 sep 2026, bloque #13,649,506). */
const KNOWN_SEAL = '0xaa92853edc1f3e59d3dacc1ff0d2517f70ddf7787cc23dd554ebca3847918e2c';

export function renderDiagnostics(root: HTMLElement): Cleanup {
  const lines: Line[] = [];
  let dead = false;
  requestHostPermissions({ localhost: true });

  root.innerHTML = `${topbar()}
    <main class="shell verify">
      <section class="card verdict pending">
        <h1>Diagnóstico</h1>
        <p class="title">Comprueba cada pieza del devnet desde este dispositivo. Pruébalo en Polkadot Desktop y en el celular.</p>
        <div class="actions">
          <button class="btn primary" id="run">${icon('play')}Probar</button>
          <button class="btn" id="run-bulletin">${icon('fileArrowUp')}Probar con subida a Bulletin</button>
        </div>
        <p class="faint" style="font-size:13px;margin:0">Te pedirá el micrófono: cuando aparezca "grabando", habla unos segundos. La prueba con subida además pide una firma y escribe ~60 bytes en Bulletin (tarda de 1 a 3 min).</p>
      </section>
      <section class="card checks" id="out"><div class="chk idle">${tag('idle')}<b>Sin ejecutar</b><p>Pulsa Probar.</p></div></section>
      <div class="actions"><button class="btn" id="copy" disabled>${icon('copy')}Copiar reporte</button></div>
    </main>`;

  const out = root.querySelector<HTMLElement>('#out')!;
  const copy = root.querySelector<HTMLButtonElement>('#copy')!;
  const tone = { yes: 'ok', no: 'bad', skip: 'warn', run: 'wait' } as const;
  const draw = () => {
    out.innerHTML = lines
      .map(l => `<div class="chk ${tone[l.status]}">${tag(tone[l.status])}<b>${esc(l.name)}${l.ms !== undefined ? ` <span class="faint mono" style="font-weight:400">${l.ms} ms</span>` : ''}</b><p>${esc(l.detail)}</p></div>`)
      .join('');
  };
  const step = async (name: string, fn: () => Promise<[Status, string]>) => {
    if (dead) return;
    const l: Line = { name, status: 'run', detail: '…' };
    lines.push(l);
    draw();
    try {
      const [[status, detail], ms] = await timed(fn);
      Object.assign(l, { status, detail, ms });
    } catch (e) {
      Object.assign(l, { status: 'no', detail: describeError(e instanceof Error ? e.message : e) });
    }
    draw();
  };

  const run = async (withBulletin: boolean) => {
    lines.length = 0;
    copy.disabled = true;
    const inside = isInsideContainerSync();

    await step('Contenedor', async () => [inside ? 'yes' : 'skip', inside ? 'Dentro de Polkadot App / Desktop' : 'Navegador normal: modo ensayo']);
    if (inside) await step('Canal con el host', async () => ((await waitForHost()) ? ['yes', 'connected'] : ['no', 'no llegó a connected en 12 s']));
    if (inside) {
      await step('Permiso de red (Remote)', async () => {
        const domains = remoteDomains(true);
        const r = await withTimeout(requestPermission({ tag: 'Remote', value: { domains } }), 8000);
        if (r === TIMED_OUT) return ['no', 'sin respuesta'];
        return r.ok && r.value ? ['yes', domains.join(', ')] : ['no', JSON.stringify(r)];
      });
    }

    if (inside) {
      for (const [name, genesis] of [['Asset Hub', ASSET_HUB_GENESIS], ['People chain', PEOPLE_GENESIS]] as const) {
        await step(`El host sirve ${name}`, async () => {
          const r = await withTimeout(isChainSupported(genesis), HOST_QUERY_MS);
          if (r === TIMED_OUT) return ['no', 'sin respuesta'];
          // ok=false: no se pudo preguntar, que no es lo mismo que "no la sirve".
          if (!r.ok) return ['skip', `no se pudo preguntar: ${describeError(r.error)}`];
          return r.value ? ['yes', 'isChainSupported: sí'] : ['no', 'isChainSupported: no (se usará el RPC público)'];
        });
      }
      await step('Micrófono: permiso del host', async () => {
        const r = await withTimeout(requestDevicePermission('Microphone'), 30_000);
        if (r === TIMED_OUT) return ['no', 'el host no respondió'];
        if (!r.ok) return ['no', describeError(r.error)];
        return r.value ? ['yes', 'concedido'] : ['no', 'denegado'];
      });
    }
    await step('Micrófono: grabando 4 s, habla ahora', () => recordProbe());
    await step('Aceleración para Whisper en la app', async () => {
      const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
      const adapter = gpu ? await gpu.requestAdapter().catch(() => null) : null;
      return adapter
        ? ['yes', 'WebGPU disponible: la transcripción dentro de la app sería fluida']
        : ['skip', 'Sin WebGPU: Whisper correría en CPU (WASM), más lento'];
    });

    let first: Block | null = null;
    await step('Asset Hub: bloque finalizado', async () => {
      first = await new Promise<Block | null>(resolve => {
        let unsub: (() => void) | undefined;
        let got: Block | null = null;
        const t = setTimeout(() => { unsub?.(); resolve(null); }, 30_000);
        subscribeFinalized(
          b => {
            if (got) return;
            got = b;
            clearTimeout(t);
            unsub?.();
            resolve(b);
          },
          () => resolve(null),
        )
          .then(u => { unsub = u; if (got) u(); })
          .catch(() => resolve(null));
      });
      return first ? ['yes', `#${(first as Block).number.toLocaleString('en-US')}`] : ['no', 'ningún bloque en 30 s'];
    });

    if (first) {
      const n = (first as Block).number - 100;
      await step('Hash por altura (cliente principal)', async () => {
        const h = await hashVia(await getClient(), n);
        return h ? ['yes', `#${n} ${h.slice(0, 18)}…`] : ['skip', 'el provider no sirve consultas históricas'];
      });
      await step('Hash por altura (con respaldo)', async () => {
        const h = await hashAtHeight(n);
        return h ? ['yes', `#${n} ${h.slice(0, 18)}…`] : ['no', 'ni host ni RPC público respondieron'];
      });
    }

    await step('TalkRegistry (cliente principal)', async () => {
      const seal = await withTimeout(readSeal(await getClient(), KNOWN_SEAL), 20_000);
      if (seal === TIMED_OUT) return ['no', 'sin respuesta en 20 s'];
      return seal
        ? ['yes', `sello conocido en el bloque #${Number(seal.blockNumber).toLocaleString('en-US')}`]
        : ['no', 'el registro respondió que no existe el sello conocido'];
    });

    await step('Transcriptor local', async () =>
      new Promise<[Status, string]>(resolve => {
        let ws: WebSocket;
        const t = setTimeout(() => { try { ws.close(); } catch { /* nada */ } resolve(['skip', `${STT_URL} no respondió (¿está corriendo?)`]); }, 5000);
        try {
          ws = new WebSocket(STT_URL);
          ws.onopen = () => { clearTimeout(t); ws.close(); resolve(['yes', `${STT_URL} abierto`]); };
          ws.onerror = () => { clearTimeout(t); resolve(['no', 'no conecta: ¿está corriendo stt/testalk_stt.py? Dentro del contenedor también puede ser un bloqueo de red']); };
        } catch (e) {
          clearTimeout(t);
          resolve(['no', String(e)]);
        }
      }));

    await step('Gateway IPFS', async () => {
      const r = await fetch(IPFS_GATEWAY.replace(/\/ipfs$/, '/'), { signal: AbortSignal.timeout(10_000) }).catch(e => e as Error);
      return r instanceof Error ? ['no', r.message] : ['yes', `responde (HTTP ${r.status} en la raíz)`];
    });

    if (inside) {
      await step('Cuentas del wallet (getLegacyAccounts)', async () => {
        const ap = await withTimeout(getAccountsProvider(), HOST_QUERY_MS);
        if (ap === TIMED_OUT || !ap) return ['no', 'el host no entregó el proveedor de cuentas'];
        const r = await withTimeout(Promise.resolve(ap.getLegacyAccounts()), HOST_QUERY_MS);
        if (r === TIMED_OUT) return ['no', 'sin respuesta'];
        if (r.isErr()) return ['no', describeError(r.error)];
        // Desktop no enumera cuentas por diseño (según el SDK): cero no es un error.
        return [r.value.length ? 'yes' : 'skip', `${r.value.length} cuenta(s) del wallet visibles para la app`];
      });
    }

    await step('Wallet (SignerManager)', async () => {
      const sp = currentSpeaker() ?? (await connectSpeaker());
      const kind = { identity: 'firmará con la identidad .dot', app: 'firmará con la cuenta de la app', rehearsal: 'ensayo' }[sp.kind];
      return ['yes', `${sp.username ?? 'sin username'} · ${sp.address} · ${kind}`];
    });

    const sp = currentSpeaker();
    if (sp && inside) {
      await step('Username en People chain', async () => {
        if (!sp.username) return ['skip', 'la cuenta no tiene username'];
        const owner = await usernameOwner(sp.username);
        return owner
          ? ['yes', `${sp.username} → ${encodeAddress(hexToU8a(owner), 42)}`]
          : ['no', `${sp.username} no aparece en Resources.UsernameOwnerOf`];
      });
    }
    const signProbe = (kind: SignerKind) => async (): Promise<[Status, string]> => {
      const key = keyFor(kind);
      if (!key) return ['skip', 'sin llave para este camino'];
      const msg = new TextEncoder().encode(`testalk diagnóstico ${new Date().toISOString()}`);
      const sig = await signBytes(msg, kind);
      await cryptoWaitReady();
      const v = signatureVerify(msg, hexToU8a(sig), hexToU8a(key));
      return v.isValid ? ['yes', `${v.crypto}${v.isWrapped ? ', envuelta en <Bytes>' : ''}`] : ['no', 'la firma no valida contra la llave'];
    };
    if (sp && inside) {
      if (hasIdentitySigner()) await step('Firma con identidad .dot (signRawWithLegacyAccount)', signProbe('identity'));
      else await step('Firma con identidad .dot', async () => ['skip', identityUnavailableReason() ?? 'no disponible']);
    }
    if (sp) await step(sp.rehearsal ? 'Firma de ensayo (signRaw)' : 'Firma con la cuenta de la app (signRaw)', signProbe(sp.rehearsal ? 'rehearsal' : 'app'));

    if (withBulletin && inside && !sp?.rehearsal) {
      await step('Bulletin: cuota y permiso', async () => { await prepareBulletin(); return ['yes', 'PreimageSubmit concedido']; });
      const bytes = new TextEncoder().encode(JSON.stringify({ testalk: 'diagnóstico', at: new Date().toISOString() }));
      const cid = cidForBytes(bytes);
      let key: `0x${string}` | null = null;
      await step('Bulletin: subida y clave', async () => {
        key = await uploadArtifact(bytes);
        return ['yes', `la clave devuelta es el blake2b-256 de los bytes (${key.slice(0, 12)}…) · ${cid}`];
      });
      if (key) {
        const k = key;
        await step('Bulletin: lectura por el host', async () => {
          const back = await lookupViaHost(k, 20_000);
          if (!back) return ['no', 'el host no la encontró en 20 s'];
          return cidForBytes(back) === cid ? ['yes', `${back.length} bytes idénticos`] : ['no', 'los bytes no coinciden'];
        });
        await step('Bulletin: lectura por el gateway IPFS', async () => {
          const back = await viaGateway(cid);
          // Las docs dicen que las lecturas son solo dentro del contenedor: un "no" aquí es esperable.
          if (!back) return ['skip', 'el gateway no la sirve: fuera de un contenedor el recibo no se puede leer por CID'];
          return cidForBytes(back) === cid ? ['yes', `${back.length} bytes idénticos`] : ['no', 'los bytes no coinciden'];
        });
      }
    } else if (withBulletin) {
      await step('Bulletin', async () => ['skip', 'solo dentro de Polkadot App con wallet real']);
    }

    copy.disabled = false;
  };

  root.querySelector('#run')!.addEventListener('click', () => run(false));
  root.querySelector('#run-bulletin')!.addEventListener('click', () => run(true));
  copy.addEventListener('click', () => {
    const txt = [`testalk diagnóstico ${new Date().toISOString()}`, navigator.userAgent, '']
      .concat(lines.map(l => `[${l.status.toUpperCase().padEnd(4)}] ${l.name}${l.ms !== undefined ? ` (${l.ms} ms)` : ''}: ${l.detail}`))
      .join('\n');
    navigator.clipboard?.writeText(txt).then(() => toast('Reporte copiado'), () => toast('No se pudo copiar'));
  });

  return () => { dead = true; };
}

/**
 * Graba 4 s con getUserMedia + MediaRecorder y mide el nivel. Dice tres cosas:
 * si el contenedor entrega el micrófono, en qué formato graba y si se oyó algo.
 */
async function recordProbe(): Promise<[Status, string]> {
  if (!navigator.mediaDevices?.getUserMedia) return ['no', 'getUserMedia no existe en este contenedor'];
  const got = await withTimeout(
    navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false } }),
    30_000,
  );
  if (got === TIMED_OUT) return ['no', 'el contenedor no entregó el micrófono en 30 s'];
  const stream = got;
  const ctx = new AudioContext();
  const an = ctx.createAnalyser();
  an.fftSize = 2048;
  ctx.createMediaStreamSource(stream).connect(an);
  const buf = new Float32Array(an.fftSize);
  let peak = 0;
  const meter = setInterval(() => {
    an.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    peak = Math.max(peak, Math.sqrt(sum / buf.length));
  }, 100);

  let bytes = 0;
  let mime = '';
  try {
    if (typeof MediaRecorder === 'undefined') {
      await new Promise(r => setTimeout(r, 4000));
    } else {
      const type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find(t => MediaRecorder.isTypeSupported?.(t));
      const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      rec.ondataavailable = e => { bytes += e.data.size; };
      const stopped = new Promise(r => { rec.onstop = r; });
      rec.start(1000);
      await new Promise(r => setTimeout(r, 4000));
      rec.stop();
      await stopped;
      mime = rec.mimeType;
    }
  } finally {
    clearInterval(meter);
    stream.getTracks().forEach(t => t.stop());
    ctx.close().catch(() => undefined);
  }

  const dbfs = peak > 0 ? Math.round(20 * Math.log10(peak)) : -Infinity;
  const level = `pico ${Number.isFinite(dbfs) ? dbfs : '-∞'} dBFS${peak < 0.01 ? ' (casi silencio: ¿hablaste?)' : ''}`;
  if (typeof MediaRecorder === 'undefined') return ['skip', `audio llega (${level}) pero no hay MediaRecorder`];
  return bytes > 0 ? ['yes', `${mime || 'formato por defecto'}, ${Math.round(bytes / 1024)} KB, ${level}`] : ['no', `no se grabaron datos (${level})`];
}
