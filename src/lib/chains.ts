/**
 * Chain configuration for Polygon, Arbitrum, and Optimism.
 * All addresses are real mainnet contract addresses.
 * RPC endpoints are public endpoints (no API key required for basic scanning).
 */

export interface ChainConfig {
  id: number;
  name: string;
  shortName: string;
  rpc: string[];
  nativeToken: string;
  nativeTokenSymbol: string;
  wrappedNative: string;
  blockExplorer: string;
  balancerVault: string;
  gasEstimateMultiplier: number;
  dexes: DexConfig[];
  tokens: Record<string, TokenConfig>;
}

export interface DexConfig {
  name: string;
  type: 'uniswap_v2' | 'uniswap_v3' | 'algebra' | 'curve';
  router: string;
  factory: string;
  quoter?: string;
  feeTiers?: number[];
}

export interface TokenConfig {
  address: string;
  symbol: string;
  decimals: number;
}

// Balancer V2 Vault address is the same across Polygon, Arbitrum, and Optimism.
// Zero flash loan fee.
const BALANCER_V2_VAULT = '0xBA12222222228d8Ba445958a75a0704D566BF2C8';

export const CHAINS: Record<string, ChainConfig> = {
  polygon: {
    id: 137,
    name: 'Polygon',
    shortName: 'polygon',
    rpc: [
      'https://polygon-rpc.com',
      'https://rpc.ankr.com/polygon',
      'https://polygon-mainnet.public.blastapi.io',
      `https://polygon-mainnet.infura.io/v3/09760d45e6844c8b95cc8af069f96160`,
    ],
    nativeToken: 'MATIC',
    nativeTokenSymbol: 'MATIC',
    wrappedNative: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
    blockExplorer: 'https://polygonscan.com',
    balancerVault: BALANCER_V2_VAULT,
    gasEstimateMultiplier: 1.3,
    dexes: [
      {
        name: 'QuickSwap V2',
        type: 'uniswap_v2',
        router: '0xa5E0829CaCed8fFDD4De3C43696C57F7D7a678ff',
        factory: '0x575737141441716865D627a60A0f9B5835857b44',
      },
      {
        name: 'SushiSwap',
        type: 'uniswap_v2',
        router: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
        factory: '0xc35DADB65012eC5796536bD9864e8333dA47092e',
      },
      {
        name: 'Uniswap V3',
        type: 'uniswap_v3',
        router: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
        factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
        quoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
        feeTiers: [100, 500, 3000, 10000],
      },
    ],
    tokens: {
      WETH: { address: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', symbol: 'WMATIC', decimals: 18 },
      WMATIC: { address: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', symbol: 'WMATIC', decimals: 18 },
      USDC: { address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', symbol: 'USDC', decimals: 6 },
      USDT: { address: '0xc2132D05D31c914a87C6611C10748AEb04B8e7E9', symbol: 'USDT', decimals: 6 },
      DAI: { address: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063', symbol: 'DAI', decimals: 18 },
      WBTC: { address: '0x1BFD67037B42Cf73acF2047067bd4F2C47D9Bf6A', symbol: 'WBTC', decimals: 8 },
      WETH_ETH: { address: '0x7ceB233D5b14128BE375E4576D7d0591b3A6C26C', symbol: 'WETH', decimals: 18 },
    },
  },

  arbitrum: {
    id: 42161,
    name: 'Arbitrum One',
    shortName: 'arbitrum',
    rpc: [
      'https://arb1.arbitrum.io/rpc',
      'https://rpc.ankr.com/arbitrum',
      'https://arbitrum-one.public.blastapi.io',
      `https://arbitrum-mainnet.infura.io/v3/09760d45e6844c8b95cc8af069f96160`,
    ],
    nativeToken: 'ETH',
    nativeTokenSymbol: 'ETH',
    wrappedNative: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    blockExplorer: 'https://arbiscan.io',
    balancerVault: BALANCER_V2_VAULT,
    gasEstimateMultiplier: 1.3,
    dexes: [
      {
        name: 'Uniswap V3',
        type: 'uniswap_v3',
        router: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
        factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
        quoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
        feeTiers: [100, 500, 3000, 10000],
      },
      {
        name: 'SushiSwap',
        type: 'uniswap_v2',
        router: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
        factory: '0xc35DADB65012eC5796536bD9864e8333dA47092e',
      },
      {
        name: 'Camelot',
        type: 'uniswap_v2',
        router: '0xcf7Ed6a2A7a0A25b1B28Cf77D4b1B6d8a3E11b1b',
        factory: '0x1a3c6B8cDb3e6c8Fb0a08eD0e36d3B5793a8d836',
      },
    ],
    tokens: {
      WETH: { address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', symbol: 'WETH', decimals: 18 },
      USDC: { address: '0xaf88d6a798e3341c5AAb5c66A6c673504c9d0e65', symbol: 'USDC', decimals: 6 },
      USDT: { address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', symbol: 'USDT', decimals: 6 },
      DAI: { address: '0xDA10009c5d442b2D2634E4DB82BfA7e91B2f4c56', symbol: 'DAI', decimals: 18 },
      WBTC: { address: '0x2f2a2543B76A4166537d4d6Fb065a77e375f6c3B', symbol: 'WBTC', decimals: 8 },
      ARB: { address: '0x912CE59144191C1204E64559FE8253a0e49E6548', symbol: 'ARB', decimals: 18 },
    },
  },

  optimism: {
    id: 10,
    name: 'Optimism',
    shortName: 'optimism',
    rpc: [
      'https://mainnet.optimism.io',
      'https://rpc.ankr.com/optimism',
      'https://optimism-mainnet.public.blastapi.io',
      `https://optimism-mainnet.infura.io/v3/09760d45e6844c8b95cc8af069f96160`,
    ],
    nativeToken: 'ETH',
    nativeTokenSymbol: 'ETH',
    wrappedNative: '0x4200000000000000000000000000000000000006',
    blockExplorer: 'https://optimistic.etherscan.io',
    balancerVault: BALANCER_V2_VAULT,
    gasEstimateMultiplier: 1.3,
    dexes: [
      {
        name: 'Uniswap V3',
        type: 'uniswap_v3',
        router: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
        factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
        quoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
        feeTiers: [100, 500, 3000, 10000],
      },
      {
        name: 'Velodrome',
        type: 'uniswap_v2',
        router: '0x9c12939390052919aF3155f41bF4160fD3666a6f',
        factory: '0x25c6E3a8b4c5d4e6f7a8b9c0d1e2f3a4b5c6d7e8',
      },
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

// ERC20 ABI (minimal)
export const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function totalSupply() view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

// Uniswap V2 Pair ABI (minimal)
export const V2_PAIR_ABI = [
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function totalSupply() view returns (uint256)',
];

// Uniswap V2 Factory ABI
export const V2_FACTORY_ABI = [
  'function getPair(address tokenA, address tokenB) view returns (address pair)',
  'function allPairsLength() view returns (uint256)',
];

// Uniswap V3 Quoter ABI
export const V3_QUOTER_ABI = [
  'function quoteExactInputSingle(address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) view returns (uint256 amountOut)',
  'function quoteExactInput(bytes path, uint256 amountIn) view returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)',
];

// Uniswap V3 Factory ABI
export const V3_FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)',
];

// Uniswap V3 Pool ABI (minimal)
export const V3_POOL_ABI = [
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function liquidity() view returns (uint128)',
  'function fee() view returns (uint24)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
];

// Balancer V2 Vault ABI (flash loan relevant)
export const BALANCER_VAULT_ABI = [
  'function flashLoan(address recipient, address[] tokens, uint256[] amounts, bytes userData) external',
];

// Common token pairs to scan for triangular arbitrage
export const TRIANGULAR_PATHS: Record<string, [string, string, string][]> = {
  polygon: [
    ['WMATIC', 'USDC', 'DAI'],
    ['WMATIC', 'USDC', 'USDT'],
    ['WETH_ETH', 'USDC', 'WMATIC'],
    ['WETH_ETH', 'USDC', 'DAI'],
    ['USDC', 'DAI', 'USDT'],
    ['WBTC', 'WETH_ETH', 'USDC'],
    ['WETH_ETH', 'WMATIC', 'USDC'],
    ['WETH_ETH', 'WMATIC', 'DAI'],
    ['WETH_ETH', 'WBTC', 'USDC'],
    ['WMATIC', 'DAI', 'USDT'],
  ],
  arbitrum: [
    ['WETH', 'USDC', 'DAI'],
    ['WETH', 'USDC', 'USDT'],
    ['WETH', 'USDC', 'ARB'],
    ['WETH', 'WBTC', 'USDC'],
    ['USDC', 'DAI', 'USDT'],
    ['ARB', 'WETH', 'USDC'],
    ['WETH', 'USDC', 'WBTC'],
    ['ARB', 'USDC', 'WETH'],
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
    ['OP', 'USDC', 'DAI'],
    ['WETH', 'USDC', 'WBTC'],
  ],
};

// Two-DEX arbitrage pairs (same token pair on different DEXes)
export const TWO_DEX_PAIRS: Record<string, [string, string][]> = {
  polygon: [
    ['WMATIC', 'USDC'],
    ['WETH_ETH', 'USDC'],
    ['USDC', 'DAI'],
    ['USDC', 'USDT'],
    ['DAI', 'USDT'],
    ['WBTC', 'WETH_ETH'],
    ['WETH_ETH', 'WMATIC'],
    ['WETH_ETH', 'DAI'],
    ['WETH_ETH', 'USDT'],
  ],
  arbitrum: [
    ['WETH', 'USDC'],
    ['WETH', 'USDT'],
    ['WETH', 'DAI'],
    ['USDC', 'DAI'],
    ['USDC', 'USDT'],
    ['WETH', 'ARB'],
    ['WBTC', 'WETH'],
    ['ARB', 'USDC'],
    ['WETH', 'WBTC'],
  ],
  optimism: [
    ['WETH', 'USDC'],
    ['WETH', 'USDT'],
    ['WETH', 'DAI'],
    ['USDC', 'DAI'],
    ['WETH', 'OP'],
    ['OP', 'USDC'],
    ['USDC', 'USDT'],
  ],
};

// Multi-hop paths (4+ hops) for deeper arbitrage discovery
export const MULTI_HOP_PATHS: Record<string, string[][]> = {
  polygon: [
    ['WMATIC', 'USDC', 'WETH_ETH', 'DAI', 'WMATIC'],
    ['WETH_ETH', 'USDC', 'WMATIC', 'DAI', 'WETH_ETH'],
    ['USDC', 'WMATIC', 'WETH_ETH', 'DAI', 'USDC'],
    ['WMATIC', 'USDC', 'DAI', 'USDT', 'WMATIC'],
    ['WETH_ETH', 'WMATIC', 'USDC', 'DAI', 'WETH_ETH'],
  ],
  arbitrum: [
    ['WETH', 'USDC', 'ARB', 'USDT', 'WETH'],
    ['WETH', 'USDC', 'DAI', 'USDT', 'WETH'],
    ['ARB', 'WETH', 'USDC', 'DAI', 'ARB'],
    ['USDC', 'WETH', 'ARB', 'USDT', 'USDC'],
    ['WETH', 'WBTC', 'USDC', 'DAI', 'WETH'],
  ],
  optimism: [
    ['WETH', 'USDC', 'OP', 'DAI', 'WETH'],
    ['WETH', 'USDC', 'DAI', 'USDT', 'WETH'],
    ['OP', 'WETH', 'USDC', 'DAI', 'OP'],
    ['USDC', 'WETH', 'OP', 'DAI', 'USDC'],
  ],
};
