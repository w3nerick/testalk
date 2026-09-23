# contract: TalkRegistry

Registro permanente de recibos de testalk en **pallet-revive** (Asset Hub del
Products Devnet). Solidity compilado a **PolkaVM** con `resolc`.

| | |
|---|---|
| Dirección | [`0xf4acbd6ae6f57ec2b117d4a0b9bb18026496b40a`](deployments.json) |
| Red | Products Devnet, Asset Hub (genesis `0xd6eec2…`) |
| Desplegado | Bloque 13,620,269, 23 sep 2026 |
| Depósito | 1.41 PAS por el contrato, ~0.026 PAS por cada sello |

## Por qué existe

Bulletin borra los recibos a los 14 días y solo el host los resuelve. El
registro guarda lo mínimo para que un recibo conservado se pueda verificar para
siempre, y agrega lo que el recibo no puede probar por sí solo: **hasta cuándo**
existía.

| Campo | Para qué sirve |
|---|---|
| `receiptHash` | blake2b-256 de los bytes del recibo (el digest de su CID). Ata un JSON conservado al sello. |
| `blockNumber`, `sealedAt` | Cota **superior** de tiempo: el recibo existía a más tardar en este bloque. |
| `anchorBlock` | Primer bloque del recibo: cota **inferior**. |
| `pubkey`, `sig` | Autoría on-chain. La firma sr25519 se verifica fuera, contra los bytes canónicos. |
| `cid`, `title` | Para encontrarlo en Bulletin mientras exista y para listar sin descargar. |

El contrato no verifica la firma ni exige que quien llama sea el speaker: un
sello con firma falsa no valida en ningún verificador, y que un tercero ancle
un recibo ajeno solo le agrega una cota de tiempo. El primero que ancla gana.

## Uso

```bash
npm install
npm run build        # resolc → out/*.pvm  ·  solc → out-evm/ (ABI + bytecode EVM para pruebas)
npm test             # 10 pruebas de lógica en EVM local
npm run simulate     # simula el deploy con el bytecode PolkaVM contra revive, sin firmar

npm run check                          # cuántos recibos hay sellados
npm run check -- ../examples/x.json    # ¿está sellado este recibo?
npm run anchor -- recibo.json          # sella un recibo (pide semilla y confirmación)
```

`anchor` verifica la firma del recibo en local, simula `seal()` contra el
contrato, pide la frase semilla sin eco, vuelve a simular desde tu cuenta y solo
firma si escribes `SELLAR`. Rechaza recibos de ensayo salvo con `--ensayo`.

`deploy` sigue el mismo patrón con la palabra `DESPLEGAR`. Ya está desplegado;
volver a correrlo crea un contrato nuevo.

## Notas de pallet-revive

- Se instancia con `Revive.instantiate_with_code`; `cdm deploy` revierte al registrar nombres nuevos.
- `weight_limit` por encima de ~900G de `ref_time` vuelve como `InvalidTxError`.
- En `polkadot-api` 2.2 los `[u8; 20]` (direcciones H160) van como texto hex y los `Vec<u8>` llegan como `Uint8Array`.
- Las lecturas son simulaciones con la runtime API `ReviveApi.call`: no firman ni cuestan nada.
