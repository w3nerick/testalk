# Formato del recibo (v1)

El recibo es un objeto JSON. Las claves de la primera tabla son las del formato
v1 de Proof of Talk; las de la segunda son extensiones de testalk. Todas,
salvo `pubkey`, `sig` y `sig_alg`, quedan cubiertas por la firma.

## Campos v1 (compatibles con Proof of Talk)

| Campo | Tipo | Descripción |
|---|---|---|
| `v` | `1` | Versión del formato |
| `speaker` | string | Nombre mostrado: username de Polkadot App o dirección abreviada |
| `dotns` | string | Username del speaker, vacío si el host no lo entrega |
| `title` | string | Título de la charla |
| `venue` | string | Evento o lugar |
| `started_at` | ISO 8601 UTC | Primera frase |
| `ended_at` | ISO 8601 UTC | Momento del sellado |
| `window` | string | `HH:MM-HH:MM` en hora local del presentador (solo para mostrar) |
| `anchor_block` | string | Último bloque finalizado conocido al sellar |
| `total_sentences` | number | Frases en `chain` |
| `total_blocks` | number | Bloques en `chain` |
| `chain` | array | Frases y bloques intercalados, ver abajo |
| `pubkey` | hex | Llave pública del firmante (32 bytes) |
| `sig` | hex | Firma de los bytes canónicos (64 bytes) |
| `sig_alg` | `"sr25519"` | Esquema de firma |

## Extensiones de testalk

| Campo | Tipo | Descripción |
|---|---|---|
| `network` | `"products-devnet"` | Red de los bloques |
| `genesis` | hex | Genesis de Asset Hub. Sin él, el verificador no consulta bloques |
| `lang` | string | Idioma de la transcripción |
| `speaker_address` | SS58 | Dirección del firmante |
| `audio` | objeto o `null` | `{ alg: "blake2b-256", hash, bytes, seconds }` del WAV |
| `rehearsal` | `true` | Solo en recibos de ensayo firmados con cuenta de prueba |

## `chain`

```json
[
  { "h": "0x1d4f…28ab", "blk": "13,618,959", "time": "15:24:08", "full": "0x1d4f9add…26128ab" },
  { "s": "Buenas tardes a todos, gracias por estar aquí en la UANL." },
  { "h": "0xb048…ae2c", "blk": "13,618,960", "time": "15:24:09", "full": "0xb04897e1…6eae2c" }
]
```

| Entrada | Campos |
|---|---|
| Frase | `s`: texto transcrito |
| Bloque | `full`: hash completo · `blk`: altura con separador de miles · `h`: hash abreviado · `time`: hora local de llegada |

Reglas de construcción:

- El `chain` empieza con un bloque: el último finalizado antes de la primera frase.
- Después de cada tramo hablado entra **un** bloque, el primero que se finaliza tras la frase.
- Al sellar, si hay frases sin bloque posterior, se agrega un bloque de cierre.

## Bytes canónicos

Lo que se firma es:

1. El recibo **sin** `sig`, `pubkey` ni `sig_alg`.
2. Con las claves de primer nivel ordenadas alfabéticamente.
3. Serializado con `JSON.stringify` (sin espacios).
4. Codificado en UTF-8.

```ts
function canonicalBytes(a) {
  const { sig, pubkey, sig_alg, ...rest } = a;
  const sorted = {};
  for (const k of Object.keys(rest).sort()) sorted[k] = rest[k];
  return new TextEncoder().encode(JSON.stringify(sorted));
}
```

Solo se ordenan las claves de primer nivel. El orden dentro de `chain` y de
`audio` es el de construcción y forma parte de lo firmado.

La wallet puede envolver el mensaje en `<Bytes>…</Bytes>` antes de firmar;
`signatureVerify` de `@polkadot/util-crypto` acepta ambas formas.

## CID

El recibo se sube a Bulletin como los bytes de `JSON.stringify(recibo)`. Su CID es:

```
CIDv1( codec raw 0x55, multihash blake2b-256 0xb220 )
```

La clave del preimage en Bulletin es el digest de 32 bytes dentro del CID. El
botón "Descargar recibo" guarda esos mismos bytes, así que el CID del archivo
coincide con el publicado.
