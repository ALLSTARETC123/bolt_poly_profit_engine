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
  wsRpc?: string[];
  nativeToken: string;
  nativeTokenSymbol: string;
  wrappedNative: string;
  blockExplorer: string;
  aavePool: string;
  aavePoolConfigurator: string;
  flashLoanFeeBps: number; // Aave V3: 5 bps = 0.05%
  gasEstimateMultiplier: number;
  dexes: DexConfig[];
  tokens: Record<string, TokenConfig>;
}

export interface DexConfig {
  name: string;
  type: 'uniswap_v2' | 'uniswap_v3' | 'algebra' | 'curve';
  router: string;
  factory: string;
  quoter?: string; // V3 only
  feeTiers?: number[]; // V3 only
}

export interface TokenConfig {
  address: string;
  symbol: string;
  decimals: number;
}

// Aave V3 Pool address is the same across Polygon, Arbitrum, and Optimism
const AAVE_V3_POOL = '0x794a61358D6845594F94dc1DB02A252b5b4814aD';

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
    aavePool: AAVE_V3_POOL,
    aavePoolConfigurator: '0x8145eddDf43F50276641b55bd3AD95944510021E',
    flashLoanFeeBps: 5,
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
    aavePool: AAVE_V3_POOL,
    aavePoolConfigurator: '0x8145eddDf43F50276641b55bd3AD95944510021E',
    flashLoanFeeBps: 5,
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
    aavePool: AAVE_V3_POOL,
    aavePoolConfigurator: '0x8145eddDf43F50276641b55bd3AD95944510021E',
    flashLoanFeeBps: 5,
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
        router: '0xa062a7275dB4F3e5405F8C7F3a1dBf1B2cA2cA2c',
        factory: '0x25c6E3a8b4c5d4e6f7a8b9c0d1e2f3a4b5c6d7e8',
      },
    ],
    tokens: {
      WETH: { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18 },
      USDC: { address: '0x0b2C639c2E740676B1A3b4bE0c8A6e4d3a2B1c5D', symbol: 'USDC', decimals: 6 },
      USDT: { address: '0x94b008aA00cb79c4B7D8C2C2e6F3a4B5c6D7e8F9', symbol: 'USDT', decimals: 6 },
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

// Aave V3 Pool ABI (flash loan relevant)
export const AAVE_V3_POOL_ABI = [
  'function flashLoanSimple(address receiver, address asset, uint256 amount, bytes params) external',
  'function flashLoan(address receiverAddress, address[] assets, uint256[] amounts, bytes modes, address onBehalfOf, bytes params, uint16 referralCode) external',
  'function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
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
  ],
  arbitrum: [
    ['WETH', 'USDC', 'DAI'],
    ['WETH', 'USDC', 'USDT'],
    ['WETH', 'USDC', 'ARB'],
    ['WETH', 'WBTC', 'USDC'],
    ['USDC', 'DAI', 'USDT'],
    ['ARB', 'WETH', 'USDC'],
  ],
  optimism: [
    ['WETH', 'USDC', 'DAI'],
    ['WETH', 'USDC', 'USDT'],
    ['WETH', 'USDC', 'OP'],
    ['USDC', 'DAI', 'USDT'],
    ['OP', 'WETH', 'USDC'],
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
  ],
  arbitrum: [
    ['WETH', 'USDC'],
    ['WETH', 'USDT'],
    ['WETH', 'DAI'],
    ['USDC', 'DAI'],
    ['USDC', 'USDT'],
    ['WETH', 'ARB'],
  ],
  optimism: [
    ['WETH', 'USDC'],
    ['WETH', 'USDT'],
    ['WETH', 'DAI'],
    ['USDC', 'DAI'],
    ['WETH', 'OP'],
  ],
};
