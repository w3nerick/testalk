# app: testalk.dot

Interfaz web que se publica en el Products Devnet. Presentador, verificador y
CLI de verificación.

```bash
npm install
npm run dev        # modo ensayo en cualquier navegador
npm run build      # tsc + vite → dist/
npm run verify -- ../examples/rehearsal-uanl.json
npm run deploy     # pad dist testalk.dot (ver ../docs/deploy.md)
```

| Ruta | Vista |
|---|---|
| `#/` | Inicio con bloques de Asset Hub en vivo |
| `#/presentar` | Preparación, transcripción en vivo y sellado |
| `#/verificar` | Verificar un JSON o pegar un CID |
| `#/<CID>` | Verificar un recibo publicado en Bulletin (destino del QR) |
| `#/diagnostico` | Prueba cada pieza de la plataforma en el dispositivo |

Arquitectura en [`../docs/architecture.md`](../docs/architecture.md).
