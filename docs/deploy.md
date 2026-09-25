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
npm run deploy     # npm run build && PAD_ENV=devnet pad dist devnet-test-talk26.dot
```

- Corre `pad` en una terminal propia: pide confirmaciones interactivas.
- `PAD_ENV=devnet` es obligatorio: el entorno por defecto de `pad` es otro.
- `polkadot-app-deploy.config.ts` escribe el manifest y los text records en DotNS. Su `icon` debe ser PNG o JPEG.
- `pad` es idempotente: si se corta a media subida, se vuelve a correr.

Comprobación: el CID final debe resolver en
`https://devnet-ipfs.api.polkadotcommunity.foundation/ipfs/<CID>/`.

### Nombre de dominio

Regla del protocolo v2 de DotNS, tal como la aplica `pad` 0.16.7 en su
verificación previa: los dígitos al final deben ser **0 o 2**, y lo demás es
la **base**.

| Base | Regla DotNS |
|---|---|
| 5 caracteres o menos | Reservado |
| 6 a 8 | Personhood Lite (con 2 dígitos) o Full (sin dígitos) |
| 9 o más | Registro abierto (NoStatus) |

El dominio es **`devnet-test-talk26`**: base de 16, dos dígitos, registro
abierto, libre al 25 sep 2026. `testalk` (base 7) y `testalk26` (base 7 más
dos dígitos) piden personhood: `testalk26` falló en la verificación previa de
`pad` con *"requires ProofOfPersonhoodLite, but this signer is NoStatus"*,
antes de gastar nada
([H3](platform-review-2026-09-25.md#h3-testalkdot-requiere-full-personhood)).
Si alguna vez cambia, cámbialo en tres lugares **antes** de registrar nada:

- `app/package.json` → script `deploy`
- `app/polkadot-app-deploy.config.ts` → `domain`
- `app/src/lib/network.ts` → `APP_LABEL` (define la URL del QR, el gateway y la cuenta de producto de la app)

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
- [ ] Abrir `devnet-test-talk26.dot/#/diagnostico` en Polkadot Desktop **y** en el celular, pulsar **Probar con subida a Bulletin** y guardar el reporte. Todo debe salir en verde salvo lo marcado como opcional. Las filas clave: **Firma con identidad .dot**, **Bulletin: subida y clave** y las dos lecturas.
- [ ] Abrir `https://devnet-test-talk26.dev-dot.li/#/<CID de la prueba>` en un celular **sin** Polkadot App: debe abrir el recibo (el gateway conserva el `#`).
- [ ] Charla de prueba completa en Desktop, sellada y verificada desde otro celular
- [ ] Confirmar que el QR proyectado se lee desde el fondo de la sala

**Una hora antes**
- [ ] Laptop conectada a corriente y a una red estable
- [ ] Micrófono correcto (`--list-mics`); sin audífonos Bluetooth robando la entrada
- [ ] Transcriptor arrancado y con el modelo caliente
- [ ] Polkadot Desktop abierto en `devnet-test-talk26.dot/#/presentar`
- [ ] Wallet conectada: la fila de wallet en verde y diciendo **Firmarás con tu identidad .dot**
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
| La subida tarda unos **64 s** (37 bytes) | El paso de subida avisa "1 a 3 min", espera hasta 180 s y, si se reintenta, busca primero si ya subió |
| `BulletinAllowance` responde `NotAvailable` y la subida funciona igual | `NotAvailable` es un aviso; solo `Rejected` detiene |
| `lookup` reporta `null` hasta encontrar el preimage | El verificador ignora los `null` y espera hasta 20 s |
| La red dentro del contenedor necesita el permiso `Remote` por dominio | Se piden al arrancar: `localhost`, el gateway IPFS y los RPC públicos |
| `localStorage` se vacía con cada release | El borrador de la charla dura la sesión; no publiques una versión nueva durante una charla |
| `SignerManager` entrega una cuenta de producto de la app, nunca la identidad del usuario | Se firma con la cuenta dueña del username en People chain; la de producto queda de respaldo y el recibo lo refleja |
| En `*.dev-dot.li` el web shell no deriva cuentas de producto (TWR #18) | Presentar solo desde Polkadot Desktop; verificar sí funciona ahí |

## Si algo falla

| Síntoma | Qué hacer |
|---|---|
| "sin transcriptor" en vivo | Seguir hablando; escribir frases clave en "Añadir frase a mano". El WAV se sigue grabando. |
| Asset Hub no conecta | No empezar: sin ancla de inicio el recibo no prueba nada. Revisar la red. |
| La firma no llega | Revisar el celular; el botón **Reintentar** vuelve a pedirla sin perder la charla. |
| La firma con identidad falla | **Firmar con la cuenta de la app**: el recibo vale, pero no queda ligado a tu username. |
| Bulletin no confirma | La charla ya está firmada: **Reintentar subida** no vuelve a pedir la firma y revisa primero si ya subió. Si persiste, **Seguir sin Bulletin** y descargar o **copiar** el JSON; se verifica igual con el CLI. |
| Se recargó la página | En preparación aparece **Recuperar charla sin sellar**. |
