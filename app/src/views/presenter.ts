import QRCode from 'qrcode';
import { icon } from '../lib/icons';
import { ASSET_HUB_GENESIS, NETWORK, chainSource, subscribeFinalized, type Block } from '../lib/chain';
import { blockEntry, canonicalBytes, cidForBytes, type Artifact, type AudioSeal, type ChainEntry, type UnsignedArtifact } from '../lib/artifact';
import { connectSpeaker, currentSpeaker, identityUnavailableReason, signBytes, useAppAccount, type Speaker } from '../lib/signer';
import { canUseBulletin, prepareBulletin, uploadArtifact } from '../lib/bulletin';
import { APP_DOTNS, WEB_GATEWAY } from '../lib/network';
import { requestHostPermissions } from '../lib/permissions';
import { sealAudio, startStt, stopStt, type SttStatus } from '../lib/stt';
import { InAppMic, loadWhisper, whisperBackend, type LoadProgress } from '../lib/mic';
import { asciiBar } from '../lib/ascii';
import { copyText, esc, fmtDuration, shortAddr, tag, toast, topbar, type Cleanup } from '../ui';
import { setLocalArtifact } from './verifier';

const DRAFT_KEY = 'testalk-draft';

interface Draft {
  title: string;
  venue: string;
  lang: string;
  startedAt: string | null;
  chain: ChainEntry[];
}

function loadDraft(): Draft | null {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null') as Draft | null;
    return d?.chain?.length ? d : null;
  } catch {
    return null;
  }
}
function saveDraft(d: Draft) {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(d)); } catch { /* sin almacenamiento: seguimos en memoria */ }
}
function clearDraft() {
  try { localStorage.removeItem(DRAFT_KEY); } catch { /* nada */ }
}

export function renderPresenter(root: HTMLElement): Cleanup {
  const cleanups: Cleanup[] = [];
  let sttStatus: SttStatus = 'off';
  let latest: Block | null = null;
  let recent: Block[] = [];
  const draft: Draft = { title: '', venue: '', lang: 'es', startedAt: null, chain: [] };
  let awaitingBlock = false;
  // Una vez firmado, un fallo de subida no debe volver a pedir la firma.
  let signed: { artifact: Artifact; bytes: Uint8Array; cid: string } | null = null;
  // La huella se pide una vez: después el transcriptor queda desconectado.
  let audioSeal: AudioSeal | null | undefined;

  // El transcriptor corre en localhost: ese permiso se pide aquí y no al arrancar.
  requestHostPermissions({ presenter: true });

  // El transcriptor se conecta desde la pantalla de preparación: así se ve si
  // está vivo antes de empezar.
  const sttListeners = new Set<(s: SttStatus) => void>();
  const sentenceListeners = new Set<(t: string) => void>();
  const sttHandlers = {
    onStatus: (s: SttStatus) => { sttStatus = s; sttListeners.forEach(f => f(s)); },
    onSentence: (t: string) => sentenceListeners.forEach(f => f(t)),
  };
  startStt(sttHandlers);
  cleanups.push(stopStt);

  // Micrófono de la app (Whisper en el navegador): alternativa al script de Python.
  let appMic: InAppMic | null = null;
  let appWav: Blob | null = null;
  let micState: 'off' | 'loading' | 'ready' | 'error' = 'off';
  let micNote = '';
  let micProgress: LoadProgress | null = null;
  let heard = '';
  const micListeners = new Set<() => void>();
  const levelListeners = new Set<(db: number, speaking: boolean) => void>();
  const micChanged = () => micListeners.forEach(f => f());
  cleanups.push(() => appMic?.close());

  /** Enciende o apaga el micrófono de la app. */
  async function toggleMic() {
    if (!appMic) return;
    try {
      if (appMic.isPaused()) await appMic.resume();
      else appMic.pause();
    } catch (e) {
      toast(`No se pudo encender el micrófono: ${(e as Error).message}`);
    }
    micChanged();
  }

  /** Abre el micrófono (con el gesto del botón) y carga Whisper. Un solo transcriptor a la vez. */
  async function enableAppMic(lang: string) {
    micState = 'loading';
    micNote = '';
    micProgress = null;
    micChanged();
    stopStt();
    const mic = new InAppMic(lang, {
      onSentence: t => { heard = t; sentenceListeners.forEach(f => f(t)); micChanged(); },
      onLevel: (db, speaking) => levelListeners.forEach(f => f(db, speaking)),
      onError: m => console.warn('[mic]', m),
    });
    try {
      await mic.open();
      await loadWhisper(p => { micProgress = p; micChanged(); });
      appMic = mic;
      micState = 'ready';
    } catch (e) {
      mic.close();
      micState = 'error';
      micNote = (e as Error).message;
      startStt(sttHandlers);
    }
    micChanged();
  }

  // Bloques desde ya: el primer ancla necesita un bloque previo a la primera frase.
  const blockListeners = new Set<(b: Block) => void>();
  const chainStatus = new Set<() => void>();
  let chainError = '';
  subscribeFinalized(
    b => {
      if (latest?.hash === b.hash) return;
      latest = b;
      recent = [b, ...recent].slice(0, 4);
      blockListeners.forEach(f => f(b));
      chainStatus.forEach(f => f());
    },
    e => { chainError = String(e); chainStatus.forEach(f => f()); },
  )
    .then(u => cleanups.push(u))
    .catch(e => { chainError = (e as Error).message; chainStatus.forEach(f => f()); });

  function setup() {
    const saved = loadDraft();
    const sp = currentSpeaker();
    root.innerHTML = `
      ${topbar()}
      <main class="shell" style="padding-block:40px 64px">
        <section class="card setup">
          <div>
            <h2>Prepara tu charla</h2>
            <p class="muted" style="margin:8px 0 0">Estos datos quedan dentro del recibo firmado.</p>
          </div>
          <div class="field">
            <label for="title">Título</label>
            <input class="input" id="title" maxlength="140" placeholder="Cómo construir en Polkadot" value="${esc(saved?.title ?? '')}" />
          </div>
          <div class="row">
            <div class="field">
              <label for="venue">Evento</label>
              <input class="input" id="venue" maxlength="100" placeholder="UANL, Monterrey" value="${esc(saved?.venue ?? '')}" />
            </div>
            <div class="field">
              <label for="lang">Idioma</label>
              <select class="input" id="lang">
                <option value="es">Español</option>
                <option value="en">English</option>
              </select>
            </div>
          </div>
          <div class="check-row" id="wallet-row"></div>
          <div class="check-row" id="stt-row"></div>
          <div class="check-row" id="chain-row"></div>
          <div id="err"></div>
          <button class="btn primary big block" id="start">${icon('play')}Empezar charla</button>
          ${saved ? `<button class="btn ghost block" id="resume">${icon('arrowRight')}Recuperar charla sin sellar (${saved.chain.filter(e => 's' in e).length} frases)</button>` : ''}
        </section>
      </main>`;

    const walletRow = root.querySelector<HTMLElement>('#wallet-row')!;
    const sttRow = root.querySelector<HTMLElement>('#stt-row')!;
    const chainRow = root.querySelector<HTMLElement>('#chain-row')!;
    const err = root.querySelector<HTMLElement>('#err')!;
    const start = root.querySelector<HTMLButtonElement>('#start')!;
    (root.querySelector('#lang') as HTMLSelectElement).value = saved?.lang ?? 'es';

    const drawWallet = (s = currentSpeaker()) => {
      walletRow.className = `check-row ${s ? 'ok' : ''}`;
      walletRow.innerHTML = s
        ? `${tag(s.kind === 'app' ? 'warn' : 'ok')}<div class="grow"><b>${esc(s.username ?? shortAddr(s.address))}</b>
             <div class="muted" style="font-size:13px">${signerNote(s)}</div></div>`
        : `${tag('idle')}<div class="grow">Wallet del speaker<div class="muted" style="font-size:13px">Firma el recibo al final</div></div>
           <button class="btn sm primary" id="connect">Conectar</button>`;
      start.disabled = !s;
      walletRow.querySelector('#connect')?.addEventListener('click', async ev => {
        const b = ev.currentTarget as HTMLButtonElement;
        b.disabled = true;
        b.innerHTML = `Abriendo<i class="aspin"></i>`;
        err.innerHTML = '';
        try {
          drawWallet(await connectSpeaker());
        } catch (e) {
          err.innerHTML = `<div class="error-box">${icon('warningCircle')}${esc((e as Error).message)}</div>`;
          drawWallet(null);
        }
      });
    };
    const drawStt = (s: SttStatus = sttStatus) => {
      const lang = (root.querySelector('#lang') as HTMLSelectElement)?.value ?? 'es';
      if (micState === 'ready') {
        const off = appMic?.isPaused() ?? false;
        sttRow.className = `check-row ${off ? '' : 'ok'}`;
        sttRow.innerHTML = `${tag(off ? 'idle' : 'ok')}<div class="grow">${off ? 'Micrófono de la app apagado' : 'Micrófono de la app listo'}
          <div class="muted" style="font-size:13px">Whisper base · ${whisperBackend() === 'webgpu' ? 'WebGPU' : 'WebAssembly'}${off ? '' : ' · <span class="mono" id="mic-lvl"></span>'}</div>
          <div class="muted" style="font-size:13px">${off ? 'Enciéndelo para probar.' : heard ? `Te escuché: «${esc(heard)}»` : 'Di algo para probarlo.'}</div></div>
          ${micButton(off, 'sm')}`;
        sttRow.querySelector('#mic-toggle')?.addEventListener('click', toggleMic);
        return;
      }
      if (micState === 'loading') {
        const p = micProgress;
        sttRow.className = 'check-row';
        sttRow.innerHTML = `${tag('wait')}<div class="grow">Preparando el micrófono de la app
          <div class="muted mono" style="font-size:12.5px">${p && p.total
            ? `${asciiBar(p.loaded, p.total)} ${Math.round(p.progress)} % · ${Math.round(p.loaded / 1e6)} de ${Math.round(p.total / 1e6)} MB`
            : 'Permiso del micrófono y descarga de Whisper (solo la primera vez)'}</div></div>`;
        return;
      }
      if (s === 'on') {
        sttRow.className = 'check-row ok';
        sttRow.innerHTML = `${tag('ok')}<div class="grow">Transcriptor conectado<div class="muted" style="font-size:13px">Escuchando el micrófono de la laptop</div></div>`;
        return;
      }
      sttRow.className = 'check-row';
      sttRow.innerHTML = `${tag(micState === 'error' ? 'warn' : 'idle')}<div class="grow">Transcripción
          <div class="muted" style="font-size:13px">${micState === 'error' ? `No se pudo usar el micrófono de la app: ${esc(micNote)}` : 'La app puede escuchar y transcribir sola, sin instalar nada.'}</div>
          <div class="muted" style="font-size:12.5px">O en la laptop: <code>python stt/testalk_stt.py --language ${esc(lang)}</code></div></div>
        <button class="btn sm primary" id="use-mic">${icon('microphone')}Usar el micrófono de la app</button>`;
      sttRow.querySelector('#use-mic')?.addEventListener('click', () => enableAppMic(lang));
    };
    const showLevel = (db: number) => {
      const el = root.querySelector('#mic-lvl');
      if (el) el.textContent = levelBar(db);
    };
    const drawChain = () => {
      chainRow.className = `check-row ${latest ? 'ok' : ''}`;
      chainRow.innerHTML = latest
        ? `${tag('ok')}<div class="grow">Asset Hub conectado<div class="muted mono" style="font-size:12.5px">bloque #${latest.number.toLocaleString('en-US')} · ${via()}</div></div>`
        : chainError
          ? `${tag('warn')}<div class="grow">Sin conexión a la red<div class="muted" style="font-size:13px">${esc(chainError)}</div></div>`
          : `${tag('wait')}<div class="grow">Conectando a Asset Hub</div>`;
    };
    drawWallet(sp);
    drawStt(sttStatus);
    drawChain();
    sttListeners.add(drawStt);
    chainStatus.add(drawChain);
    const redrawStt = () => drawStt();
    micListeners.add(redrawStt);
    levelListeners.add(showLevel);
    root.querySelector('#lang')!.addEventListener('change', () => drawStt(sttStatus));

    const go = (resume: boolean) => {
      sttListeners.delete(drawStt);
      chainStatus.delete(drawChain);
      micListeners.delete(redrawStt);
      levelListeners.delete(showLevel);
      // La grabación que se sella empieza aquí, no cuando se abrió el micrófono.
      appMic?.resetRecording();
      draft.title = (root.querySelector('#title') as HTMLInputElement).value.trim() || 'Charla sin título';
      draft.venue = (root.querySelector('#venue') as HTMLInputElement).value.trim();
      draft.lang = (root.querySelector('#lang') as HTMLSelectElement).value;
      if (resume && saved) {
        draft.chain = saved.chain;
        draft.startedAt = saved.startedAt;
      }
      // Cuota y permiso de Bulletin ahora, con el gesto de "Empezar": al sellar ya están.
      if (canUseBulletin() && !currentSpeaker()?.rehearsal) prepareBulletin().catch(e => console.warn('[bulletin]', e));
      live();
    };
    start.addEventListener('click', () => {
      if (!latest) {
        err.innerHTML = `<div class="error-box">${icon('warningCircle')}Espera a que conecte Asset Hub: sin bloques no hay ancla.</div>`;
        return;
      }
      clearDraft();
      go(false);
    });
    root.querySelector('#resume')?.addEventListener('click', () => (currentSpeaker() ? go(true) : toast('Conecta tu wallet primero')));
  }

  function live() {
    root.innerHTML = `
      ${topbar(`<span class="talk-title">${esc(draft.title)}</span>`)}
      <main class="shell stage">
        <section class="card transcript"><div class="lines" id="lines"></div></section>
        <aside class="side">
          <div class="card pills">
            <span class="pill" id="stt-pill"></span>
            <span class="pill live" id="blk-pill">■ <span id="blk-n">…</span></span>
          </div>
          ${appMic ? `<div class="card" id="mic-card"></div>` : ''}
          <div class="card stats">
            <div class="stat"><b id="st-time">0:00</b><span>duración</span></div>
            <div class="stat"><b id="st-s">0</b><span>frases</span></div>
            <div class="stat"><b id="st-b">0</b><span>bloques</span></div>
          </div>
          <div class="card" id="seal-box">
            <button class="btn primary big block" id="seal">${icon('signature')}Sellar charla</button>
            <p class="faint" style="font-size:13px;margin:12px 0 0">Detiene la transcripción, firma con tu wallet y genera el QR.</p>
          </div>
          <div class="card">
            <h3>Añadir frase a mano</h3>
            <form class="manual" id="manual">
              <input class="input" id="manual-in" maxlength="400" placeholder="Si el micrófono falla" aria-label="Frase" />
              <button class="btn sm" type="submit">${icon('pencilSimple')}</button>
            </form>
          </div>
        </aside>
      </main>`;

    const lines = root.querySelector<HTMLElement>('#lines')!;
    const sttPill = root.querySelector<HTMLElement>('#stt-pill')!;
    const blkN = root.querySelector<HTMLElement>('#blk-n')!;
    const stS = root.querySelector<HTMLElement>('#st-s')!;
    const stB = root.querySelector<HTMLElement>('#st-b')!;
    const stTime = root.querySelector<HTMLElement>('#st-time')!;

    const trim = () => { while (lines.children.length > 14) lines.firstElementChild!.remove(); };
    const addRivet = (e: Extract<ChainEntry, { full: string }>) => {
      const el = document.createElement('span');
      el.className = 'rivet';
      el.innerHTML = `■ #${esc(e.blk)} · ${esc(e.h)}`;
      lines.append(el);
      trim();
    };
    const addLine = (text: string) => {
      lines.querySelector('.current')?.classList.remove('current');
      const el = document.createElement('p');
      el.className = 'line current';
      el.textContent = text;
      lines.append(el);
      trim();
    };
    const counts = () => {
      stS.textContent = String(draft.chain.filter(e => 's' in e).length);
      stB.textContent = String(draft.chain.filter(e => 'full' in e).length);
    };

    if (draft.chain.length) {
      for (const e of draft.chain.slice(-14)) ('s' in e ? addLine(e.s) : addRivet(e));
    } else {
      lines.innerHTML = `<div class="empty-stage"><strong>Empieza a hablar.</strong>
        Cada frase aparece aquí y entre frases se clava un bloque de Polkadot.</div>`;
    }
    counts();

    const onSentence = (text: string) => {
      lines.querySelector('.empty-stage')?.remove();
      if (draft.chain.length === 0 && latest) {
        // Ancla de cabeza: la charla no pudo existir antes de este bloque.
        const e = blockEntry(latest) as Extract<ChainEntry, { full: string }>;
        draft.chain.push(e);
        addRivet(e);
      }
      draft.startedAt ??= new Date().toISOString();
      draft.chain.push({ s: text });
      awaitingBlock = true;
      addLine(text);
      counts();
      saveDraft(draft);
    };
    const onBlock = (b: Block) => {
      blkN.textContent = `#${b.number.toLocaleString('en-US')}`;
      // Solo un bloque por tramo hablado: los silencios no inflan el recibo.
      if (!awaitingBlock) return;
      awaitingBlock = false;
      const e = blockEntry(b) as Extract<ChainEntry, { full: string }>;
      draft.chain.push(e);
      addRivet(e);
      counts();
      saveDraft(draft);
    };
    const micCard = root.querySelector<HTMLElement>('#mic-card');
    const drawStt = (s: SttStatus) => {
      if (appMic) {
        const off = appMic.isPaused();
        sttPill.className = `pill ${off ? 'off' : 'on'}`;
        sttPill.innerHTML = off
          ? `${icon('microphoneSlash')}micrófono apagado`
          : `<i class="mono" id="live-lvl" aria-hidden="true">${levelBar(-90)}</i>escuchando`;
        if (micCard) {
          micCard.innerHTML = `${micButton(off, 'block')}
            <p class="faint" style="font-size:13px;margin:10px 0 0">Tecla <span class="mono">M</span>. Lo que digas con el micrófono apagado no entra al recibo.</p>`;
          micCard.querySelector('#mic-toggle')?.addEventListener('click', toggleMic);
        }
        return;
      }
      sttPill.className = `pill ${s === 'on' ? 'on' : 'off'}`;
      sttPill.innerHTML = s === 'on' ? `<i class="ameter" aria-hidden="true"></i>escuchando` : `${icon('microphoneSlash')}sin transcriptor`;
    };
    drawStt(sttStatus);
    const liveLevel = (db: number) => {
      const el = root.querySelector('#live-lvl');
      if (el) el.textContent = levelBar(db);
    };
    levelListeners.add(liveLevel);
    const redrawLive = () => drawStt(sttStatus);
    micListeners.add(redrawLive);
    // Tecla M: encender o apagar sin buscar el botón (no mientras se escribe una frase a mano).
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key.toLowerCase() !== 'm' || ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if ((ev.target as HTMLElement)?.closest('input, textarea, select')) return;
      ev.preventDefault();
      void toggleMic();
    };
    document.addEventListener('keydown', onKey);
    cleanups.push(() => document.removeEventListener('keydown', onKey));
    if (latest) blkN.textContent = `#${latest.number.toLocaleString('en-US')}`;
    sentenceListeners.add(onSentence);
    blockListeners.add(onBlock);
    sttListeners.add(drawStt);

    const timer = setInterval(() => {
      if (draft.startedAt) stTime.textContent = fmtDuration(Date.now() - Date.parse(draft.startedAt));
    }, 1000);
    cleanups.push(() => clearInterval(timer));

    root.querySelector('#manual')!.addEventListener('submit', ev => {
      ev.preventDefault();
      const inp = root.querySelector<HTMLInputElement>('#manual-in')!;
      const t = inp.value.trim();
      if (t) onSentence(t);
      inp.value = '';
    });

    detachLive = () => {
      sentenceListeners.delete(onSentence);
      blockListeners.delete(onBlock);
      levelListeners.delete(liveLevel);
      micListeners.delete(redrawLive);
      document.removeEventListener('keydown', onKey);
    };
    root.querySelector('#seal')!.addEventListener('click', () => {
      if (!draft.chain.some(e => 's' in e)) return toast('Todavía no hay nada que sellar');
      clearInterval(timer);
      // Con el micrófono de la app, las últimas frases se siguen transcribiendo mientras
      // se cierra la grabación: se desengancha después, en seal().
      if (!appMic) detachLive();
      seal(root.querySelector<HTMLElement>('#seal-box')!);
    });
  }

  let detachLive: () => void = () => undefined;

  async function seal(box: HTMLElement) {
    const sp = currentSpeaker()!;
    const bulletin = canUseBulletin() && !sp.rehearsal;
    const steps = [
      ['waveform', 'Cerrando la grabación'],
      ['signature', 'Firma en tu celular'],
      ['fileArrowUp', bulletin ? 'Subiendo a Bulletin (1 a 3 min)' : 'Preparando el recibo'],
    ] as const;
    const draw = (at: number, error?: string) => {
      box.innerHTML = `
        <div class="progress-steps">
          ${steps.map(([, label], i) => `<div class="${i < at ? 'done' : i === at ? 'doing' : ''}">
            ${tag(i < at ? 'ok' : i === at ? (error ? 'bad' : 'wait') : 'idle')}${label}</div>`).join('')}
        </div>
        ${error ? `<div class="error-box" style="margin-top:14px">${icon('warningCircle')}${esc(error)}</div>
          <button class="btn primary block" id="retry" style="margin-top:12px">${signed ? 'Reintentar subida' : 'Reintentar'}</button>
          ${!signed && at === 1 && currentSpeaker()?.kind === 'identity' ? `<button class="btn ghost block" id="as-app" style="margin-top:8px">${icon('signature')}Firmar con la cuenta de la app</button>` : ''}
          ${signed ? `<button class="btn ghost block" id="skip" style="margin-top:8px">${icon('downloadSimple')}Seguir sin Bulletin</button>` : ''}` : ''}`;
      box.querySelector('#retry')?.addEventListener('click', () => seal(box));
      box.querySelector('#as-app')?.addEventListener('click', () => {
        // Respaldo: el recibo no quedará ligado al username, y lo dirá.
        useAppAccount();
        seal(box);
      });
      box.querySelector('#skip')?.addEventListener('click', () => {
        clearDraft();
        setLocalArtifact(signed!.artifact, signed!.cid);
        sealed(box, signed!.artifact, signed!.cid, false);
      });
    };

    let step = signed ? 2 : 0;
    try {
      if (signed) return await upload(box, draw, bulletin);
      draw(step);
      if (audioSeal === undefined) {
        if (appMic) {
          const r = await appMic.stop();
          appWav = r.wav;
          audioSeal = r.seal;
          appMic = null;
        } else {
          audioSeal = await sealAudio();
          stopStt();
        }
        detachLive();
      }
      const audio = audioSeal;

      draw(++step);
      // Remache de cierre: las últimas frases también quedan entre dos bloques.
      const last = [...draft.chain].reverse().find(e => 'full' in e) as { full: string } | undefined;
      if (awaitingBlock && latest && latest.hash !== last?.full) draft.chain.push(blockEntry(latest));
      const endedAt = new Date().toISOString();
      const started = draft.startedAt ?? endedAt;
      const hm = (iso: string) => new Date(iso).toTimeString().slice(0, 5);
      // `dotns` solo lleva el username cuando firma su dueño: es lo que el verificador
      // comprueba en People chain. Con la cuenta de la app el nombre queda como texto.
      const who = currentSpeaker()!;
      const unsigned: UnsignedArtifact & { rehearsal?: true } = {
        v: 1,
        speaker: who.username ?? shortAddr(who.address),
        dotns: who.kind === 'identity' && who.username ? who.username : '',
        title: draft.title,
        venue: draft.venue,
        started_at: started,
        ended_at: endedAt,
        window: `${hm(started)}-${hm(endedAt)}`,
        anchor_block: latest ? latest.number.toLocaleString('en-US') : '',
        total_sentences: draft.chain.filter(e => 's' in e).length,
        total_blocks: draft.chain.filter(e => 'full' in e).length,
        chain: draft.chain,
        network: NETWORK,
        genesis: ASSET_HUB_GENESIS,
        lang: draft.lang,
        speaker_address: who.address,
        audio,
        ...(who.rehearsal ? { rehearsal: true as const } : {}),
      };
      const sig = await signBytes(canonicalBytes(unsigned as unknown as Record<string, unknown>));
      const artifact: Artifact = { ...unsigned, pubkey: who.pubkey, sig, sig_alg: 'sr25519' };
      const bytes = new TextEncoder().encode(JSON.stringify(artifact));
      signed = { artifact, bytes, cid: cidForBytes(bytes) };
      saveDraft(draft);
      await upload(box, draw, bulletin);
    } catch (e) {
      draw(step, (e as Error).message);
    }
  }

  let uploadTries = 0;
  async function upload(box: HTMLElement, draw: (at: number, error?: string) => void, bulletin: boolean) {
    const { artifact, bytes, cid } = signed!;
    draw(2);
    try {
      if (bulletin) await uploadArtifact(bytes, { checkFirst: uploadTries++ > 0 });
    } catch (e) {
      return draw(2, `La charla está firmada, pero no se subió: ${(e as Error).message}`);
    }
    clearDraft();
    setLocalArtifact(artifact, cid);
    await sealed(box, artifact, cid, bulletin);
  }

  async function sealed(box: HTMLElement, artifact: Artifact, cid: string, onBulletin: boolean) {
    // El gateway abre en cualquier navegador: la cámara del teléfono no resuelve `.dot`.
    const url = `${WEB_GATEWAY}/#/${cid}`;
    const qr = await QRCode.toDataURL(url, { margin: 1, width: 720, errorCorrectionLevel: 'M', color: { dark: '#0d0d10', light: '#ffffff' } });
    box.innerHTML = `
      <div class="sealed">
        <span class="pill on">${icon('sealCheck')}Charla sellada</span>
        ${onBulletin
          ? `<div class="qr"><img src="${qr}" alt="QR para verificar esta charla" /></div>
             <p class="muted" style="margin:0;font-size:14px">Escanéalo con la cámara del teléfono. En Polkadot App: <span class="mono">${esc(APP_DOTNS)}/#/…</span></p>`
          : `<p class="muted" style="margin:0;font-size:14px">Ensayo: el recibo no se subió a Bulletin. Descárgalo o ábrelo en el verificador.</p>`}
        <div class="cid">${esc(cid)}</div>
        <div class="actions" style="justify-content:center">
          <a class="btn sm" href="#/verificar">${icon('shieldCheck')}Verificar</a>
          <button class="btn sm" id="dl">${icon('downloadSimple')}JSON</button>
          <button class="btn sm" id="cj">${icon('copy')}Copiar JSON</button>
          ${appWav ? `<button class="btn sm" id="wav">${icon('downloadSimple')}Audio WAV</button>` : ''}
          ${onBulletin ? `<button class="btn sm" id="cp">${icon('copy')}Enlace</button>` : ''}
        </div>
      </div>`;
    box.querySelector('#dl')!.addEventListener('click', () => downloadJson(artifact, cid));
    box.querySelector('#wav')?.addEventListener('click', () => {
      // La huella del recibo es la de este archivo: guárdalo sin convertirlo.
      const a = document.createElement('a');
      a.href = URL.createObjectURL(appWav!);
      a.download = `testalk-${cid.slice(-10)}.wav`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    // Respaldo de la descarga: en el celular un <a download> puede no hacer nada.
    box.querySelector('#cj')!.addEventListener('click', () => copyText(JSON.stringify(artifact), 'JSON copiado'));
    box.querySelector('#cp')?.addEventListener('click', () => copyText(url, 'Enlace copiado'));
  }

  setup();
  return () => cleanups.forEach(f => { try { f(); } catch { /* ya cerrado */ } });
}

function micButton(off: boolean, size: 'sm' | 'block'): string {
  const cls = size === 'sm' ? 'btn sm' : `btn block ${off ? 'primary' : ''}`;
  return `<button class="${cls}" id="mic-toggle" aria-pressed="${!off}">${icon(off ? 'microphone' : 'microphoneSlash')}${off ? 'Encender micrófono' : 'Apagar micrófono'}</button>`;
}

/** Nivel del micrófono en texto: `▁▂▃▅▆▇` de -60 a -10 dBFS. */
function levelBar(db: number): string {
  const steps = '▁▂▃▄▅▆▇█';
  const n = Math.max(0, Math.min(8, Math.round(((db + 60) / 50) * 8)));
  return steps.slice(0, Math.max(1, n)).padEnd(8, ' ');
}

/** Por dónde llegan los bloques: el host, o el RPC público si el host no los entregó. */
function via(): string {
  const { source, hostProblem } = chainSource();
  if (source === 'host') return 'por el host';
  return hostProblem ? `por RPC público (${esc(hostProblem)})` : 'por RPC público';
}

/** Con qué llave se va a firmar, dicho sin rodeos: es lo que el verificador podrá comprobar. */
function signerNote(s: Speaker): string {
  if (s.kind === 'rehearsal') return 'Ensayo: cuenta de prueba, fuera de Polkadot App';
  if (s.kind === 'identity') return `Firmarás con tu identidad .dot · <span class="mono">${esc(shortAddr(s.address))}</span>`;
  const why = identityUnavailableReason();
  return `Firmarás con la cuenta de ${esc(APP_DOTNS)}: el recibo no quedará ligado a tu username${why ? ` (${esc(why)})` : ''}`;
}


export function downloadJson(a: Artifact, cid: string) {
  // Compacto a propósito: son los mismos bytes que se subieron, así el CID del archivo coincide.
  const blob = new Blob([JSON.stringify(a)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `testalk-${cid.slice(-10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

