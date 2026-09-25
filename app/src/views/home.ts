import { icon } from '../lib/icons';
import { subscribeFinalized, type Block } from '../lib/chain';
import { voiceField } from '../lib/ascii';
import { esc, topbar, type Cleanup } from '../ui';

export function renderHome(root: HTMLElement): Cleanup {
  root.innerHTML = `
    ${topbar()}
    <main>
      <section class="shell hero">
        <div class="hero-copy">
          <span class="eyebrow">Proof of Talk en Polkadot</span>
          <h1>Lo que dices, <em>firmado</em> y anclado a Polkadot.</h1>
          <p class="lead">Tu charla se transcribe en vivo, se entrelaza con bloques reales y la sellas con tu wallet.</p>
          <div class="ctas">
            <a class="btn primary big" href="#/presentar">${icon('microphone')}Presentar</a>
            <a class="btn big" href="#/verificar">${icon('shieldCheck')}Verificar recibo</a>
          </div>
        </div>
        <aside class="console" aria-label="Asset Hub en vivo">
          <div class="console-head">
            <span>Asset Hub en vivo</span>
            <span class="pill off" id="net"><i class="aspin"></i>conectando</span>
          </div>
          <pre class="voice" id="voice" aria-hidden="true"></pre>
          <div class="blocks" id="blocks" aria-live="polite">
            ${'<div class="skeleton"></div>'.repeat(4)}
          </div>
        </aside>
      </section>
      <div class="dither-band"></div>
      <section class="shell" aria-label="Cómo funciona"><div class="flow">
        <div>${icon('waveform')}<h3>Hablas</h3><p>Whisper convierte cada frase en texto, en tu laptop.</p></div>
        <div>${icon('cube')}<h3>Se ancla</h3><p>Entre frases entra el hash de un bloque que nadie podía conocer antes.</p></div>
        <div>${icon('signature')}<h3>Firmas</h3><p>Una sola firma sr25519 con tu wallet cubre todo el recibo.</p></div>
        <div>${icon('qrCode')}<h3>Cualquiera verifica</h3><p>Un QR abre el recibo y lo comprueba contra la cadena.</p></div>
      </div></section>
      <footer class="shell"><div class="foot">
        <a href="#/diagnostico">Diagnóstico del dispositivo</a>
        <span>Products Devnet</span>
      </div></footer>
    </main>`;

  const list = root.querySelector<HTMLElement>('#blocks')!;
  const net = root.querySelector<HTMLElement>('#net')!;
  const field = voiceField(root.querySelector<HTMLElement>('#voice')!);
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
        .join('') + '<div class="skeleton"></div>'.repeat(4 - seen.length);
  };
  const offline = () => {
    net.className = 'pill warn';
    net.innerHTML = `${icon('warningCircle')}sin conexión`;
  };

  subscribeFinalized(
    b => {
      if (seen[0]?.hash === b.hash) return;
      seen.unshift({ ...b, at: Date.now() });
      seen.length = Math.min(seen.length, 4);
      net.className = 'pill live';
      net.innerHTML = `${icon('broadcast')}finalizado`;
      field.stamp(`#${b.number.toLocaleString('en-US')}`);
      draw();
    },
    offline,
  )
    .then(u => (dead ? u() : (stop = u)))
    .catch(() => {
      offline();
      list.innerHTML = `<p class="console-note">No se pudo conectar a la red. Reintenta en unos segundos.</p>`;
    });

  return () => {
    dead = true;
    stop?.();
    field.stop();
  };
}
