# Verificación y modelo de amenazas

## Qué hace el verificador

El verificador web (`#/<CID>` o `#/verificar`) y el CLI (`npm run verify`)
ejecutan el mismo código, [`app/src/lib/artifact.ts`](../app/src/lib/artifact.ts):

1. **Firma.** Recalcula los bytes canónicos y comprueba `sig` contra `pubkey` con `signatureVerify`. Cualquier cambio en cualquier campo firmado la invalida.
2. **Bloques.** Si `genesis` coincide con Asset Hub del devnet, pide a la cadena el hash de cada altura (`archive_v1_hashByHeight`, con `chain_getBlockHash` de respaldo) y lo compara con `full`.
3. **Sello permanente.** Consulta `get(huella)` en `TalkRegistry` (pallet-revive) con una simulación que no firma. Informativo: no cambia el veredicto.
4. **Audio.** Muestra la huella del WAV si el recibo la incluye.

| Resultado | Veredicto |
|---|---|
| Firma válida y bloques confirmados | **Charla verificada** |
| Firma válida, bloques sin respuesta u otra red | **Charla verificada**, con aviso en la fila de bloques |
| Firma válida, algún hash no coincide | **Anclaje falso** |
| Firma inválida | **Recibo alterado** |

Karim publicó su verificador solo con la comprobación de firma. Un recibo con
hashes inventados pero bien firmado le pasaría; aquí no.

## Qué prueba

- **Integridad.** El texto, el título, el evento, las horas y los bloques son exactamente los que firmó la llave.
- **Autoría de la llave.** Solo quien controla la llave privada de `pubkey` pudo producir la firma.
- **Cota inferior de tiempo.** El hash de un bloque es impredecible antes de que el bloque exista. El texto que sigue a un bloque no pudo fijarse antes de ese bloque.
- **Cota superior de tiempo** (si está anclado). El bloque en que `TalkRegistry` guardó la huella: el recibo existía a más tardar entonces.
- **Mismo audio.** Si el speaker publica el WAV, cualquiera puede comprobar que su blake2b-256 coincide con `audio.hash`:

  ```bash
  b2sum -l 256 charla-20261030-101500.wav
  python3 -c "import hashlib,sys;print(hashlib.blake2b(open(sys.argv[1],'rb').read(),digest_size=32).hexdigest())" charla.wav
  ```

## Qué no prueba

| Límite | Consecuencia | Mitigación posible |
|---|---|---|
| El audio no va en el recibo | La firma no demuestra que la voz sea del firmante | Publicar el WAV; la huella lo ata al recibo |
| Ventana entre la charla y el anclaje | Alguien podría juntar block hashes durante una charla y escribir el texto después, hasta que se ancla | Anclar en `TalkRegistry` en cuanto termina la charla: la ventana queda fijada on-chain y es visible |
| La llave no prueba humanidad | Un bot con llave puede firmar | Individuality / proof of personhood cuando esté disponible |
| `speaker` y `dotns` los declara la app | Se firman, pero nadie comprueba que el username sea dueño de la llave | Consultar `Resources.UsernameOwnerOf` en People chain |
| Bulletin borra a los 14 días | Pasado ese plazo el QR deja de resolver | `TalkRegistry` conserva huella y firma; el JSON guardado sigue verificándose con el CLI y se ata al sello por su huella |
| Whisper puede equivocarse | El texto firmado es la transcripción, no el audio | El WAV sellado es la referencia |

## Recibos de ensayo

Fuera de Polkadot App la app firma con `//Alice`, una llave pública de
desarrollo que cualquiera conoce. Esos recibos llevan `"rehearsal": true` y el
verificador los marca como **Ensayo**. Sirven para probar el flujo, no como
evidencia.

## Ejemplos

| Archivo | Resultado esperado |
|---|---|
| [`examples/rehearsal-uanl.json`](../examples/rehearsal-uanl.json) | Firma válida, 5/5 bloques en Asset Hub, marcado como ensayo |
| [`examples/tampered-uanl.json`](../examples/tampered-uanl.json) | Igual, con "UANL" cambiado por "UNAM": firma inválida |
