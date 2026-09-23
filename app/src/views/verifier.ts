import { icon, type IconName } from '../lib/icons';
import { ASSET_HUB_GENESIS, hashAtHeight } from '../lib/chain';
import {
  cidForBytes,
  preimageKeyFromCid,
  verifyBlocks,
  verifySignature,
  type Artifact,
  type BlocksCheck,
  type SigCheck,
} from '../lib/artifact';
import { fetchPreimage } from '../lib/bulletin';
import { esc, fmtDuration, shortAddr, toast, topbar, type Cleanup } from '../ui';
import { downloadJson } from './presenter';

let local: { artifact: Artifact; cid: string } | null = null;

/** El presentador deja aquí lo recién sellado para verificarlo sin pasar por Bulletin. */
export function setLocalArtifact(artifact: Artifact, cid: string) {
  local = { artifact, cid };
}

export function isCid(s: string): boolean {
  return /^b[a-z2-7]{50,}$/.test(s);
}

export function renderVerifier(root: HTMLElement, cid?: string): Cleanup {
  let dead = false;

  if (cid) {
    loading(root);
    const key = (() => { try { return preimageKeyFromCid(cid); } catch { return null; } })();
    if (!key) {
      failed(root, 'Ese enlace no contiene un CID válido.');
    } else {
      fetchPreimage(key)
        .then(bytes => {
          if (dead) return;
          if (!bytes) return failed(root, 'No se encontró el recibo en Bulletin. Puede haber expirado (Bulletin guarda 14 días).');
          let a: Artifact;
          try { a = JSON.parse(new TextDecoder().decode(bytes)); } catch { return failed(root, 'El recibo no es JSON válido.'); }
          show(root, a, cid, true);
        })
        .catch(e => !dead && failed(root, (e as Error).message));
    }
  } else if (local) {
    show(root, local.artifact, local.cid, false);
  } else {
    picker(root);
  }
  return () => { dead = true; };
}

function loading(root: HTMLElement) {
  root.innerHTML = `${topbar()}
    <main class="shell verify">
      <section class="card verdict pending">
        <span class="badge">${icon('circleNotch', 'spin')}</span>
        <h1>Buscando el recibo…</h1>
        <p class="title">Leyendo Bulletin a través de Polkadot App.</p>
      </section>
      <div class="skeleton" style="height:180px;border-radius:16px"></div>
    </main>`;
}

function failed(root: HTMLElement, msg: string) {
  root.innerHTML = `${topbar()}
    <main class="shell verify">
      <section class="card verdict bad">
        <span class="badge">${icon('warningCircle')}</span>
        <h1>No se pudo abrir el recibo</h1>
        <p class="title">${esc(msg)}</p>
      </section>
      <a class="btn" href="#/verificar">${icon('fileArrowUp')}Verificar un archivo</a>
    </main>`;
}

function picker(root: HTMLElement) {
  root.innerHTML = `${topbar()}
    <main class="shell verify">
      <section class="card verdict pending">
        <span class="badge">${icon('shieldCheck')}</span>
        <h1>Verificar un recibo</h1>
        <p class="title">Escanea el QR de una charla con Polkadot App, o sube aquí el archivo JSON.</p>
      </section>
      <label class="drop" id="drop">
        ${icon('fileArrowUp')}
        <b style="color:var(--text)">Suelta el recibo .json</b>
        <span style="font-size:14px">o toca para elegirlo</span>
        <input type="file" accept="application/json,.json" hidden id="file" />
      </label>
      <form class="card" id="cid-form" style="padding:20px;display:grid;gap:12px">
        <div class="field">
          <label for="cid">O pega un CID</label>
          <input class="input mono" id="cid" placeholder="bafk…" autocomplete="off" spellcheck="false" />
        </div>
        <button class="btn" type="submit">${icon('arrowRight')}Abrir</button>
      </form>
      <div id="err"></div>
    </main>`;

  const drop = root.querySelector<HTMLElement>('#drop')!;
  const err = root.querySelector<HTMLElement>('#err')!;
  const read = async (f: File) => {
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      show(root, JSON.parse(new TextDecoder().decode(bytes)), cidForBytes(bytes), false);
    } catch {
      err.innerHTML = `<div class="error-box">${icon('warningCircle')}Ese archivo no es un recibo válido.</div>`;
    }
  };
  root.querySelector<HTMLInputElement>('#file')!.addEventListener('change', e => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) read(f);
  });
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => {
    e.preventDefault();
    drop.classList.remove('over');
    const f = e.dataTransfer?.files?.[0];
    if (f) read(f);
  });
  root.querySelector('#cid-form')!.addEventListener('submit', e => {
    e.preventDefault();
    const v = (root.querySelector('#cid') as HTMLInputElement).value.trim();
    if (isCid(v)) location.hash = `#/${v}`;
    else err.innerHTML = `<div class="error-box">${icon('warningCircle')}Eso no parece un CID.</div>`;
  });
}

type Tone = 'ok' | 'bad' | 'warn' | 'wait';
const toneIcon: Record<Tone, IconName> = { ok: 'checkCircle', bad: 'xCircle', warn: 'warningCircle', wait: 'circleNotch' };

function row(tone: Tone, title: string, body: string): string {
  return `<div class="chk ${tone}">${icon(toneIcon[tone], tone === 'wait' ? 'spin' : '')}<b>${title}</b><p>${body}</p></div>`;
}

function show(root: HTMLElement, a: Artifact, cid: string, fromBulletin: boolean) {
  const dur = Date.parse(a.ended_at) - Date.parse(a.started_at);
  const rehearsal = (a as { rehearsal?: boolean }).rehearsal === true;
  const who = a.dotns || a.speaker || shortAddr(a.speaker_address ?? a.pubkey);

  root.innerHTML = `${topbar()}
    <main class="shell verify">
      <section class="card verdict pending" id="verdict">
        ${rehearsal ? `<span class="pill warn tag-rehearsal">Ensayo</span>` : ''}
        <span class="badge" id="badge">${icon('circleNotch', 'spin')}</span>
        <h1 id="headline">Verificando…</h1>
        <p class="title">${esc(a.title)}</p>
        <div class="meta">
          <div><span>Speaker</span><b>${esc(who)}</b></div>
          <div><span>Evento</span><b>${esc(a.venue || 'Sin especificar')}</b></div>
          <div><span>Horario</span><b class="mono">${esc(a.window || '')} · ${new Date(a.started_at).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' })}</b></div>
          <div><span>Duración</span><b class="mono">${Number.isFinite(dur) ? fmtDuration(dur) : 'n/d'}</b></div>
        </div>
      </section>
      <section class="card checks" id="checks">
        ${row('wait', 'Firma', 'Comprobando…')}
        ${row('wait', 'Bloques en la cadena', 'Esperando…')}
        ${audioRow(a)}
      </section>
      <section class="card timeline">
        <h2>Lo que se dijo</h2>
        ${a.chain
          .map(e => ('s' in e
            ? `<p class="s">${esc(e.s)}</p>`
            : `<span class="rivet">${icon('cube')}#${esc(e.blk)} · ${esc(e.time)}</span>`))
          .join('')}
      </section>
      <div class="actions">
        <button class="btn" id="dl">${icon('downloadSimple')}Descargar recibo</button>
        ${fromBulletin ? `<button class="btn" id="cp">${icon('copy')}Copiar CID</button>` : ''}
        <a class="btn ghost" href="#/verificar" id="other">${icon('fileArrowUp')}Otro recibo</a>
      </div>
      <p class="faint mono" style="font-size:12px;word-break:break-all;margin:0">CID ${esc(cid)}</p>
    </main>`;

  root.querySelector('#dl')!.addEventListener('click', () => downloadJson(a, cid));
  root.querySelector('#cp')?.addEventListener('click', () => navigator.clipboard?.writeText(cid).then(() => toast('CID copiado'), () => toast(cid)));
  root.querySelector('#other')!.addEventListener('click', ev => {
    // Si ya estamos en #/verificar el hash no cambia y no habría re-render.
    ev.preventDefault();
    local = null;
    if (location.hash === '#/verificar') picker(root);
    else location.hash = '#/verificar';
  });

  run(root, a);
}

function audioRow(a: Artifact): string {
  if (!a.audio) return row('warn', 'Grabación', 'Este recibo no incluye huella del audio.');
  return row(
    'ok',
    'Grabación sellada',
    `${Math.round(a.audio.seconds / 60)} min de audio. Huella blake2b-256 <span class="mono">${esc(a.audio.hash.slice(0, 18))}…</span>. El speaker conserva el archivo: si lo comparte, cualquiera puede comprobar que es el mismo.`,
  );
}

async function run(root: HTMLElement, a: Artifact) {
  const checks = root.querySelector<HTMLElement>('#checks')!;
  const sigEl = checks.children[0] as HTMLElement;

  const sig: SigCheck = await verifySignature(a);
  sigEl.outerHTML = sig.ok
    ? row('ok', 'Firma válida', `sr25519 de <span class="mono">${esc(shortAddr(a.speaker_address ?? a.pubkey))}</span>. Nadie cambió una sola letra desde que se firmó.`)
    : row('bad', 'Firma inválida', esc(sig.reason ?? 'La firma no corresponde.'));

  const blocksCount = a.chain.filter(e => 'full' in e).length;
  const blkNow = () => checks.children[1] as HTMLElement;
  let blocks: BlocksCheck;
  try {
    blocks = await verifyBlocks(a, hashAtHeight, ASSET_HUB_GENESIS, (d, t) => {
      const p = blkNow().querySelector('p');
      if (p) p.textContent = `Consultando ${d} de ${t} bloques…`;
    });
  } catch {
    blocks = { status: 'skipped', checked: blocksCount, matched: 0, mismatched: [], unknown: blocksCount, reason: 'sin conexión a la red' };
  }
  blkNow().outerHTML =
    blocks.status === 'ok'
      ? row('ok', 'Anclada a Polkadot', `Los ${blocks.matched} bloques existen en Asset Hub. El texto no pudo escribirse antes del bloque #${esc(firstBlk(a))}.`)
      : blocks.status === 'fail'
        ? row('bad', 'Bloques que no existen', `${blocks.mismatched.length} de ${blocks.checked} hashes no coinciden con la cadena (primero: #${esc(blocks.mismatched[0].blk)}).`)
        : blocks.status === 'partial'
          ? row('warn', 'Anclaje parcial', `${blocks.matched} bloques confirmados, ${blocks.unknown} sin respuesta de la red.`)
          : row('warn', 'Bloques sin comprobar', esc(blocks.reason ?? 'No se pudieron consultar.'));

  const ok = sig.ok && blocks.status !== 'fail';
  const v = root.querySelector<HTMLElement>('#verdict')!;
  v.classList.remove('pending');
  v.classList.add(ok ? 'ok' : 'bad');
  root.querySelector('#badge')!.innerHTML = icon(ok ? 'sealFill' : 'sealWarning');
  root.querySelector('#headline')!.textContent = ok ? 'Charla verificada' : sig.ok ? 'Anclaje falso' : 'Recibo alterado';
}

function firstBlk(a: Artifact): string {
  const b = a.chain.find(e => 'full' in e) as { blk: string } | undefined;
  return b?.blk ?? '?';
}
