export interface ChainConfig {
  key: string;
  name: string;
  chainId: number;
  rpcUrl: string;
  blockTimeMs: number;
  nativeSymbol: string;
  usdcAddress: string;
  usdtAddress: string;
  wethAddress: string;
  daiAddress: string;
  wbtcAddress: string;
  wmaticAddress: string;
  balancerVault: string;
  uniswapV3Router: string;
  uniswapV3Quoter: string;
  sushiRouter: string;
  quickswapRouter: string;
  curveRegistry: string;
  gelatoFeeCollector: string;
  flashLoanProvider: string;
}

const INFURA_KEY = import.meta.env.VITE_INFURA_KEY || '';

export const CHAINS: Record<string, ChainConfig> = {
  polygon: {
    key: 'polygon', name: 'Polygon', chainId: 137,
    rpcUrl: `https://polygon-mainnet.infura.io/v3/${INFURA_KEY}`,
    blockTimeMs: 2000, nativeSymbol: 'MATIC',
    usdcAddress: '0x2791Bca1f2de4661ED88A30C99A7a9c9604150Bf',
    usdtAddress: '0xc2132D05D31c975a52C45234C3B492B767d1A2F6',
    wethAddress: '0x0d500B1d8E8Fb9Fb2771a49E6DdAd40e3285B057',
    daiAddress: '0x8f3Cf7ad23Cd3Ca5D40B1f9b9f3b56E5c62E5398',
    wbtcAddress: '0x1BFD67037B42Cf73acF2047067bd4F2C47D9Bfd6',
    wmaticAddress: '0x0d500B1d8E8Fb9Fb2771a49E6DdAd40e3285B057',
    balancerVault: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
    uniswapV3Router: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
    uniswapV3Quoter: '0xb273088f0FF97Be22fAee0586a0E9dD5dF085D77',
    sushiRouter: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
    quickswapRouter: '0xa5E0829CaCED8fFDD4De3c43696c57C7324c41D2',
    curveRegistry: '0x90E7AC78Bd8f0b1b305d0F3D2900E53732aD30cf',
    gelatoFeeCollector: '0x0B162eC3D8e5F0a1D5e1c68E5D5c4c4c4c4c4c4c',
    flashLoanProvider: 'balancer',
  },
  arbitrum: {
    key: 'arbitrum', name: 'Arbitrum', chainId: 42161,
    rpcUrl: `https://arbitrum-mainnet.infura.io/v3/${INFURA_KEY}`,
    blockTimeMs: 250, nativeSymbol: 'ETH',
    usdcAddress: '0xFF970A3A0446711E4f29A4A04cF4135c6C2D4511',
    usdtAddress: '0xFd086bC7115B45112D9b676BC1d6B68eB7c8C2c4',
    wethAddress: '0x82aF49447D8a07e3bd95BD0d56f692Fb9E66F8a4',
    daiAddress: '0x0000000000000000000000000000000000000000',
    wbtcAddress: '0x0000000000000000000000000000000000000000',
    wmaticAddress: '0x0000000000000000000000000000000000000000',
    balancerVault: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
    uniswapV3Router: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
    uniswapV3Quoter: '0xb273088f0FF97Be22fAee0586a0E9dD5dF085D77',
    sushiRouter: '0x0000000000000000000000000000000000000000',
    quickswapRouter: '0x0000000000000000000000000000000000000000',
    curveRegistry: '0x0000000000000000000000000000000000000000',
    gelatoFeeCollector: '0x0B162eC3D8e5F0a1D5e1c68E5D5c4c4c4c4c4c4c',
    flashLoanProvider: 'balancer',
  },
  optimism: {
    key: 'optimism', name: 'Optimism', chainId: 10,
    rpcUrl: `https://optimism-mainnet.infura.io/v3/${INFURA_KEY}`,
    blockTimeMs: 2000, nativeSymbol: 'ETH',
    usdcAddress: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
    usdtAddress: '0x0000000000000000000000000000000000000000',
    wethAddress: '0x4200000000000000000000000000000000000006',
    daiAddress: '0x0000000000000000000000000000000000000000',
    wbtcAddress: '0x0000000000000000000000000000000000000000',
    wmaticAddress: '0x0000000000000000000000000000000000000000',
    balancerVault: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
    uniswapV3Router: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
    uniswapV3Quoter: '0xb273088f0FF97Be22fAee0586a0E9dD5dF085D77',
    sushiRouter: '0x0000000000000000000000000000000000000000',
    quickswapRouter: '0x0000000000000000000000000000000000000000',
    curveRegistry: '0x0000000000000000000000000000000000000000',
    gelatoFeeCollector: '0x0B162eC3D8e5F0a1D5e1c68E5D5c4c4c4c4c4c4c',
    flashLoanProvider: 'balancer',
  },
  base: {
    key: 'base', name: 'Base', chainId: 8453,
    rpcUrl: `https://base-mainnet.infura.io/v3/${INFURA_KEY}`,
    blockTimeMs: 2000, nativeSymbol: 'ETH',
    usdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    usdtAddress: '0x0000000000000000000000000000000000000000',
    wethAddress: '0x4200000000000000000000000000000000000006',
    daiAddress: '0x0000000000000000000000000000000000000000',
    wbtcAddress: '0x0000000000000000000000000000000000000000',
    wmaticAddress: '0x0000000000000000000000000000000000000000',
    balancerVault: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
    uniswapV3Router: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
    uniswapV3Quoter: '0xb273088f0FF97Be22fAee0586a0E9dD5dF085D77',
    sushiRouter: '0x0000000000000000000000000000000000000000',
    quickswapRouter: '0x0000000000000000000000000000000000000000',
    curveRegistry: '0x0000000000000000000000000000000000000000',
    gelatoFeeCollector: '0x0B162eC3D8e5F0a1D5e1c68E5D5c4c4c4c4c4c4c',
    flashLoanProvider: 'balancer',
  },
};

export const CHAIN_KEYS = Object.keys(CHAINS);
export const SCAN_INTERVAL_MS = 3000;

export const TOKEN_SYMBOLS = ['WETH', 'USDC', 'USDT', 'DAI', 'WBTC'] as const;

export function getTokenAddress(chainKey: string, symbol: string): string {
  const chain = CHAINS[chainKey];
  if (!chain) return '';
  switch (symbol) {
    case 'WETH': return chain.wethAddress;
    case 'USDC': return chain.usdcAddress;
    case 'USDT': return chain.usdtAddress;
    case 'DAI': return chain.daiAddress;
    case 'WBTC': return chain.wbtcAddress;
    case 'WMATIC': return chain.wmaticAddress;
    default: return '';
  }
}

export const TOKEN_PAIRS: [string, string][] = [
  ['WETH', 'USDC'], ['WETH', 'USDT'], ['WETH', 'DAI'],
  ['WBTC', 'WETH'], ['USDC', 'USDT'], ['USDC', 'DAI'], ['USDT', 'DAI'],
];

export const V3_FEES = [500, 3000, 10000];
