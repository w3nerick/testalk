/**
 * Diagnóstico: prueba cada pieza de la plataforma desde dentro del contenedor
 * y deja un reporte copiable. Idea tomada de chirp (TWR.DOT): medir en el
 * dispositivo antes de culpar al host o de confiar en un valor de retorno.
 */
import { isInsideContainerSync, requestPermission } from '@parity/product-sdk-host';
import { cryptoWaitReady, signatureVerify } from '@polkadot/util-crypto';
import { hexToU8a } from '@polkadot/util';
import { icon } from '../lib/icons';
import { waitForHost, withTimeout, TIMED_OUT, describeError } from '../lib/host';
import { getClient, hashVia, hashAtHeight, subscribeFinalized, type Block } from '../lib/chain';
import { connectSpeaker, currentSpeaker, signBytes } from '../lib/signer';
import { fetchReceipt, prepareBulletin, uploadArtifact } from '../lib/bulletin';
import { cidForBytes, preimageKeyFromCid } from '../lib/artifact';
import { IPFS_GATEWAY, PUBLIC_WS } from '../lib/network';
import { STT_URL } from '../lib/stt';
import { esc, toast, topbar, type Cleanup } from '../ui';

type Status = 'yes' | 'no' | 'skip' | 'run';
interface Line { name: string; status: Status; detail: string; ms?: number }

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t0 = performance.now();
  const v = await fn();
  return [v, Math.round(performance.now() - t0)];
}

export function renderDiagnostics(root: HTMLElement): Cleanup {
  const lines: Line[] = [];
  let dead = false;

  root.innerHTML = `${topbar()}
    <main class="shell verify">
      <section class="card verdict pending">
        <span class="badge">${icon('question')}</span>
        <h1>Diagnóstico</h1>
        <p class="title">Comprueba cada pieza del devnet desde este dispositivo. Pruébalo en Polkadot Desktop y en el celular.</p>
        <div class="actions">
          <button class="btn primary" id="run">${icon('play')}Probar</button>
          <button class="btn" id="run-bulletin">${icon('fileArrowUp')}Probar con subida a Bulletin</button>
        </div>
        <p class="faint" style="font-size:13px;margin:0">La prueba con subida pide una firma y escribe ~60 bytes en Bulletin (tarda hasta 1 min).</p>
      </section>
      <section class="card checks" id="out"><div class="chk wait">${icon('question')}<b>Sin ejecutar</b><p>Pulsa Probar.</p></div></section>
      <div class="actions"><button class="btn" id="copy" disabled>${icon('copy')}Copiar reporte</button></div>
    </main>`;

  const out = root.querySelector<HTMLElement>('#out')!;
  const copy = root.querySelector<HTMLButtonElement>('#copy')!;
  const tone = { yes: 'ok', no: 'bad', skip: 'warn', run: 'wait' } as const;
  const ic = { yes: 'checkCircle', no: 'xCircle', skip: 'warningCircle', run: 'circleNotch' } as const;
  const draw = () => {
    out.innerHTML = lines
      .map(l => `<div class="chk ${tone[l.status]}">${icon(ic[l.status], l.status === 'run' ? 'spin' : '')}<b>${esc(l.name)}${l.ms !== undefined ? ` <span class="faint mono" style="font-weight:400">${l.ms} ms</span>` : ''}</b><p>${esc(l.detail)}</p></div>`)
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
        const domains = ['localhost', new URL(IPFS_GATEWAY).hostname, ...PUBLIC_WS.map(u => new URL(u).hostname)];
        const r = await withTimeout(requestPermission({ tag: 'Remote', value: { domains } }), 8000);
        if (r === TIMED_OUT) return ['no', 'sin respuesta'];
        return r.ok && r.value ? ['yes', domains.join(', ')] : ['no', JSON.stringify(r)];
      });
    }

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

    await step('Transcriptor local', async () =>
      new Promise<[Status, string]>(resolve => {
        let ws: WebSocket;
        const t = setTimeout(() => { try { ws.close(); } catch { /* nada */ } resolve(['skip', `${STT_URL} no respondió (¿está corriendo?)`]); }, 5000);
        try {
          ws = new WebSocket(STT_URL);
          ws.onopen = () => { clearTimeout(t); ws.close(); resolve(['yes', `${STT_URL} abierto`]); };
          ws.onerror = () => { clearTimeout(t); resolve(['no', 'conexión rechazada o bloqueada por el contenedor']); };
        } catch (e) {
          clearTimeout(t);
          resolve(['no', String(e)]);
        }
      }));

    await step('Gateway IPFS', async () => {
      const r = await fetch(IPFS_GATEWAY.replace(/\/ipfs$/, '/'), { signal: AbortSignal.timeout(10_000) }).catch(e => e as Error);
      return r instanceof Error ? ['no', r.message] : ['yes', `responde (HTTP ${r.status} en la raíz)`];
    });

    await step('Wallet (SignerManager)', async () => {
      const sp = currentSpeaker() ?? (await connectSpeaker());
      return ['yes', `${sp.username ?? 'sin username'} · ${sp.address}${sp.rehearsal ? ' · ensayo' : ''}`];
    });

    const sp = currentSpeaker();
    if (sp) {
      await step('Firma de bytes (signRaw)', async () => {
        const msg = new TextEncoder().encode(`testalk diagnóstico ${new Date().toISOString()}`);
        const sig = await signBytes(msg);
        await cryptoWaitReady();
        const v = signatureVerify(msg, hexToU8a(sig), hexToU8a(sp.pubkey));
        return v.isValid ? ['yes', `${v.crypto}${v.isWrapped ? ', envuelta en <Bytes>' : ''}`] : ['no', 'la firma no valida contra la llave'];
      });
    }

    if (withBulletin && inside && !sp?.rehearsal) {
      await step('Bulletin: cuota y permiso', async () => { await prepareBulletin(); return ['yes', 'PreimageSubmit concedido']; });
      const bytes = new TextEncoder().encode(JSON.stringify({ testalk: 'diagnóstico', at: new Date().toISOString() }));
      const cid = cidForBytes(bytes);
      await step('Bulletin: subida', async () => { await uploadArtifact(bytes); return ['yes', cid]; });
      await step('Bulletin: lectura', async () => {
        const back = await fetchReceipt(cid, preimageKeyFromCid(cid));
        if (!back) return ['no', 'no se pudo leer lo recién subido'];
        return cidForBytes(back) === cid ? ['yes', `${back.length} bytes idénticos`] : ['no', 'los bytes no coinciden'];
      });
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
