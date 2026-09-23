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
/** Gateway IPFS del devnet: sirve preimages de Bulletin mientras no expiren. */
export const IPFS_GATEWAY = 'https://devnet-ipfs.api.polkadotcommunity.foundation/ipfs';
