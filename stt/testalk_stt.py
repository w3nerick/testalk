"""
Transcriptor local de testalk.

Escucha el micrófono, corta frases con webrtcvad, las transcribe con
faster-whisper y las emite por ws://localhost:8787 a la app. El audio se graba
SIEMPRE a WAV, pase lo que pase con la transcripción.

Cuando la app sella la charla envía {"type": "seal"}: se cierra el WAV y se
responde con su huella blake2b-256, que queda dentro del recibo firmado.

Arquitectura inspirada en el companion de Proof of Talk (Karim Jedda).

Uso:
  python testalk_stt.py --list-mics
  python testalk_stt.py --language es --model small
  python testalk_stt.py --device 2 --model medium
  python testalk_stt.py --demo guion.txt        # sin micrófono ni modelo: para ensayar
"""

from __future__ import annotations

import argparse
import asyncio
import concurrent.futures
import hashlib
import json
import queue
import signal
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

SAMPLE_RATE = 16_000          # whisper espera 16 kHz mono
FRAME_MS = 30                 # webrtcvad acepta 10 / 20 / 30 ms
FRAME_SAMPLES = SAMPLE_RATE * FRAME_MS // 1000
START_FRAMES = 3              # ~90 ms de voz para abrir una frase
END_FRAMES = 17               # ~510 ms de silencio para cerrarla
MAX_FRAMES = SAMPLE_RATE * 12 // FRAME_SAMPLES  # tope de ~12 s por frase
PREROLL_FRAMES = 7            # ~210 ms antes del inicio, para no cortar la primera palabra


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def file_blake2b(path: Path) -> str:
    h = hashlib.blake2b(digest_size=32)
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return "0x" + h.hexdigest()


class Hub:
    """Clientes WebSocket conectados + historial corto para quien llega tarde."""

    def __init__(self) -> None:
        self.clients: set = set()
        self.history: list[dict] = []

    async def add(self, ws) -> None:
        self.clients.add(ws)
        for ev in self.history[-10:]:
            try:
                await ws.send(json.dumps(ev))
            except Exception:
                pass

    async def send_all(self, ev: dict, keep: bool = True) -> None:
        if keep:
            self.history = (self.history + [ev])[-50:]
        msg = json.dumps(ev)
        for ws in list(self.clients):
            try:
                await ws.send(msg)
            except Exception:
                self.clients.discard(ws)


class Recorder:
    """WAV + JSONL siempre en disco, independiente del STT."""

    def __init__(self, out: Path) -> None:
        import soundfile as sf

        out.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        self.wav_path = out / f"charla-{stamp}.wav"
        self.jsonl_path = out / f"charla-{stamp}.jsonl"
        self.wav = sf.SoundFile(str(self.wav_path), mode="w", samplerate=SAMPLE_RATE, channels=1, subtype="PCM_16")
        self.jsonl = open(self.jsonl_path, "a", buffering=1, encoding="utf-8")
        self.frames = 0
        self.closed = False

    def audio(self, samples) -> None:
        if self.closed:
            return
        self.wav.write(samples)
        self.frames += 1
        if self.frames % 100 == 0:
            self.wav.flush()

    def event(self, ev: dict) -> None:
        if not self.closed:
            self.jsonl.write(json.dumps(ev, ensure_ascii=False) + "\n")

    def seal(self) -> dict:
        """Cierra el WAV y devuelve su huella. Idempotente."""
        if not self.closed:
            self.closed = True
            self.wav.close()
            self.jsonl.close()
        return {
            "type": "audio",
            "hash": file_blake2b(self.wav_path),
            "bytes": self.wav_path.stat().st_size,
            "seconds": round(self.frames * FRAME_MS / 1000, 1),
            "file": self.wav_path.name,
        }


def vad_loop(audio_q: "queue.Queue", vad, on_utterance) -> None:
    import numpy as np

    preroll: list = []
    buf: list = []
    speech = silence = 0
    active = False
    while True:
        frame = audio_q.get()
        if frame is None:
            return
        try:
            is_speech = vad.is_speech(frame.tobytes(), SAMPLE_RATE)
        except Exception:
            continue
        if not active:
            preroll = (preroll + [frame])[-PREROLL_FRAMES:]
            speech = speech + 1 if is_speech else 0
            if speech >= START_FRAMES:
                active, buf, preroll, silence = True, list(preroll), [], 0
            continue
        buf.append(frame)
        silence = 0 if is_speech else silence + 1
        if silence >= END_FRAMES or len(buf) >= MAX_FRAMES:
            on_utterance(np.concatenate(buf))
            active, buf, speech, silence = False, [], 0, 0


async def main() -> None:
    ap = argparse.ArgumentParser(description="Transcriptor local de testalk")
    ap.add_argument("--list-mics", action="store_true")
    ap.add_argument("--device", type=int, default=None, help="índice del micrófono")
    ap.add_argument("--model", default="small", help="tiny | base | small | medium | large-v3")
    ap.add_argument("--compute-type", default="int8")
    ap.add_argument("--language", default="es")
    ap.add_argument("--vad", type=int, default=2, choices=[0, 1, 2, 3])
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--out", default="grabaciones")
    ap.add_argument("--demo", default=None, help="archivo de texto: emite una línea cada ~4 s, sin micrófono")
    args = ap.parse_args()

    import websockets

    if args.list_mics:
        import sounddevice as sd

        for i, d in enumerate(sd.query_devices()):
            if d["max_input_channels"] > 0:
                print(f"  [{i:>2}] {d['name']}")
        return

    hub = Hub()
    loop = asyncio.get_running_loop()
    recorder: Recorder | None = None
    stop = asyncio.Event()

    async def handler(ws) -> None:
        await hub.add(ws)
        print("[ws] app conectada", flush=True)
        try:
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except Exception:
                    continue
                if msg.get("type") == "seal":
                    if recorder is None:
                        await ws.send(json.dumps({"type": "audio", "hash": None}))
                        continue
                    ev = recorder.seal()
                    print(f"[seal] {ev['file']}  {ev['seconds']} s  {ev['hash']}", flush=True)
                    await ws.send(json.dumps(ev))
        finally:
            hub.clients.discard(ws)

    server = await websockets.serve(handler, "localhost", args.port)
    print(f"[ws] escuchando en ws://localhost:{args.port}", flush=True)

    async def emit(text: str) -> None:
        ev = {"type": "final", "text": text, "wall_ts": utc_now()}
        if recorder:
            recorder.event(ev)
        print(f"  > {text}", flush=True)
        await hub.send_all(ev)

    stream = None
    audio_q: "queue.Queue" = queue.Queue()

    if args.demo:
        lines = [l.strip() for l in Path(args.demo).read_text(encoding="utf-8").splitlines() if l.strip()]

        async def demo() -> None:
            while not hub.clients:
                await asyncio.sleep(0.5)
            await asyncio.sleep(2)
            for l in lines:
                await emit(l)
                await asyncio.sleep(4)
            print("[demo] guion terminado", flush=True)

        asyncio.create_task(demo())
        print(f"[demo] {len(lines)} líneas; empiezan cuando la app se conecte", flush=True)
    else:
        import numpy as np
        import sounddevice as sd
        import webrtcvad
        from faster_whisper import WhisperModel

        print(f"[boot] cargando whisper '{args.model}' ({args.compute_type})…", flush=True)
        t0 = time.time()
        model = WhisperModel(args.model, device="cpu", compute_type=args.compute_type)
        list(model.transcribe(np.zeros(SAMPLE_RATE, dtype=np.float32), language=args.language)[0])
        print(f"[boot] listo en {time.time() - t0:.1f} s", flush=True)

        recorder = Recorder(Path(args.out))
        pool = concurrent.futures.ThreadPoolExecutor(max_workers=1)

        def transcribe(samples) -> str:
            segs, _ = model.transcribe(
                samples.astype(np.float32) / 32768.0,
                language=args.language,
                vad_filter=False,
                beam_size=1,
                condition_on_previous_text=False,
                no_speech_threshold=0.5,
            )
            return "".join(s.text for s in segs).strip()

        async def handle(samples) -> None:
            try:
                text = await loop.run_in_executor(pool, transcribe, samples)
            except Exception as e:
                print(f"[stt] error: {e}", file=sys.stderr)
                return
            if text:
                await emit(text)

        def on_utterance(samples) -> None:
            asyncio.run_coroutine_threadsafe(handle(samples), loop)

        def on_audio(indata, frames, t, status) -> None:
            s = (indata[:, 0] * 32767.0).astype(np.int16)
            audio_q.put(s)
            recorder.audio(s)

        stream = sd.InputStream(
            samplerate=SAMPLE_RATE, channels=1, dtype="float32",
            callback=on_audio, blocksize=FRAME_SAMPLES, device=args.device,
        )
        stream.start()
        loop.run_in_executor(None, vad_loop, audio_q, webrtcvad.Vad(args.vad), on_utterance)
        print(f"[mic] grabando en {recorder.wav_path}", flush=True)

    print("[listo] Ctrl+C para salir", flush=True)
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:
            pass
    await stop.wait()

    audio_q.put(None)
    if stream:
        stream.stop()
        stream.close()
    if recorder:
        recorder.seal()
    server.close()
    await server.wait_closed()
    print("\n[fin]")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
