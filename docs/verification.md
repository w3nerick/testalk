# Verificación y modelo de amenazas

## Qué hace el verificador

El verificador web (`#/<CID>` o `#/verificar`) y el CLI (`npm run verify`)
ejecutan el mismo código, [`app/src/lib/artifact.ts`](../app/src/lib/artifact.ts):

1. **Firma.** Recalcula los bytes canónicos y comprueba `sig` contra `pubkey` con `signatureVerify`. Cualquier cambio en cualquier campo firmado la invalida.
2. **Identidad.** La dirección que se muestra sale de `pubkey`, nunca del recibo. Si `speaker_address` no corresponde a `pubkey`: **Dirección falsa**. Si hay `dotns`, pregunta a People chain de quién es ese username (`Resources.UsernameOwnerOf`) y exige que sea `pubkey`.
3. **Bloques.** Si `genesis` coincide con Asset Hub del devnet, pide a la cadena el hash de cada altura (`archive_v1_hashByHeight`, con `chain_getBlockHash` de respaldo) y lo compara con `full`.
4. **Sello permanente.** Consulta `get(huella)` en `TalkRegistry` (pallet-revive) con una simulación que no firma. Informativo: no cambia el veredicto.

| Resultado | Veredicto |
|---|---|
| Firma válida y bloques confirmados | **Charla verificada** |
| Firma válida, bloques sin respuesta u otra red | **Charla verificada**, con aviso en la fila de bloques |
| Firma válida, algún hash no coincide | **Anclaje falso** |
| Firma válida, pero el username o la dirección son de otra cuenta | **Identidad falsa** |
| Firma válida, sin username | **Charla verificada**, con aviso: la firma prueba una llave, no un nombre |
| Firma inválida | **Recibo alterado** |

Karim publicó su verificador solo con la comprobación de firma. Un recibo con
hashes inventados pero bien firmado le pasaría; aquí no.

## Qué prueba

- **Integridad.** El texto, el título, el evento, las horas y los bloques son exactamente los que firmó la llave.
- **Autoría de la llave.** Solo quien controla la llave privada de `pubkey` pudo producir la firma.
- **Identidad** (si la fila sale en verde). Esa llave es la dueña del username `dotns` en People chain.
- **Cota inferior de tiempo.** El hash de un bloque es impredecible antes de que el bloque exista. El texto que sigue a un bloque no pudo fijarse antes de ese bloque.
- **Cota superior de tiempo** (si está anclado). El bloque en que `TalkRegistry` guardó la huella: el recibo existía a más tardar entonces.

## Qué no prueba

| Límite | Consecuencia | Mitigación posible |
|---|---|---|
| El recibo no lleva audio | La firma no demuestra que la voz sea del firmante | El video de la charla muestra quién habló |
| Ventana entre la charla y el anclaje | Alguien podría juntar block hashes durante una charla y escribir el texto después, hasta que se ancla | Anclar en `TalkRegistry` en cuanto termina la charla: la ventana queda fijada on-chain y es visible |
| La llave no prueba humanidad | Un bot con llave puede firmar | Individuality / proof of personhood cuando esté disponible |
| `speaker` lo declara la app | Es solo el nombre mostrado | El verificador lo marca como declarado; la identidad la da `dotns` comprobado en People chain |
| Firmado con la cuenta de la app | Si el host no firma con la identidad `.dot`, la llave es una cuenta de producto que nadie puede ligar a un username | El recibo lleva `dotns` vacío y el verificador lo dice; medir el camino de identidad con `#/diagnostico` |
| Bulletin borra a los 14 días | Pasado ese plazo el QR deja de resolver | `TalkRegistry` conserva huella y firma; el JSON guardado sigue verificándose con el CLI y se ata al sello por su huella |
| Whisper puede equivocarse | El texto firmado es la transcripción, no lo dicho palabra por palabra | El video de la charla es la referencia |

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
| [`examples/impersonated-uanl.json`](../examples/impersonated-uanl.json) | Firmado por `//Bob` pero declara ser `alice.dot` con la dirección de `//Alice`: **Identidad falsa** (dirección falsa). CI exige que se rechace |
