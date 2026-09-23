import { icon } from '../lib/icons';
import { subscribeFinalized, type Block } from '../lib/chain';
import { esc, topbar, type Cleanup } from '../ui';

export function renderHome(root: HTMLElement): Cleanup {
  root.innerHTML = `
    ${topbar()}
    <main class="shell home">
      <section>
        <h1>Lo que dices, <em>firmado</em> y anclado a Polkadot.</h1>
        <p class="lead">Tu charla se transcribe en vivo, se entrelaza con bloques reales y la sellas con tu wallet.</p>
        <div class="ctas">
          <a class="btn primary big" href="#/presentar">${icon('microphone')}Presentar</a>
          <a class="btn big" href="#/verificar">${icon('shieldCheck')}Verificar recibo</a>
        </div>
        <div class="flow">
          <span>${icon('waveform')}Hablas</span>
          <span>${icon('cube')}Se ancla a bloques</span>
          <span>${icon('signature')}Firmas</span>
          <span>${icon('qrCode')}Cualquiera verifica</span>
        </div>
      </section>
      <aside class="card ticker" aria-live="polite">
        <div class="ticker-head">
          <span>Asset Hub en vivo</span>
          <span class="pill off" id="net">${icon('circleNotch', 'spin')}conectando</span>
        </div>
        <div class="blocks" id="blocks">
          ${'<div class="skeleton"></div>'.repeat(5)}
        </div>
      </aside>
    </main>`;

  const list = root.querySelector<HTMLElement>('#blocks')!;
  const net = root.querySelector<HTMLElement>('#net')!;
  const seen: (Block & { at: number })[] = [];
  let stop: Cleanup | undefined;
  let dead = false;

  const draw = () => {
    list.innerHTML =
      seen
        .map(
          b => `<div class="blk"><span class="n">#${b.number.toLocaleString('en-US')}</span>
            <span class="h">${esc(b.hash)}</span>
            <span class="t">${new Date(b.at).toLocaleTimeString('es-MX', { hourCycle: 'h23' })}</span></div>`,
        )
        .join('') + '<div class="skeleton"></div>'.repeat(5 - seen.length);
  };

  subscribeFinalized(
    b => {
      if (seen[0]?.hash === b.hash) return;
      seen.unshift({ ...b, at: Date.now() });
      seen.length = Math.min(seen.length, 5);
      net.className = 'pill live';
      net.innerHTML = `${icon('broadcast')}finalizado`;
      draw();
    },
    () => {
      net.className = 'pill warn';
      net.innerHTML = `${icon('warningCircle')}sin conexión`;
    },
  )
    .then(u => (dead ? u() : (stop = u)))
    .catch(() => {
      net.className = 'pill warn';
      net.innerHTML = `${icon('warningCircle')}sin conexión`;
      list.innerHTML = `<p class="muted">No se pudo conectar a la red. Reintenta en unos segundos.</p>`;
    });

  return () => {
    dead = true;
    stop?.();
  };
}
