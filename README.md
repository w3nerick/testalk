# testalk

Graba una charla, entrelaza cada frase con block hashes reales de Asset Hub,
fírmala con tu wallet y publica un recibo en Bulletin. El público escanea el QR
con Polkadot App y verifica la firma y los bloques.

Réplica para el Products Devnet del modelo **Proof of Talk** de Karim Jedda
(Web3 Summit 2026). Mismo formato de artefacto v1: un recibo suyo se verifica
aquí, y uno nuestro sigue su convención de firma.

## Qué prueba y qué no

| Prueba | No prueba |
|---|---|
| Esta llave firmó exactamente este texto | Que la voz sea del firmante |
| El texto no existía antes del primer bloque | Que se haya dicho en vivo (el límite "no después de" es el sellado) |
| Los block hashes existen en Asset Hub | Que el firmante sea humano (falta Individuality) |
| Si el speaker comparte el WAV, que es el mismo audio (huella blake2b-256) | Que el contenido sea cierto |

## Diferencias con el original

- Bloques **finalizados**, no `bestBlocks$`: un bloque best puede quedar huérfano y el verificador lo daría por falso.
- El verificador **consulta cada block hash en la cadena**. El original solo revisa la firma.
- Huella del WAV dentro del recibo firmado.
- Remache de bloque al cerrar, para que las últimas frases también queden entre dos bloques.
- Identidad vía `SignerManager` (en este devnet `getLegacyAccountSigner` no abre la hoja de firma).
- QR con `https://testalk.dot/#/<cid>`, el único deep link que entra al contenedor.

## Uso

```bash
npm install
npm run dev          # fuera de Polkadot App: modo ensayo, firma con //Alice, sin Bulletin
npm run build
```

Transcriptor (en la laptop del speaker):

```bash
cd stt
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python testalk_stt.py --language es --model small   # micrófono real
.venv/bin/python testalk_stt.py --demo guion-demo.txt          # ensayo sin micrófono
```

La primera corrida descarga el modelo de Whisper (~480 MB para `small`).
El audio se guarda siempre en `stt/grabaciones/`.

## Deploy (Terminal.app, no desde Claude Code)

```bash
pad login            # una vez, QR con Polkadot App
npm run deploy       # = build + PAD_ENV=devnet pad dist testalk.dot
```

`testalk` tiene 7 caracteres: DotNS pide personhood para nombres de 6 a 8. Si
la cuenta no califica, usar uno de 9 o más (p. ej. `testalk26.dot`) en
`package.json`, `polkadot-app-deploy.config.ts` y `APP_DOTNS` de `src/lib/signer.ts`.

## Pendiente

- Probar en Desktop que la app alcanza `ws://localhost:8787` desde el sandbox.
- Anclar `blake2(recibo) + firma` en un contrato de Asset Hub: Bulletin borra a los 14 días.
- Verificar en People chain que el username declarado sea dueño de la llave.
