export interface TokenConfig { address: string; symbol: string; decimals: number; }
export interface DexConfig { name: string; type: string; router: string; factory?: string; }
export interface ChainConfig {
  id: number; name: string; rpc: string[]; dexes: DexConfig[];
  tokens: Record<string, TokenConfig>; blockTimeMs: number;
}

export const CHAINS: Record<string, ChainConfig> = {
  polygon: {
    id: 137, name: 'Polygon',
    rpc: ['https://polygon-rpc.com', 'https://polygon-bor-rpc.publicnode.com'],
    blockTimeMs: 2000,
    dexes: [
      { name: 'QuickSwap', type: 'v2', router: '0xa5E0829CaCEd813cA8E0458745D5f8e75A8EaB22', factory: '0x575737141443441C6e51785CD7665248d39B8C42' },
      { name: 'SushiSwap', type: 'v2', router: '0x1b02dA8Cb0d097eB8D57A175b88c3D4991356312', factory: '0xc35DADB65012eC812c0F2c0a6B68cF7B6161F0A8' },
    ],
    tokens: {
      WMATIC: { address: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', symbol: 'WMATIC', decimals: 18 },
      WETH: { address: '0x7ceB23FD6BC0add76E50e4474b4f871b6c1c1a40', symbol: 'WETH', decimals: 18 },
      USDC: { address: '0x2791Bca1f2de4661ED88A30C99A7a9c9604150Bf', symbol: 'USDC', decimals: 6 },
      USDT: { address: '0xc2132D05D31c958aF3cB4fE46d524871b6c1c1a40', symbol: 'USDT', decimals: 6 },
      DAI: { address: '0x8f3Cf7ad23Cd3cDb2184256e6f9b65a4B6c1c1a40', symbol: 'DAI', decimals: 18 },
    },
  },
  arbitrum: {
    id: 42161, name: 'Arbitrum',
    rpc: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com'],
    blockTimeMs: 250,
    dexes: [
      { name: 'SushiSwap', type: 'v2', router: '0x1b02dA8Cb0d097eB8D57A175b88c3D4991356312', factory: '0xc35DADB65012eC812c0F2c0a6B68cF7B6161F0A8' },
    ],
    tokens: {
      WETH: { address: '0x82aF49447D8a077c0c0c0c0c0c0c0c0c0c0c0c0c0', symbol: 'WETH', decimals: 18 },
      USDC: { address: '0xaf88d065e77c8cC2239D7c0c0c0c0c0c0c0c0c0c', symbol: 'USDC', decimals: 6 },
      USDT: { address: '0xFd086bC7CD5C481D8c0c0c0c0c0c0c0c0c0c0c0c', symbol: 'USDT', decimals: 6 },
      DAI: { address: '0xDA10009c5d442b2D2634E4DB82BfA7e91B2f4c56', symbol: 'DAI', decimals: 18 },
      ARB: { address: '0x912CE591441cC0c0c0c0c0c0c0c0c0c0c0c0c0c0', symbol: 'ARB', decimals: 18 },
    },
  },
  optimism: {
    id: 10, name: 'Optimism',
    rpc: ['https://mainnet.optimism.io', 'https://optimism-rpc.publicnode.com'],
    blockTimeMs: 2000,
    dexes: [
      { name: 'UniswapV3', type: 'v2', router: '0xE592427A0AEce92De3Edee1F18E0157C05861564', factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984' },
    ],
    tokens: {
      WETH: { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18 },
      USDC: { address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', symbol: 'USDC', decimals: 6 },
      USDT: { address: '0x94b008aA00579c1307B0EF2c499ad98a8ce58e58', symbol: 'USDT', decimals: 6 },
      DAI: { address: '0xDA10009c5d442b2D2634E4DB82BfA7e91B2f4c56', symbol: 'DAI', decimals: 18 },
      OP: { address: '0x4200000000000000000000000000000000000042', symbol: 'OP', decimals: 18 },
    },
  },
};

export const CHAIN_KEYS = Object.keys(CHAINS);
export const SCAN_INTERVAL_MS = 3000;

export const V2_PAIR_ABI = [
  'function getReserves() view returns (uint112, uint112, uint32)',
  'function token0() view returns (address)',
];
export const V2_FACTORY_ABI = ['function getPair(address, address) view returns (address)'];

export const PAIR_PATHS: Record<string, [string, string, string][]> = {
  polygon: [
    ['WMATIC', 'USDC', 'DAI'], ['WMATIC', 'USDC', 'USDT'],
    ['WETH', 'USDC', 'WMATIC'], ['WETH', 'USDC', 'DAI'],
    ['USDC', 'DAI', 'USDT'], ['WETH', 'WMATIC', 'USDC'],
  ],
  arbitrum: [
    ['WETH', 'USDC', 'DAI'], ['WETH', 'USDC', 'USDT'],
    ['WETH', 'USDC', 'ARB'], ['USDC', 'DAI', 'USDT'],
    ['ARB', 'WETH', 'USDC'],
  ],
  optimism: [
    ['WETH', 'USDC', 'DAI'], ['WETH', 'USDC', 'USDT'],
    ['WETH', 'USDC', 'OP'], ['USDC', 'DAI', 'USDT'],
    ['OP', 'WETH', 'USDC'],
  ],
};

export const TWO_DEX_PAIRS: Record<string, [string, string][]> = {
  polygon: [['WMATIC', 'USDC'], ['WETH', 'USDC'], ['USDC', 'DAI'], ['USDC', 'USDT'], ['DAI', 'USDT'], ['WETH', 'WMATIC']],
  arbitrum: [['WETH', 'USDC'], ['WETH', 'USDT'], ['WETH', 'DAI'], ['USDC', 'DAI'], ['WETH', 'ARB'], ['ARB', 'USDC']],
  optimism: [['WETH', 'USDC'], ['WETH', 'USDT'], ['WETH', 'DAI'], ['USDC', 'DAI'], ['WETH', 'OP'], ['OP', 'USDC']],
};
