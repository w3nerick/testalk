# stt: transcriptor local

Escucha el micrófono, corta frases con `webrtcvad`, las transcribe con
[`faster-whisper`](https://github.com/SYSTRAN/faster-whisper) y las envía a la
app por `ws://localhost:8787`. El audio se graba **siempre** en
`grabaciones/charla-AAAAMMDD-HHMMSS.wav`, falle o no la transcripción.

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

.venv/bin/python testalk_stt.py --list-mics
.venv/bin/python testalk_stt.py --device 2 --language es --model small
.venv/bin/python testalk_stt.py --demo guion-demo.txt      # ensayo sin micrófono
```

| Opción | Por defecto | Uso |
|---|---|---|
| `--model` | `small` | `tiny`, `base`, `small`, `medium`, `large-v3` |
| `--language` | `es` | Idioma de la charla |
| `--device` | sistema | Índice de `--list-mics` |
| `--vad` | `2` | 0 = permisivo, 3 = estricto con el ruido |
| `--port` | `8787` | Puerto WebSocket |
| `--demo` | | Archivo de texto: una línea cada ~4 s, sin micrófono ni modelo |

## Protocolo

Servidor → app, una vez por frase terminada:

```json
{ "type": "final", "text": "y eso es lo que hace caro falsificar.", "wall_ts": "2026-10-30T16:32:55.123Z" }
```

App → servidor al sellar, y respuesta:

```json
{ "type": "seal" }
{ "type": "audio", "hash": "0x…", "bytes": 48213004, "seconds": 1506.9, "file": "charla-20261030-101500.wav" }
```

`hash` es blake2b-256 del WAV completo. Después del sellado el WAV queda
cerrado y no se modifica.
