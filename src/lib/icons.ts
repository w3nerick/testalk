// Íconos de Phosphor (regular / fill), inlineados como SVG para no cargar la fuente completa.
import microphone from '@phosphor-icons/core/regular/microphone.svg?raw';
import microphoneSlash from '@phosphor-icons/core/regular/microphone-slash.svg?raw';
import sealCheck from '@phosphor-icons/core/regular/seal-check.svg?raw';
import sealWarning from '@phosphor-icons/core/regular/seal-warning.svg?raw';
import cube from '@phosphor-icons/core/regular/cube.svg?raw';
import broadcast from '@phosphor-icons/core/regular/broadcast.svg?raw';
import signature from '@phosphor-icons/core/regular/signature.svg?raw';
import qrCode from '@phosphor-icons/core/regular/qr-code.svg?raw';
import shieldCheck from '@phosphor-icons/core/regular/shield-check.svg?raw';
import waveform from '@phosphor-icons/core/regular/waveform.svg?raw';
import fileArrowUp from '@phosphor-icons/core/regular/file-arrow-up.svg?raw';
import copy from '@phosphor-icons/core/regular/copy.svg?raw';
import arrowRight from '@phosphor-icons/core/regular/arrow-right.svg?raw';
import arrowLeft from '@phosphor-icons/core/regular/arrow-left.svg?raw';
import downloadSimple from '@phosphor-icons/core/regular/download-simple.svg?raw';
import warningCircle from '@phosphor-icons/core/regular/warning-circle.svg?raw';
import checkCircle from '@phosphor-icons/core/regular/check-circle.svg?raw';
import xCircle from '@phosphor-icons/core/regular/x-circle.svg?raw';
import clock from '@phosphor-icons/core/regular/clock.svg?raw';
import mapPin from '@phosphor-icons/core/regular/map-pin.svg?raw';
import stopCircle from '@phosphor-icons/core/regular/stop-circle.svg?raw';
import play from '@phosphor-icons/core/regular/play.svg?raw';
import pencilSimple from '@phosphor-icons/core/regular/pencil-simple.svg?raw';
import circleNotch from '@phosphor-icons/core/regular/circle-notch.svg?raw';
import question from '@phosphor-icons/core/regular/question.svg?raw';
import sealFill from '@phosphor-icons/core/fill/seal-check-fill.svg?raw';

const set = {
  microphone,
  microphoneSlash,
  sealCheck,
  sealWarning,
  cube,
  broadcast,
  signature,
  qrCode,
  shieldCheck,
  waveform,
  fileArrowUp,
  copy,
  arrowRight,
  arrowLeft,
  downloadSimple,
  warningCircle,
  checkCircle,
  xCircle,
  clock,
  mapPin,
  stopCircle,
  play,
  pencilSimple,
  circleNotch,
  question,
  sealFill,
};

export type IconName = keyof typeof set;

export function icon(name: IconName, cls = ''): string {
  return set[name].replace('<svg ', `<svg class="ico ${cls}" aria-hidden="true" `);
}
