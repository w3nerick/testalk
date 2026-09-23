# Deploy y operación

## Publicar la app en Products Devnet

Requisitos: [`pad`](https://docs.polkadotcommunity.foundation/) 0.16.6 o superior
y Polkadot App en el celular.

```bash
cd app
npm install
pad login          # una vez; QR con Polkadot App. El handshake puede tardar minutos.
npm run deploy     # npm run build && PAD_ENV=devnet pad dist testalk.dot
```

- Corre `pad` en una terminal propia: pide confirmaciones interactivas.
- `PAD_ENV=devnet` es obligatorio: el entorno por defecto de `pad` es otro.
- `polkadot-app-deploy.config.ts` escribe el manifest y los text records en DotNS. Su `icon` debe ser PNG o JPEG.
- `pad` es idempotente: si se corta a media subida, se vuelve a correr.

Comprobación: el CID final debe resolver en
`https://devnet-ipfs.api.polkadotcommunity.foundation/ipfs/<CID>/`.

### Nombre de dominio

| Longitud | Regla DotNS |
|---|---|
| 5 caracteres o menos | Reservado |
| 6 a 8 | Requiere proof of personhood |
| 9 o más | Registro abierto |

`testalk` tiene 7. Si la cuenta no califica, usa un nombre de 9 o más (por
ejemplo `testalk26`) y cámbialo en tres lugares:

- `app/package.json` → script `deploy`
- `app/polkadot-app-deploy.config.ts` → `domain`
- `app/src/lib/signer.ts` → `APP_DOTNS` (también define la URL del QR)

## Preparar la laptop del speaker

```bash
cd stt
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python testalk_stt.py --list-mics
.venv/bin/python testalk_stt.py --device <N> --language es --model small
```

Espera la línea `[boot] listo` antes de subir al escenario. `small` es el punto
de equilibrio en CPU; `medium` mejora jerga técnica con más latencia.

## Checklist del día del evento

**Una semana antes**
- [ ] Charla de prueba completa en Desktop, sellada y verificada desde otro celular
- [ ] Confirmar que el QR proyectado se lee desde el fondo de la sala

**Una hora antes**
- [ ] Laptop conectada a corriente y a una red estable
- [ ] Micrófono correcto (`--list-mics`); sin audífonos Bluetooth robando la entrada
- [ ] Transcriptor arrancado y con el modelo caliente
- [ ] Polkadot Desktop abierto en `testalk.dot/#/presentar`
- [ ] Wallet conectada: la fila de wallet en verde
- [ ] Las tres filas de preparación en verde

**Al terminar**
- [ ] Pulsar **Sellar charla** y aprobar la firma en el celular
- [ ] Dejar el QR en pantalla el tiempo suficiente para que escaneen
- [ ] Descargar el JSON y guardar el WAV de `stt/grabaciones/`: Bulletin borra a los 14 días

## Si algo falla

| Síntoma | Qué hacer |
|---|---|
| "sin transcriptor" en vivo | Seguir hablando; escribir frases clave en "Añadir frase a mano". El WAV se sigue grabando. |
| Asset Hub no conecta | No empezar: sin ancla de inicio el recibo no prueba nada. Revisar la red. |
| La firma no llega | Revisar el celular; el botón **Reintentar** vuelve a pedirla sin perder la charla. |
| Bulletin no confirma | Reintentar. Si persiste, descargar el JSON: se verifica igual con el CLI. |
| Se recargó la página | En preparación aparece **Recuperar charla sin sellar**. |
