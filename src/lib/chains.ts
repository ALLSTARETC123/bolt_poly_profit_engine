export interface TokenConfig {
  address: string;
  symbol: string;
  decimals: number;
}

export interface DexConfig {
  name: string;
  type: 'uniswap_v2' | 'uniswap_v3' | 'algebra' | 'velodrome';
  router: string;
  factory?: string;
  quoter?: string;
}

export interface ChainConfig {
  id: number;
  name: string;
  rpc: string[];
  privateRpc: string[];
  balancerVault: string;
  dodoApprove: string;
  dodoProxy: string;
  dvmFactory: string;
  gelatoRelayerAddress: string;
  gelatoFeeCollector: string;
  dexes: DexConfig[];
  tokens: Record<string, TokenConfig>;
}

export const GELATO_FEE_COLLECTOR = '0x27928fBedA812Cb58E3D1aFcB07Be3597D75A60D';

export const CHAINS: Record<string, ChainConfig> = {
  polygon: {
    id: 137,
    name: 'Polygon',
    rpc: [
      'https://polygon-bor-rpc.publicnode.com',
      'https://rpc.ankr.com/polygon',
    ],
    privateRpc: [
      'https://rpc.flashbots.net/fast',
    ],
    balancerVault: '0xBA12222222228d8Ba445958a75a0704D566BF2C8',
    dodoApprove: '0xA956Bf481c3c0d3E5A56a18c6167bb0E82D33D92',
    dodoProxy: '0x8e0b6cD8f8dE5F7A6c0c0A0c0c0c0c0c0c0c0c0c0',
    dvmFactory: '0x3c5B36469C026C4585E9206090eABD5B2F3eAB6B',
    gelatoRelayerAddress: '0x7A0B1C3d4e5F6789012345678901234567890123',
    gelatoFeeCollector: GELATO_FEE_COLLECTOR,
    dexes: [
      { name: 'QuickSwap', type: 'algebra', router: '0xa5E0829CaCEd8fFCEEd813c0750d57F89A5c0c0c', factory: '0x575737141443441C6e51785CD7665248d39B8C42' },
      { name: 'SushiSwap', type: 'uniswap_v2', router: '0x1b02dA8Cb0d097eB8D57A175b88c3D4991356312', factory: '0xc35DADB65012eC812c0F2c0a6B68cF7B6161F0A8' },
      { name: 'UniswapV3', type: 'uniswap_v3', router: '0xE592427A0AEce92De3Edee1F18E0157C05861564', quoter: '0xb27308f9F90d607573F4b7626BB1C6f85a8192D' },
    ],
    tokens: {
      WMATIC: { address: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', symbol: 'WMATIC', decimals: 18 },
      WETH: { address: '0x7ceB23FD6BC0add76E50e4474b4f871b6c1c1a40', symbol: 'WETH', decimals: 18 },
      USDC: { address: '0x2791Bca1f2de4661ED88A30C99A7a9c9604150Bf', symbol: 'USDC', decimals: 6 },
      USDT: { address: '0xc2132D05D31c93e585aF3c4f871b6c1c1a40', symbol: 'USDT', decimals: 6 },
      DAI: { address: '0x8f3Cf7ad23Cd3cDb2184256e6f9b65a4B6c1c1a40', symbol: 'DAI', decimals: 18 },
      WBTC: { address: '0x1BFD67037Ed42c865aF3c0d3e2f871b6c1c1a40', symbol: 'WBTC', decimals: 8 },
    },
  },
  arbitrum: {
    id: 42161,
    name: 'Arbitrum',
    rpc: [
      'https://arbitrum-one-rpc.publicnode.com',
      'https://rpc.ankr.com/arbitrum',
    ],
    privateRpc: [],
    balancerVault: '0xBA12222222228d8Ba445958a75a0704D566BF2C8',
    dodoApprove: '0x8e0b6cD8f8dE5F7A6c0c0A0c0c0c0c0c0c0c0c0c0',
    dodoProxy: '0x8e0b6cD8f8dE5F7A6c0c0A0c0c0c0c0c0c0c0c0c0c0',
    dvmFactory: '0x3c5B36469C026C4585E9206090eABD5B2F3eAB6B',
    gelatoRelayerAddress: '0x7A0B1C3d4e5F6789012345678901234567890123',
    gelatoFeeCollector: GELATO_FEE_COLLECTOR,
    dexes: [
      { name: 'UniswapV3', type: 'uniswap_v3', router: '0xE592427A0AEce92De3Edee1F18E0157C05861564', quoter: '0xb2d49E0f5b0c1c0c0c0c0c0c0c0c0c0c0c0c0c0c0' },
      { name: 'SushiSwap', type: 'uniswap_v2', router: '0x1b02dA8Cb0d097eB8D57A175b88c3D4991356312', factory: '0xc35DADB65012eC812c0F2c0a6B68cF7B6161F0A8' },
      { name: 'Camelot', type: 'algebra', router: '0xc8Ecd03E1c19E71E0C6a3A6c0c0c0c0c0c0c0c0c', factory: '0x6EcCab422D24361F88a76b8A0c0c0c0c0c0c0c0c0' },
    ],
    tokens: {
      WETH: { address: '0x82aF49447D8a097c0c0c0c0c0c0c0c0c0c0c0c0c', symbol: 'WETH', decimals: 18 },
      USDC: { address: '0xaf88d065e77c8cC2239D7c0c0c0c0c0c0c0c0c0c', symbol: 'USDC', decimals: 6 },
      USDT: { address: '0xFd086bC7CD5C481D8c0c0c0c0c0c0c0c0c0c0c0c', symbol: 'USDT', decimals: 6 },
      DAI: { address: '0xDA10009c5d442b2D2634E4DB82BfA7e91B2f4c56', symbol: 'DAI', decimals: 18 },
      ARB: { address: '0x912CE591441cC0c0c0c0c0c0c0c0c0c0c0c0c0c0', symbol: 'ARB', decimals: 18 },
      WBTC: { address: '0x2f2a2543B76A4166547D5fD0c0c0c0c0c0c0c0c0', symbol: 'WBTC', decimals: 8 },
    },
  },
  optimism: {
    id: 10,
    name: 'Optimism',
    rpc: [
      'https://optimism-rpc.publicnode.com',
      'https://rpc.ankr.com/optimism',
    ],
    privateRpc: [],
    balancerVault: '0xBA12222222228d8Ba445958a75a0704D566BF2C8',
    dodoApprove: '0x8e0b6cD8f8dE5F7A6c0c0A0c0c0c0c0c0c0c0c0c0',
    dodoProxy: '0x8e0b6cD8f8dE5F7A6c0c0A0c0c0c0c0c0c0c0c0c0c0',
    dvmFactory: '0x3c5B36469C026C4585E9206090eABD5B2F3eAB6B',
    gelatoRelayerAddress: '0x7A0B1C3d4e5F6789012345678901234567890123',
    gelatoFeeCollector: GELATO_FEE_COLLECTOR,
    dexes: [
      { name: 'UniswapV3', type: 'uniswap_v3', router: '0xE592427A0AEce92De3Edee1F18E0157C05861564', quoter: '0xb2d49E0f5b0c1c0c0c0c0c0c0c0c0c0c0c0c0c0c0' },
      { name: 'Velodrome', type: 'velodrome', router: '0xa062aE8a9c5eC3c0c0c0c0c0c0c0c0c0c0c0c0c0', factory: '0x25Caf71930A93A0c0c0c0c0c0c0c0c0c0c0c0c0' },
    ],
    tokens: {
      WETH: { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18 },
      USDC: { address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', symbol: 'USDC', decimals: 6 },
      USDT: { address: '0x94b008aA00579c1307b0ef2c499ad98a8ce58e58', symbol: 'USDT', decimals: 6 },
      DAI: { address: '0xDA10009c5d442b2D2634E4DB82BfA7e91B2f4c56', symbol: 'DAI', decimals: 18 },
      OP: { address: '0x4200000000000000000000000000000000000042', symbol: 'OP', decimals: 18 },
    },
  },
};

export const CHAIN_KEYS = Object.keys(CHAINS);

export const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

export const V2_PAIR_ABI = [
  'function getReserves() view returns (uint112, uint112, uint32)',
  'function token0() view returns (address)',
];

export const V2_FACTORY_ABI = [
  'function getPair(address, address) view returns (address)',
];

export const V3_QUOTER_ABI = [
  'function quoteExactInputSingle(address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) view returns (uint256)',
];

export const DODO_FACTORY_ABI = [
  'function getDVM(address baseToken, address quoteToken) view returns (address)',
];

export const TRIANGULAR_PATHS: Record<string, [string, string, string][]> = {
  polygon: [
    ['WMATIC', 'USDC', 'DAI'],
    ['WMATIC', 'USDC', 'USDT'],
    ['WETH', 'USDC', 'WMATIC'],
    ['WETH', 'USDC', 'DAI'],
    ['USDC', 'DAI', 'USDT'],
    ['WBTC', 'WETH', 'USDC'],
    ['WETH', 'WMATIC', 'USDC'],
    ['WETH', 'WMATIC', 'DAI'],
  ],
  arbitrum: [
    ['WETH', 'USDC', 'DAI'],
    ['WETH', 'USDC', 'USDT'],
    ['WETH', 'USDC', 'ARB'],
    ['WETH', 'WBTC', 'USDC'],
    ['USDC', 'DAI', 'USDT'],
    ['ARB', 'WETH', 'USDC'],
    ['WETH', 'DAI', 'USDT'],
    ['WBTC', 'WETH', 'USDT'],
  ],
  optimism: [
    ['WETH', 'USDC', 'DAI'],
    ['WETH', 'USDC', 'USDT'],
    ['WETH', 'USDC', 'OP'],
    ['USDC', 'DAI', 'USDT'],
    ['OP', 'WETH', 'USDC'],
    ['WETH', 'DAI', 'USDT'],
  ],
};

export const TWO_DEX_PAIRS: Record<string, [string, string][]> = {
  polygon: [
    ['WMATIC', 'USDC'], ['WETH', 'USDC'], ['USDC', 'DAI'], ['USDC', 'USDT'],
    ['DAI', 'USDT'], ['WBTC', 'WETH'], ['WETH', 'WMATIC'], ['WETH', 'DAI'],
  ],
  arbitrum: [
    ['WETH', 'USDC'], ['WETH', 'USDT'], ['WETH', 'DAI'], ['USDC', 'DAI'],
    ['USDT', 'USDT'], ['WETH', 'ARB'], ['WBTC', 'WETH'], ['ARB', 'USDC'],
  ],
  optimism: [
    ['WETH', 'USDC'], ['WETH', 'USDT'], ['WETH', 'DAI'], ['USDC', 'DAI'],
    ['WETH', 'OP'], ['OP', 'USDC'],
  ],
};

export const MULTI_HOP_PATHS: Record<string, string[][]> = {
  polygon: [
    ['WMATIC', 'USDC', 'WETH', 'DAI', 'WMATIC'],
    ['WETH', 'USDC', 'WMATIC', 'DAI', 'WETH'],
    ['USDC', 'WMATIC', 'WETH', 'DAI', 'USDC'],
  ],
  arbitrum: [
    ['WETH', 'USDC', 'ARB', 'USDT', 'WETH'],
    ['WETH', 'USDC', 'DAI', 'USDT', 'WETH'],
    ['ARB', 'WETH', 'USDC', 'DAI', 'ARB'],
  ],
  optimism: [
    ['WETH', 'USDC', 'OP', 'DAI', 'WETH'],
    ['WETH', 'USDC', 'DAI', 'USDT', 'WETH'],
    ['OP', 'WETH', 'USDC', 'DAI', 'OP'],
  ],
};
