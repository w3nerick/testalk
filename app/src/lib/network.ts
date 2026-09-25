/**
 * Red de destino: Asset Hub del Products Devnet.
 * Genesis medido por RPC el 23 sep 2026. Los de Proof of Talk original
 * (0xf388dc…) eran de la red del Web3 Summit y aquí no existen.
 */
export const NETWORK = 'products-devnet';
export const ASSET_HUB_GENESIS = '0xd6eec26135305a8ad257a20d003357284c8aa03d0bdb2b357ab0a22371e11ef2' as const;
export const PUBLIC_WS = [
  'wss://asset-hub-paseo-rpc.n.dwellir.com',
  'wss://sys.turboflakes.io/asset-hub-paseo',
];

/**
 * People chain del devnet (para 1004): usernames. Genesis medido el 25 sep
 * 2026; los endpoints son los de la documentación de PCF, ordenados por lo que
 * tardó la primera consulta desde un navegador ese día: gatotech 2.9 s,
 * interweb-it 3.1 s, rotko 23.2 s.
 */
export const PEOPLE_GENESIS = '0xe6c30d6e148f250b887105237bcaa5cb9f16dd203bf7b5b9d4f1da7387cb86ec' as const;
export const PEOPLE_WS = [
  'wss://people-paseo.gatotech.network',
  'wss://rpc.interweb-it.com/people-paseo',
  'wss://people-paseo.rotko.net',
];

/**
 * Dominio de la app. Nueve letras o más: los nombres de 6 a 8 exigen Full
 * Personhood y el registro falla después del commit (TWR.DOT, DEVFEEDBACK #9).
 * Si cambia, cambiarlo también en package.json (deploy) y en
 * polkadot-app-deploy.config.ts. Define además la cuenta de producto de la app.
 */
export const APP_LABEL = 'testalk26';
export const APP_DOTNS = `${APP_LABEL}.dot`;

/**
 * La misma app en el gateway web. El QR apunta aquí: abre en cualquier
 * navegador, sin Polkadot App, y el gateway también es un contenedor con puente
 * al host, así que lee Bulletin (verificar no necesita firmar).
 */
export const WEB_GATEWAY = `https://${APP_LABEL}.dev-dot.li`;

/**
 * Gateway IPFS del devnet. Según la documentación de PCF, las lecturas de
 * Bulletin son solo dentro del contenedor: este respaldo puede no servir
 * preimages subidos por el host. El diagnóstico lo mide por separado.
 */
export const IPFS_GATEWAY = 'https://devnet-ipfs.api.polkadotcommunity.foundation/ipfs';

/**
 * TalkRegistry en pallet-revive: sellos permanentes de los recibos.
 * Desplegado el 23 sep 2026, bloque 13,620,269 (ver contract/deployments.json).
 */
export const REGISTRY_ADDRESS = '0xf4acbd6ae6f57ec2b117d4a0b9bb18026496b40a' as const;
