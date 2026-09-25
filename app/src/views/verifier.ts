import { icon } from '../lib/icons';
import { ASSET_HUB_GENESIS, hashAtHeight, withReadClient } from '../lib/chain';
import { readSeal } from '../lib/registry';
import {
  cidForBytes,
  preimageKeyFromCid,
  verifyBlocks,
  verifySignature,
  type Artifact,
  type BlocksCheck,
  type SigCheck,
} from '../lib/artifact';
import QRCode from 'qrcode';
import { blake2b } from '@noble/hashes/blake2b';
import { u8aToHex } from '@polkadot/util';
import { fetchReceipt } from '../lib/bulletin';
import { APP_DOTNS } from '../lib/signer';
import { asciiBar, asciiStamp } from '../lib/ascii';
import { esc, fmtDuration, shortAddr, tag, toast, topbar, type Cleanup, type Tone } from '../ui';

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
      fetchReceipt(cid, key)
        .then(bytes => {
          if (dead) return;
          if (!bytes) return failed(root, 'No se encontró el recibo en Bulletin. Puede haber expirado (Bulletin guarda 14 días).');
          // El gateway no es de confianza: los bytes deben ser exactamente los del CID.
          if (cidForBytes(bytes) !== cid) return failed(root, 'Los datos recibidos no corresponden a este CID.');
          let a: Artifact;
          try { a = JSON.parse(new TextDecoder().decode(bytes)); } catch { return failed(root, 'El recibo no es JSON válido.'); }
          show(root, a, cid, true, bytes);
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
        <h1>Buscando el recibo<i class="aspin"></i></h1>
        <p class="title">Leyendo Bulletin a través de Polkadot App.</p>
      </section>
      <div class="skeleton" style="height:180px"></div>
    </main>`;
}

function failed(root: HTMLElement, msg: string) {
  root.innerHTML = `${topbar()}
    <main class="shell verify">
      <section class="card verdict bad">
        <pre class="stamp bad" aria-hidden="true">${asciiStamp(['SIN RECIBO'])}</pre>
        <h1>No se pudo abrir el recibo</h1>
        <p class="title">${esc(msg)}</p>
      </section>
      <a class="btn" href="#/verificar">${icon('fileArrowUp')}Verificar un archivo</a>
    </main>`;
}

function picker(root: HTMLElement) {
  root.innerHTML = `${topbar()}
    <main class="shell verify">
      <section class="intro">
        <h1>Verificar un recibo</h1>
        <p class="lead">Escanea el QR de una charla con Polkadot App, o sube aquí el archivo JSON.</p>
      </section>
      <label class="drop" id="drop">
        <span class="drop-art" aria-hidden="true">[ recibo.json ]</span>
        <b>Suelta el recibo aquí</b>
        <span>o toca para elegirlo</span>
        <input type="file" accept="application/json,.json" hidden id="file" />
      </label>
      <form class="card cid-form" id="cid-form">
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
      show(root, JSON.parse(new TextDecoder().decode(bytes)), cidForBytes(bytes), false, bytes);
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

function row(id: string, tone: Tone, title: string, body: string, extra = ''): string {
  return `<div class="chk ${tone}" id="chk-${id}">${tag(tone)}<b>${title}</b><p>${body}</p>${extra}</div>`;
}

function setRow(root: HTMLElement, id: string, html: string) {
  const el = root.querySelector(`#chk-${id}`);
  if (el) el.outerHTML = html;
}

/**
 * `bytes` son los del archivo o de Bulletin tal cual: la huella del sello y el
 * CID dependen de cada byte, así que se descargan esos y no un JSON re-serializado.
 */
function show(root: HTMLElement, a: Artifact, cid: string, fromBulletin: boolean, bytes?: Uint8Array) {
  const dur = Date.parse(a.ended_at) - Date.parse(a.started_at);
  const rehearsal = (a as { rehearsal?: boolean }).rehearsal === true;
  const who = a.dotns || a.speaker || shortAddr(a.speaker_address ?? a.pubkey);

  root.innerHTML = `${topbar()}
    <main class="shell verify">
      <section class="card verdict pending" id="verdict">
        <pre class="stamp" id="stamp" aria-hidden="true"></pre>
        ${rehearsal ? `<span class="pill warn">Ensayo</span>` : ''}
        <h1 id="headline">Verificando<i class="aspin"></i></h1>
        <p class="title">${esc(a.title)}</p>
        <div class="meta">
          <div><span>Speaker</span><b>${esc(who)}</b></div>
          <div><span>Evento</span><b>${esc(a.venue || 'Sin especificar')}</b></div>
          <div><span>Fecha</span><b>${new Date(a.started_at).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' })}</b><small class="mono">${esc(a.window || '')}</small></div>
          <div><span>Duración</span><b class="mono">${Number.isFinite(dur) ? fmtDuration(dur) : 'n/d'}</b></div>
        </div>
      </section>
      <section class="card checks" id="checks">
        ${row('sig', 'wait', 'Firma', 'Comprobando…')}
        ${row('blocks', 'wait', 'Bloques en la cadena', 'Esperando…')}
        ${row('seal', 'wait', 'Sello permanente', 'Consultando el registro en Asset Hub…')}
        ${audioRow(a)}
      </section>
      <div class="dither-band"></div>
      <section class="timeline">
        <h2>Lo que se dijo</h2>
        <ol class="rail">
          ${a.chain
            .map(e => ('s' in e
              ? `<li class="s">${esc(e.s)}</li>`
              : `<li class="b"><span class="mono">■ #${esc(e.blk)}</span><span class="mono t">${esc(e.time)}</span></li>`))
            .join('')}
        </ol>
      </section>
      ${limits(a)}
      <div class="actions">
        <button class="btn" id="dl">${icon('downloadSimple')}Descargar recibo</button>
        ${fromBulletin ? `<button class="btn" id="qr-btn">${icon('qrCode')}QR</button>
        <button class="btn" id="cp">${icon('copy')}Copiar enlace</button>` : ''}
        <a class="btn ghost" href="#/verificar" id="other">${icon('fileArrowUp')}Otro recibo</a>
      </div>
      <section class="card share" id="share" hidden></section>
      <p class="faint mono" style="font-size:12px;word-break:break-all;margin:0">CID ${esc(cid)}</p>
    </main>`;

  const link = `https://${APP_DOTNS}/#/${cid}`;
  root.querySelector('#dl')!.addEventListener('click', () => download(bytes ?? new TextEncoder().encode(JSON.stringify(a)), cid));
  root.querySelector('#cp')?.addEventListener('click', () => navigator.clipboard?.writeText(link).then(() => toast('Enlace copiado'), () => toast(link)));
  root.querySelector('#qr-btn')?.addEventListener('click', () => toggleQr(root.querySelector<HTMLElement>('#share')!, link));
  root.querySelector('#other')!.addEventListener('click', ev => {
    // Si ya estamos en #/verificar el hash no cambia y no habría re-render.
    ev.preventDefault();
    local = null;
    if (location.hash === '#/verificar') picker(root);
    else location.hash = '#/verificar';
  });

  run(root, a);
  sealRow(root, a, cid);
  bindAudio(root, a);
}

function download(bytes: Uint8Array, cid: string) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/json' }));
  link.download = `testalk-${cid.slice(-10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

async function toggleQr(box: HTMLElement, link: string) {
  if (!box.hidden) { box.hidden = true; return; }
  if (!box.innerHTML) {
    const qr = await QRCode.toDataURL(link, { margin: 1, width: 720, errorCorrectionLevel: 'M', color: { dark: '#0d0d10', light: '#ffffff' } });
    box.innerHTML = `
      <div class="qr"><img src="${qr}" alt="QR para verificar esta charla" /></div>
      <p class="muted" style="margin:0;font-size:14px">Escanéalo con Polkadot App para abrir este recibo.</p>`;
  }
  box.hidden = false;
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/** Lo que el recibo prueba y lo que no: sin esto el ✓ verde promete de más. */
function limits(a: Artifact): string {
  return `
    <details class="card limits">
      <summary>¿Qué prueba este recibo?<span class="mono" aria-hidden="true"></span></summary>
      <div class="limits-grid">
        <div>
        <h3>Prueba</h3>
        <ul class="yes">
          <li>La llave <span class="mono">${esc(shortAddr(a.speaker_address ?? a.pubkey))}</span> firmó exactamente este texto.</li>
          <li>El texto no pudo escribirse antes del bloque #${esc(firstBlk(a))}: su hash no se conocía.</li>
          <li>Existía a más tardar cuando se subió a Bulletin o se selló en Asset Hub.</li>
          ${a.audio ? '<li>Si el speaker comparte el audio, se puede comprobar que es la misma grabación.</li>' : ''}
        </ul>
        </div>
        <div>
        <h3>No prueba</h3>
        <ul class="no">
          <li>Que lo dicho sea cierto. Prueba quién lo dijo, no si tiene razón.</li>
          <li>Que la voz sea de esa persona: el recibo guarda texto, no la voz.</li>
          <li>Que la llave sea de un humano único (eso lo daría Individuality).</li>
        </ul>
        </div>
      </div>
    </details>`;
}

function audioRow(a: Artifact): string {
  if (!a.audio) return row('audio', 'warn', 'Grabación', 'Este recibo no incluye huella del audio.');
  return row(
    'audio',
    'ok',
    'Grabación sellada',
    `${fmtDuration(a.audio.seconds * 1000)} de audio. Huella blake2b-256 <span class="mono">${esc(a.audio.hash.slice(0, 18))}…</span>. El speaker conserva el archivo: si lo comparte, cualquiera puede comprobar que es el mismo.`,
    audioPicker('Comprobar audio'),
  );
}

function audioPicker(label: string): string {
  return `<label class="btn sm chk-action">${icon('waveform')}${label}<input type="file" accept="audio/wav,audio/x-wav,.wav" hidden id="wav" /></label>`;
}

/** Huella del WAV por partes: una charla de 15 min son ~30 MB. */
async function hashFile(f: File, onProgress: (pct: number) => void): Promise<string> {
  const h = blake2b.create({ dkLen: 32 });
  const reader = f.stream().getReader();
  let done = 0;
  for (let r = await reader.read(); !r.done; r = await reader.read()) {
    h.update(r.value);
    done += r.value.byteLength;
    onProgress(f.size ? Math.round((done / f.size) * 100) : 100);
  }
  return u8aToHex(h.digest());
}

let audioUrl: string | null = null;

function bindAudio(root: HTMLElement, a: Artifact) {
  const seal = a.audio;
  const input = root.querySelector<HTMLInputElement>('#wav');
  if (!seal || !input) return;
  input.addEventListener('change', async () => {
    const f = input.files?.[0];
    if (!f) return;
    setRow(root, 'audio', row('audio', 'wait', 'Comprobando audio', `Calculando la huella de ${esc(f.name)}…`));
    const p = () => root.querySelector('#chk-audio p');
    let hash: string;
    try {
      hash = await hashFile(f, pct => { const el = p(); if (el) el.textContent = `Calculando la huella de ${f.name}… ${pct}%`; });
    } catch {
      setRow(root, 'audio', row('audio', 'warn', 'Audio sin comprobar', 'No se pudo leer el archivo.', audioPicker('Elegir otro')));
      return bindAudio(root, a);
    }
    if (hash.toLowerCase() !== seal.hash.toLowerCase()) {
      setRow(root, 'audio', row('audio', 'bad', 'No es esta grabación',
        `La huella de ${esc(f.name)} es <span class="mono">${esc(hash.slice(0, 18))}…</span>, el recibo dice <span class="mono">${esc(seal.hash.slice(0, 18))}…</span>. Basta un byte distinto (un recorte, otra exportación) para que no coincida.`,
        audioPicker('Elegir otro')));
      return bindAudio(root, a);
    }
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audioUrl = URL.createObjectURL(f);
    setRow(root, 'audio', row('audio', 'ok', 'Audio auténtico',
      `${esc(f.name)} es byte por byte la grabación que se selló al firmar.`,
      `<audio class="chk-action" controls preload="metadata" src="${audioUrl}"></audio>`));
  });
}

async function run(root: HTMLElement, a: Artifact) {
  const sig: SigCheck = await verifySignature(a);
  setRow(root, 'sig', sig.ok
    ? row('sig', 'ok', 'Firma válida', `sr25519 de <span class="mono">${esc(shortAddr(a.speaker_address ?? a.pubkey))}</span>. Nadie cambió una sola letra desde que se firmó.`)
    : row('sig', 'bad', 'Firma inválida', esc(capitalize(sig.reason ?? 'la firma no corresponde.'))));

  const blocksCount = a.chain.filter(e => 'full' in e).length;
  let blocks: BlocksCheck;
  try {
    blocks = await verifyBlocks(a, hashAtHeight, ASSET_HUB_GENESIS, (d, t) => {
      const p = root.querySelector('#chk-blocks p');
      if (p) p.innerHTML = `<span class="mono">${asciiBar(d, t)}</span> ${d} de ${t} bloques`;
    });
  } catch {
    blocks = { status: 'skipped', checked: blocksCount, matched: 0, mismatched: [], unknown: blocksCount, reason: 'sin conexión a la red' };
  }
  setRow(root, 'blocks',
    blocks.status === 'ok'
      ? row('blocks', 'ok', 'Anclada a Polkadot', `Los ${blocks.matched} bloques existen en Asset Hub. El texto no pudo escribirse antes del bloque #${esc(firstBlk(a))}.`)
      : blocks.status === 'fail'
        ? row('blocks', 'bad', 'Bloques que no existen', `${blocks.mismatched.length} de ${blocks.checked} hashes no coinciden con la cadena (primero: #${esc(blocks.mismatched[0].blk)}).`)
        : blocks.status === 'partial'
          ? row('blocks', 'warn', 'Anclaje parcial', `${blocks.matched} bloques confirmados, ${blocks.unknown} sin respuesta de la red.`)
          : row('blocks', 'warn', 'Bloques sin comprobar', esc(blocks.reason ?? 'No se pudieron consultar.')));

  const ok = sig.ok && blocks.status !== 'fail';
  const v = root.querySelector<HTMLElement>('#verdict')!;
  v.classList.remove('pending');
  v.classList.add(ok ? 'ok' : 'bad');
  const headline = ok ? 'Charla verificada' : sig.ok ? 'Anclaje falso' : 'Recibo alterado';
  const stamp = root.querySelector<HTMLElement>('#stamp')!;
  stamp.className = `stamp ${ok ? 'ok' : 'bad'}`;
  stamp.textContent = asciiStamp([
    headline.toUpperCase(),
    ok ? `sr25519 + ${blocks.matched}/${blocksCount} bloques` : sig.ok ? 'bloques inventados' : 'firma inválida',
  ]);
  root.querySelector('#headline')!.textContent = headline;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function firstBlk(a: Artifact): string {
  const b = a.chain.find(e => 'full' in e) as { blk: string } | undefined;
  return b?.blk ?? '?';
}

/** Fila del registro permanente. Informativa: no cambia el veredicto. */
async function sealRow(root: HTMLElement, a: Artifact, cid: string) {
  let html: string;
  try {
    const seal = await withReadClient(c => readSeal(c, preimageKeyFromCid(cid)));
    if (!seal) {
      html = row('seal', 'warn', 'Sin sello permanente', 'Este recibo no está en el registro de Asset Hub. Bulletin lo borra a los 14 días: guarda el JSON.');
    } else {
      const at = new Date(Number(seal.sealedAt) * 1000).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' });
      const blk = Number(seal.blockNumber).toLocaleString('en-US');
      // El contrato guarda lo que le mandó quien selló sin revisarlo; la huella sí amarra los bytes.
      const samePubkey = String(seal.pubkey).toLowerCase() === String(a.pubkey).toLowerCase();
      html = samePubkey
        ? row('seal', 'ok', 'Sello permanente',
          `Anclado en Asset Hub en el bloque #${blk} (${at}). El texto se escribió entre el bloque #${esc(firstBlk(a))} y el #${blk}, y sigue verificable aunque Bulletin lo borre.`)
        : row('seal', 'warn', 'Sello con datos distintos',
          `La huella está sellada en el bloque #${blk} (${at}), pero el sello registra otra llave (<span class="mono">${esc(shortAddr(String(seal.pubkey)))}</span>). La fecha vale; la llave válida es la del recibo.`);
    }
  } catch {
    html = row('seal', 'warn', 'Sello permanente sin comprobar', 'No se pudo consultar el registro en Asset Hub.');
  }
  setRow(root, 'seal', html);
}
