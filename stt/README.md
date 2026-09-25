# stt: transcriptor local

Escucha el micrófono, corta frases con `webrtcvad`, las transcribe con
[`faster-whisper`](https://github.com/SYSTRAN/faster-whisper) y las envía a la
app por `ws://localhost:8787`. Cada frase queda también en
`grabaciones/charla-AAAAMMDD-HHMMSS.jsonl`. El audio **no** se guarda: el recibo
lleva solo texto y la referencia externa es el video de la charla. Con
`--guardar-audio` se escribe además un WAV local, que no entra al recibo.

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

.venv/bin/python testalk_stt.py --list-mics
.venv/bin/python testalk_stt.py --device 2 --language es --model small
.venv/bin/python testalk_stt.py --demo guion-demo.txt      # ensayo sin micrófono
```

Usa Python 3.10–3.13. En Mac Intel, `onnxruntime` (lo pide faster-whisper) no
tiene rueda para 3.14 y pip acaba intentando compilar `av` viejo, que falla con
`pkg-config is required for building PyAV`. Solución: `brew install python@3.13`
y crear la venv con `python3.13 -m venv .venv`.

Referencia (i9-8950HK, CPU, int8): `small` transcribe 4.9 s de audio en 2.0 s y
`base` en 0.7 s. La primera pasada tras cargar el modelo es más lenta.

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

La app no le manda nada al servidor: solo recibe frases.
