# Deploy y operación

## Publicar la app en Products Devnet

Requisitos: [`pad`](https://docs.polkadotcommunity.foundation/) en su última versión
(0.16.7 al 25 sep 2026), Node 22 o más y Polkadot App en el celular. Antes del
primer deploy revisa la lista de
[la revisión de plataforma](platform-review-2026-09-25.md#antes-del-deploy):
cuenta nueva tras la actualización de septiembre, autorización de Bulletin y
cuenta mapeada.

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
| 6 a 8 | Requiere **Full** Personhood; si no la tienes, el registro falla después de la transacción de commit |
| 9 o más | Registro abierto |

`testalk` tiene 7 y está libre (consultado el 25 sep 2026). Si la cuenta no
tiene Full Personhood, usa un nombre de 9 o más (por ejemplo `testalk26`) y
cámbialo en tres lugares **antes** de registrar nada
([H3](platform-review-2026-09-25.md#h3-testalkdot-requiere-full-personhood)):

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
- [ ] Abrir `testalk.dot/#/diagnostico` en Polkadot Desktop **y** en el celular, pulsar **Probar con subida a Bulletin** y guardar el reporte. Todo debe salir en verde salvo lo marcado como opcional.
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
- [ ] Anclar el recibo ese mismo día: `cd contract && npm run anchor -- <recibo.json>`

## Comportamiento conocido del devnet

Medido por [TWR.DOT](https://github.com/TheWhiteRabbitM/TWR.DOT/blob/master/docs/devnet-issues.md)
con apps reales en el contenedor. testalk ya está escrito para convivir con esto:

| Hecho | Consecuencia en testalk |
|---|---|
| En **Android** la subida de preimages falla con un error de codec; en **Desktop 0.1.1** funciona | Sellar siempre desde Polkadot Desktop. El público puede verificar desde el celular. |
| La subida tarda unos **64 s** | El paso de subida avisa "hasta 1 min" y espera hasta 90 s |
| `BulletinAllowance` responde `NotAvailable` y la subida funciona igual | `NotAvailable` es un aviso; solo `Rejected` detiene |
| `lookup` reporta `null` hasta encontrar el preimage | El verificador ignora los `null` y espera hasta 20 s |
| La red dentro del contenedor necesita el permiso `Remote` por dominio | Se piden al arrancar: `localhost`, el gateway IPFS y los RPC públicos |
| `localStorage` se vacía con cada release | El borrador de la charla dura la sesión; no publiques una versión nueva durante una charla |
| `SignerManager` entrega una cuenta de producto de la app, nunca la identidad del usuario | Pendiente: firmar con la identidad `.dot` ([H2](platform-review-2026-09-25.md#h2-la-firma-sale-de-una-cuenta-de-producto-no-de-la-identidad-del-speaker)) |
| En `*.dev-dot.li` el web shell no deriva cuentas de producto (TWR #18) | Presentar solo desde Polkadot Desktop; verificar sí funciona ahí |

## Si algo falla

| Síntoma | Qué hacer |
|---|---|
| "sin transcriptor" en vivo | Seguir hablando; escribir frases clave en "Añadir frase a mano". El WAV se sigue grabando. |
| Asset Hub no conecta | No empezar: sin ancla de inicio el recibo no prueba nada. Revisar la red. |
| La firma no llega | Revisar el celular; el botón **Reintentar** vuelve a pedirla sin perder la charla. |
| Bulletin no confirma | La charla ya está firmada: **Reintentar subida** no vuelve a pedir la firma. Si persiste, **Seguir sin Bulletin** y descargar el JSON; se verifica igual con el CLI. |
| Se recargó la página | En preparación aparece **Recuperar charla sin sellar**. |
