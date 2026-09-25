# Revisión contra TWR.DOT y la documentación de PCF (25 sep 2026)

Pregunta: ¿funcionaría testalk en el Products Devnet tal como está hoy?

Respuesta corta: **la base está bien hecha y todo lo que se puede probar fuera
del dispositivo pasa**, pero hay dos problemas de fondo en la promesa del
producto (probar *quién* lo dijo), un bloqueante de deploy (el dominio) y
varias cosas que nadie ha medido en este host y que solo
[`#/diagnostico`](../app/src/views/diagnostics.ts) puede responder en Polkadot
Desktop y en el celular.

Los hallazgos se corrigieron en código el mismo día (dominio `devnet-test-talk26`); el
estado de cada uno está en [Estado](#estado). Lo que depende del dispositivo
sigue abierto hasta correr el diagnóstico.

## Fuentes

| Fuente | Versión o fecha |
|---|---|
| [TWR.DOT](https://github.com/TheWhiteRabbitM/TWR.DOT): `docs/devnet-issues.md`, `DEVFEEDBACK.md`, `peoplebook/src/claim.ts` y ~30 apps | commit `3d3c6d5`, 25 sep 2026 |
| [Docs de PCF](https://docs.polkadotcommunity.foundation/): packages, platform services SDK, build and publish, networks, app delivery, storage, discover and open apps, devnet update de septiembre | leídas el 25 sep 2026 |
| Código fuente del SDK instalado: `@parity/product-sdk-host` 0.21.0, `@parity/product-sdk-signer` 0.14.6, `@parity/truapi` 0.17.0 | `app/node_modules` |
| Código fuente de `@parity/product-sdk` 0.31.0 (`signMessageWithDotNsIdentity`) | npm, 25 sep 2026 |
| Consultas en vivo al devnet (solo lectura): People chain, DotNS, `TalkRegistry` | 25 sep 2026 |

## Qué funciona hoy (verificado)

| Prueba | Resultado |
|---|---|
| `npm run build` (tsc + vite) | OK, 1.1 MB en `dist/` |
| `npm run verify` con [`rehearsal-uanl.json`](../examples/rehearsal-uanl.json) | CHARLA VERIFICADA, 5/5 bloques en Asset Hub |
| `npm run verify` con [`tampered-uanl.json`](../examples/tampered-uanl.json) | rechazado |
| `contract/`: `npm test` | 10/10 pruebas |
| `npm run check` con la charla real del 24 sep | sellada en el bloque #13,649,506, ancla inferior #13,649,311 |
| `stt/testalk_stt.py` | compila; en modo `--demo` alimenta al presentador |
| Verificador web en Chrome headless | firma, 9/9 bloques, sello, comparación de audio (WAV real y WAV falso) |

Y el diseño ya sigue lo que TWR midió en el contenedor:

- `waitForHost()` antes de cualquier llamada y tope de tiempo en todas ([`host.ts`](../app/src/lib/host.ts)).
- Permiso `Remote` pedido al arrancar para cada dominio externo ([`permissions.ts`](../app/src/lib/permissions.ts)).
- `PreimageSubmit` y no `ChainSubmit` para Bulletin; `NotAvailable` en la cuota es aviso, no error; los `null` de `lookup` se ignoran ([`bulletin.ts`](../app/src/lib/bulletin.ts)).
- Bloques finalizados, Asset Hub del devnet (`0xd6eec261…`), rutas con `#` y `base: './'` para servir desde el content hash.
- Historial con `hashchange`: el gesto de "atrás" del celular no cierra la app (DEVFEEDBACK 4b).

## Hallazgos

| # | Gravedad | Hallazgo |
|---|---|---|
| H1 | Crítico | El verificador muestra como verificada una identidad que la firma no prueba |
| H2 | Crítico para el propósito | La firma sale de una cuenta de producto de la app, no de la identidad del speaker |
| H3 | Bloqueante de deploy | `testalk.dot` requiere Full Personhood |
| H4 | Alto | El QR no abre para quien lo escanea con la cámara del teléfono |
| H5 | Medio | Subida a Bulletin: se ignora la clave devuelta y el tope de 90 s es justo |
| H6 | Medio | Leer un recibo por CID fuera del contenedor probablemente no funciona |
| H7 | Medio | Versiones del SDK sin probar en dispositivo |
| H8 | Medio | Al diagnóstico le faltan pruebas para H2, H5 y H6 |
| H9 | Bajo | Exportar el recibo depende de una descarga |
| H10 | Bajo | Todos los visitantes ven la petición de acceso a `localhost` |
| H11 | Bajo | El verificador no valida la forma del recibo |

### H1. El verificador muestra una identidad que la firma no prueba

**Reproducción:** [`examples/impersonated-uanl.json`](../examples/impersonated-uanl.json).
Lo firma `//Bob`, pero el recibo declara `speaker` y `dotns` = `alice.dot` y
`speaker_address` = la dirección de `//Alice`.

```
Verificador web:  "Charla verificada" · Speaker alice.dot
                  [ OK ] Firma válida: sr25519 de 5Grwva…GKutQY   ← dirección de Alice
CLI:              alice.dot · UANL, Monterrey
                  ✓ Firma válida (sr25519, 0x8eaf0415…)           ← llave de Bob
                  CHARLA VERIFICADA
```

**Causa:** el verificador escribe lo que el recibo *declara* donde debería ir lo
que la firma *prueba*:

- [`verifier.ts:153`](../app/src/views/verifier.ts): `who = a.dotns || a.speaker || …` como "Speaker" en el veredicto.
- [`verifier.ts:324`](../app/src/views/verifier.ts) y [`:243`](../app/src/views/verifier.ts): "sr25519 de" y "La llave … firmó" usan `a.speaker_address ?? a.pubkey`.
- [`scripts/verify.ts`](../app/scripts/verify.ts) imprime `speaker` como encabezado.

[`verification.md`](verification.md) ya reconocía que el username no se
comprueba. Lo nuevo es que la interfaz lo presenta como comprobado, y que
también la *dirección* mostrada es falsificable.

**Arreglo propuesto:**
1. Derivar la dirección de `pubkey` (SS58, prefijo 42) y mostrar solo esa.
2. Si `speaker_address` no coincide con `pubkey`: aviso rojo "el recibo declara otra dirección".
3. Mostrar el username como **declarado** hasta que H2 permita comprobarlo en People chain.
4. Llevar el ejemplo a CI con el resultado esperado.

### H2. La firma sale de una cuenta de producto, no de la identidad del speaker

**Evidencia:**

- `@parity/product-sdk-signer` 0.14.6, `src/providers/host.ts`: *"the host exposes only per-dapp product accounts and never the user's identity account"*. `connect('host')` siempre termina en `fetchProductSignerAccount(dappName)`: una llave derivada para `testalk.dot`.
- TWR reescribió `peoplebook/src/claim.ts` por esto: *"The obvious call `new SignerManager({ dappName })` never touches the user's wallet: the host derives an APP-SCOPED account"*. Ahora prefieren `getLegacyAccounts()` (las cuentas reales) y usan SignerManager solo de respaldo.
- La People chain del devnet (genesis `0xe6c30d6e…`) tiene `Resources.UsernameOwnerOf`. Consulta en vivo: `kiuber.01 → 5GZb8gmx…`.

**Impacto:** la llave del recibo no está ligada públicamente a nadie. El username
es autodeclarado, así que el recibo prueba "esta llave de app firmó", no
"alice.dot lo dijo". Además, la llave cambia si cambia el dominio (H3).

**Arreglo propuesto:** firmar como Karim en el Summit, que es exactamente lo que
hace `wallet.signMessageWithDotNsIdentity` de `@parity/product-sdk` 0.31.0:

1. `getUserId()` → `primaryUsername`
2. People chain `Resources.UsernameOwnerOf(username)` → cuenta dueña
3. `getLegacyAccountSigner({ publicKey: dueña }).signBytes(canon)` (en el host: `signRawWithLegacyAccount`, envuelto en `<Bytes>`, que el verificador ya acepta)

Guardar en el recibo qué tipo de llave firmó (`"identity"` o `"app"`). El
verificador consulta `UsernameOwnerOf(dotns)` y compara con `pubkey`: solo si
coinciden dice "Firma de alice.dot". Si el host no permite la firma de identidad,
se usa la cuenta de producto de respaldo y el verificador lo dice.

**Riesgo abierto:** según el SDK, Polkadot Desktop no enumera cuentas legacy,
y ninguna app de TWR usa `signBytes`. Nadie ha comprobado que Desktop firme con
la cuenta de identidad. Hay que medirlo (H8) antes de elegir el camino.

### H3. `testalk.dot` requiere Full Personhood

- Docs, *Build & Publish*: *"Use labels nine characters or longer to avoid personhood checks. Labels shorter than this are gated."*
- TWR `DEVFEEDBACK.md` #9: `dotns register domain -n discreet` (8 letras) pasó el commit y **después** falló con *"Requires Full Personhood verification"*: se pierde esa transacción.
- `dotns lookup name testalk --env devnet` (CLI 0.9.5): libre, no registrado.

`testalk` tiene 7 letras. Salvo que la cuenta tenga Full Personhood (y tras la
actualización de septiembre las cuentas y los pseudónimos se regeneraron), el
registro fallará.

**Arreglo propuesto:** decidir ya un nombre de 9 o más (`testalk26`,
`testalk-uanl`…) y cambiarlo en [`signer.ts:16`](../app/src/lib/signer.ts),
[`package.json:10`](../app/package.json) y
[`polkadot-app-deploy.config.ts:7`](../app/polkadot-app-deploy.config.ts).

### H4. El QR no abre para quien lo escanea con la cámara

[`presenter.ts:399`](../app/src/views/presenter.ts) codifica
`https://testalk.dot/#/<cid>`.

- Docs, *Discover & open apps*: en el celular las apps se abren *"from Browse or by following a link"*; en un navegador normal, por `https://<nombre>.dev-dot.li`. Del escaneo de QR no dicen nada.
- La cámara del teléfono no resuelve `.dot`: abre el navegador y falla. Es probable que buena parte del público de la UANL no tenga Polkadot App instalada.
- Karim usó `polkadotapp://proofoftalk.dot/#/<cid>`: exige tener la app instalada. No lo hemos probado.
- Docs, *App delivery*: dev-dot.li es un contenedor con puente al host (cuentas, firma, cadena, almacenamiento). Verificar no necesita firmar, así que el fallo de firma en el web shell (TWR #18) no afecta.

**Arreglo propuesto:** QR a `https://<nombre>.dev-dot.li/#/<cid>`, y debajo el
enlace `.dot` para quien use Polkadot App. Tras el deploy, comprobar que el
shell conserve el `#/<cid>` al cargar la app.

### H5. Subida a Bulletin: clave ignorada y tope justo

- [`bulletin.ts:54`](../app/src/lib/bulletin.ts) descarta lo que devuelve `pm.submit()`. Según el SDK, *"`submit` uploads a preimage and resolves to its `0x`-prefixed hex key"*. Si esa clave no fuera el blake2b-256 de los bytes, el CID del QR no resolvería y nadie se enteraría.
- [`host.ts:7`](../app/src/lib/host.ts): 90 s de tope. TWR midió **64 s para 37 bytes** en Desktop 0.1.1. Un recibo de 15 minutos pesa unos 30 KB (estimado a partir del de Karim: 164 frases y 147 bloques en 16 minutos). Si se vence el tope, la subida sigue en el host, la app dice que falló y **Reintentar subida** vuelve a subir.
- En Android la subida falla por un desfase de códec (TWR Issue 1, con truapi 0.5.1). Sellar desde Desktop sigue siendo el plan.

**Arreglo propuesto:** comparar la clave devuelta con la esperada, subir el
tope a 180 s y, antes de reintentar, hacer `lookup` de la clave por si ya subió.

### H6. Leer un recibo por CID fuera del contenedor probablemente no funciona

[`bulletin.ts:86`](../app/src/lib/bulletin.ts) usa el gateway IPFS como respaldo.

- Docs, *Storage*: *"Reads are container-only. The client fetches through the host/light-client path; there is no public IPFS-gateway fallback."*
- TWR (chirp): los preimages de Bulletin *"only the host can resolve"*.

En un navegador normal, `#/<cid>` diría "No se encontró el recibo" aunque
exista. El JSON descargado sí se verifica en cualquier lado. H4 lo resuelve
para el QR, porque dev-dot.li es un contenedor; el diagnóstico debe probar las
dos vías por separado (H8).

### H7. Versiones del SDK sin probar en dispositivo

| Paquete | testalk | TWR (funciona hoy) | DOOM (jul) | PolkaCrew (ago) | Última (25 sep) |
|---|---|---|---|---|---|
| `product-sdk-host` | 0.21.0 | ^0.14.1 | 0.14.1 | 0.16.0 | 0.23.0 |
| `product-sdk-signer` | 0.14.6 | ^0.11.1 | 0.11.1 | 0.13.0 | 0.15.1 |
| `truapi` | 0.17.0 | | 0.5.1 | 0.9.0 | 0.21.0 |
| `polkadot-api` | ~2.2.1 | ^2.2.1 | | | 3.1.0 |
| `pad` | 0.16.6 | | | | 0.16.7 |

- El propio truapi avisa: un desfase de códec entre cliente y host produce errores o un handshake sin respuesta.
- Docs, *Packages*: *"Install the latest release of every package here."*
- `polkadot-api` 3 **no**: tanto el SDK instalado como el último piden `^2.1.6`.

**Propuesta:** correr `#/diagnostico` con las versiones actuales. Si aparecen
errores de códec o de handshake, probar las últimas; como respaldo conocido
quedan las de TWR. Actualizar `pad` a 0.16.7 antes del deploy.

### H8. Al diagnóstico le faltan pruebas

[`diagnostics.ts`](../app/src/views/diagnostics.ts) ya mide canal, permisos,
micrófono, bloques, hash por altura, `localhost`, `signRaw` y la subida a
Bulletin. Falta:

- Cuántas cuentas entrega `getLegacyAccounts()` en Desktop y en el celular.
- Firma con la identidad `.dot` (H2): username → `UsernameOwnerOf` → `signBytes` con el signer legacy, y que la firma valide contra esa cuenta.
- Clave devuelta por `submit()` contra la esperada (H5).
- Lectura del recibo recién subido **por el host** y **por el gateway**, por separado (H6).
- Lectura de `TalkRegistry` a través del provider del host.

### H9. Exportar el recibo depende de una descarga

El JSON solo sale con `<a download>`. En Desktop y en la web debería funcionar
(dot-drive de TWR hace lo mismo), en el celular no está comprobado, y sin ese
archivo no se puede anclar con `npm run anchor`. Propuesta: botón
**Copiar JSON** (el permiso `Clipboard` ya se pide al arrancar).

### H10. Todos los visitantes ven la petición de acceso a `localhost`

[`permissions.ts:14`](../app/src/lib/permissions.ts) pide `localhost` al
arrancar en cualquier ruta. Quien solo abre un QR para verificar recibe una
petición de red que no entiende. Propuesta: pedir `localhost` solo en
`#/presentar` y `#/diagnostico`.

### H11. El verificador no valida la forma del recibo

Un JSON con tipos inesperados (por ejemplo `chain` que no sea una lista) rompe
la página. No es inyección: todo el texto pasa por `esc()`. Propuesta: validar
la forma antes de renderizar y mostrar "No es un recibo de testalk".

## Qué solo se sabe en el dispositivo

Respuestas que dará `#/diagnostico` en Polkadot Desktop y en el celular:

1. ¿El handshake de truapi 0.17 funciona con el host actual? (H7)
2. ¿`signRaw` con la cuenta de producto levanta la hoja de firma? Nadie en TWR lo usa.
3. ¿`getLegacyAccounts()` entrega cuentas? ¿Desktop firma con la cuenta de identidad? (H2)
4. ¿`submit()` funciona y cuánto tarda con un recibo real? ¿La clave coincide? (H5)
5. ¿`ws://localhost:8787` es alcanzable desde Desktop con el permiso `Remote`?
6. ¿Se lee el recibo por el host? ¿Y por el gateway? (H6)
7. ¿dev-dot.li conserva `#/<cid>` al abrir la app? (H4)

## Antes del deploy

De la documentación de PCF y de la actualización de septiembre:

- [ ] `pad` 0.16.7 (`npm i -g @polkadot-community-foundation/polkadot-app-deploy@latest`), Node 22 o más.
- [ ] Cuenta nueva de Polkadot App después de la actualización de septiembre, con username.
- [ ] Autorización de almacenamiento de Bulletin para la cuenta de deploy (Storage Faucet o `dotns bulletin authorize … --env devnet`). *"If a deploy that used to work stops at the upload step, the allowance has most likely lapsed."*
- [ ] Cuenta mapeada: `dotns account map --env devnet`.
- [ ] Nombre con base de 9 o más, sin contar los dígitos finales, que deben ser 0 o 2 (H3).
- [ ] Siempre `--env devnet`. El script usa `PAD_ENV=devnet`: `pad` 0.16.6 lo respeta (`--env` gana si están los dos).
- [ ] Después: `dotns content view <nombre> --env devnet` para confirmar el CID.

## Estado

Correcciones del 25 sep 2026:

| # | Estado | Qué se hizo |
|---|---|---|
| H1 | Corregido | La dirección mostrada sale de `pubkey`; `speaker_address` distinto a `pubkey` es **Dirección falsa**; el nombre se muestra como declarado hasta que People chain lo confirme; el veredicto pasa a **Identidad falsa**. Web y CLI. `impersonated-uanl.json` en CI. |
| H2 | Corregido, falta medir en Desktop | El presentador firma con la cuenta dueña del username (`lib/people.ts` + `getLegacyAccountSigner`), con la cuenta de la app de respaldo (botón **Firmar con la cuenta de la app**); el recibo lleva `dotns` solo si firmó el dueño. El verificador comprueba `UsernameOwnerOf`. Probado contra la People chain real (`kiuber.01`, username inexistente). |
| H3 | Corregido | Dominio `devnet-test-talk26` (libre): `lib/network.ts`, `package.json`, `polkadot-app-deploy.config.ts`. El primer intento, `testalk26`, falló en la verificación previa de `pad` 0.16.7: la regla real del protocolo v2 cuenta la **base** sin los dígitos finales (que deben ser 0 o 2), y `testalk` tiene 7. Ver [deploy.md](deploy.md#nombre-de-dominio). |
| H4 | Corregido, falta medir | QR a `https://devnet-test-talk26.dev-dot.li/#/<cid>`; el enlace `.dot` va como texto. Comprobar tras el deploy que el gateway conserve el `#`. |
| H5 | Corregido | Se compara la clave devuelta con el blake2b-256; tope de 180 s; un reintento busca antes si ya subió. |
| H6 | Mitigado, falta medir | El verificador fuera del contenedor ofrece abrir el recibo en el gateway; el diagnóstico prueba la lectura por el host y por el gateway por separado. |
| H7 | **Confirmado y corregido** | Ver [H7 medido en el dispositivo](#h7-medido-en-el-dispositivo). SDK bajado a `product-sdk-host` 0.19.1 + `signer` 0.14.4 (protocolo 1). `pad` actualizado a 0.16.7. |
| H8 | Corregido | El diagnóstico suma: cadenas que sirve el host (`isChainSupported`), cuentas del wallet, username en People chain, firma con identidad, firma con la cuenta de la app, clave devuelta por Bulletin, lectura por host y por gateway, y `TalkRegistry` por el cliente principal. |
| H9 | Corregido | **Copiar JSON** en el presentador y en el verificador. |
| H10 | Corregido | `localhost` solo se pide en `#/presentar` y `#/diagnostico`. |
| H11 | Corregido | `artifactShapeError()` antes de mostrar nada, en web y CLI. |

Hallazgo nuevo al probar las correcciones: la primera consulta a People chain
desde un navegador tardó **23.2 s** con `people-paseo.rotko.net`, contra 2.9 s
(`gatotech`) y 3.1 s (`interweb-it`). Con un tope de 15 s y rotko primero en la
lista, la identidad salía "sin comprobar". Ahora los endpoints van ordenados por
esa medición y, si uno se vence, se reintenta con el siguiente
([`people.ts`](../app/src/lib/people.ts)).

## H7 medido en el dispositivo

Primer diagnóstico en **Polkadot Desktop 0.1.3** (Electron 43), con testalk
en `product-sdk-host` 0.21.0 / `truapi` 0.17.0:

```
[YES ] Canal con el host (0 ms): connected
[NO  ] Permiso de red (Remote) (8001 ms): sin respuesta
[NO  ] El host sirve Asset Hub (8001 ms): sin respuesta
[NO  ] Cuentas del wallet (getLegacyAccounts) (8001 ms): sin respuesta
[NO  ] Wallet (SignerManager): El wallet no respondió a tiempo.
[YES ] Asset Hub: bloque finalizado · por RPC público (el host no entregó Asset Hub en 12 s)
```

El canal abre pero **ninguna petición recibe respuesta**. La causa está en el
código de los dos lados:

- Desktop 0.1.3 lleva `@novasamatech/host-api` 0.9.4 (dentro de `app.asar`):
  `SCALE_CODEC_PROTOCOL_ID = 1`, y su saludo (`host_handshake`) pide el protocolo 1.
- `truapi` 0.17.0 tiene `TRUAPI_CODEC_VERSION = 2`: al saludo del host responde
  `UnsupportedProtocolVersion`, y el host descarta sus peticiones en formato 2.

| `truapi` | Códec | `product-sdk-host` | `product-sdk-signer` |
|---|---|---|---|
| 0.5.1 a 0.13.1 | **1** | 0.14.1 a **0.19.1** | 0.11.1 a **0.14.4** |
| 0.16.0 en adelante | 2 | 0.20.0 en adelante | 0.14.5 en adelante |

testalk quedó en la pareja más nueva con códec 1: `product-sdk-host` 0.19.1
y `product-sdk-signer` 0.14.4, una sola copia de cada uno (`npm ls`). Es la
misma que usa `@parity/product-sdk` 0.27.0. El diagnóstico muestra ahora las
versiones y el códec en su primera fila y en el reporte copiado.

Mientras Asset Hub no llegó por el host, el respaldo a RPC público (commit
`f6773fb`) mantuvo la app conectada: los bloques, la lectura por altura y
`TalkRegistry` funcionaron igual.

## Orden sugerido (original)

1. H1: corregir el verificador (no depende del dispositivo).
2. H8: ampliar el diagnóstico.
3. H3: elegir dominio y hacer el deploy de prueba.
4. Correr el diagnóstico en Desktop y en el celular.
5. Con esos datos: H2 (camino de firma), H4 (QR), H5, H7.
6. H9 a H11.
