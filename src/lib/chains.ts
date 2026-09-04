export interface ChainConfig {
  key: string;
  name: string;
  chainId: number;
  rpcUrl: string;
  flashbotsRpc: string;
  alchemyRpcBase: string;
  blockTimeMs: number;
  nativeSymbol: string;
  nativeCoingeckoId: string;
  usdcAddress: string;
  usdtAddress: string;
  wethAddress: string;
  daiAddress: string;
  wbtcAddress: string;
  balancerVault: string;
  uniswapV3Router: string;
  uniswapV3Quoter: string;
  sushiRouter: string;
  quickswapRouter: string;
  alchemyPaymasterAddress: string;
  faucetUrl: string;
  faucetNote: string;
}

export const CHAINS: Record<string, ChainConfig> = {
  polygon: {
    key: 'polygon', name: 'Polygon', chainId: 137,
    rpcUrl: 'https://polygon-rpc.com',
    flashbotsRpc: 'https://rpc.flashbots.net',
    alchemyRpcBase: 'https://polygon-mainnet.g.alchemy.com/v2/',
    blockTimeMs: 2000, nativeSymbol: 'MATIC',
    nativeCoingeckoId: 'matic-network',
    usdcAddress: '0x2791Bca1f2de4661ED88A30C99A7a9c9604150Bf',
    usdtAddress: '0xc2132D05D31c975a52C45234C3B492B767d1A2F6',
    wethAddress: '0x0d500B1d8E8Fb9Fb2771a49E6DdAd40e3285B057',
    daiAddress: '0x8f3Cf7ad23Cd3Ca5D40B1f9b9f3b56E5c62E5398',
    wbtcAddress: '0x1BFD67037B42Cf73acF2047077c4Df6Bf1A8E6C2',
    balancerVault: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
    uniswapV3Router: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
    uniswapV3Quoter: '0xb273088f0FF9400A6119C58A5c84F9c55a2c3B7D',
    sushiRouter: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
    quickswapRouter: '0xa5E0829CaCED8fFDD4De3c43696c57C7324c41D2',
    alchemyPaymasterAddress: '0x0000000000000000000000000000000000000000',
    faucetUrl: 'https://faucet.polygon.technology/',
    faucetNote: 'Free MATIC for gas — Polygon official faucet',
  },
  arbitrum: {
    key: 'arbitrum', name: 'Arbitrum', chainId: 42161,
    rpcUrl: 'https://arb1.arbitrum.io/rpc',
    flashbotsRpc: 'https://rpc.flashbots.net',
    alchemyRpcBase: 'https://arb-mainnet.g.alchemy.com/v2/',
    blockTimeMs: 250, nativeSymbol: 'ETH',
    nativeCoingeckoId: 'ethereum',
    usdcAddress: '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8',
    usdtAddress: '0xFd086bC7115B4512D9b676BC1d6B68eB7c8C2c4',
    wethAddress: '0x82aF49447D8a07e3bd95BD0d56f692Fb9E66F8a4',
    daiAddress: '0xDA10009cBd5D07dd0cecc66161FC93D7c9000da1',
    wbtcAddress: '0x2f2a2543B76A4166549f7aAb2D9511A8EFA73092',
    balancerVault: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
    uniswapV3Router: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
    uniswapV3Quoter: '0xb273088f0FF9400A6119C58A5c84F9c55a2c3B7D',
    sushiRouter: '0xf2614A233c7C3e7f08b1F887Ba133a13f1eb2c55',
    quickswapRouter: '0x0000000000000000000000000000000000000000',
    alchemyPaymasterAddress: '0x0000000000000000000000000000000000000000',
    faucetUrl: 'https://faucet.quicknode.com/arbitrum',
    faucetNote: 'Free ETH for gas — QuickNode faucet',
  },
  optimism: {
    key: 'optimism', name: 'Optimism', chainId: 10,
    rpcUrl: 'https://mainnet.optimism.io',
    flashbotsRpc: 'https://rpc.flashbots.net',
    alchemyRpcBase: 'https://opt-mainnet.g.alchemy.com/v2/',
    blockTimeMs: 2000, nativeSymbol: 'ETH',
    nativeCoingeckoId: 'ethereum',
    usdcAddress: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
    usdtAddress: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58',
    wethAddress: '0x4200000000000000000000000000000000000006',
    daiAddress: '0xDA10009cBd5D07dd0cecc66161FC93D7c9000da1',
    wbtcAddress: '0x68f180fcCe6836688e9084f035309e29BF0a2095',
    balancerVault: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
    uniswapV3Router: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
    uniswapV3Quoter: '0xb273088f0FF9400A6119C58A5c84F9c55a2c3B7D',
    sushiRouter: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
    quickswapRouter: '0x0000000000000000000000000000000000000000',
    alchemyPaymasterAddress: '0x0000000000000000000000000000000000000000',
    faucetUrl: 'https://faucet.quicknode.com/optimism',
    faucetNote: 'Free ETH for gas — QuickNode faucet',
  },
  base: {
    key: 'base', name: 'Base', chainId: 8453,
    rpcUrl: 'https://mainnet.base.org',
    flashbotsRpc: 'https://rpc.flashbots.net',
    alchemyRpcBase: 'https://base-mainnet.g.alchemy.com/v2/',
    blockTimeMs: 2000, nativeSymbol: 'ETH',
    nativeCoingeckoId: 'ethereum',
    usdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    usdtAddress: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
    wethAddress: '0x4200000000000000000000000000000000000006',
    daiAddress: '0x50c5725949a6f0c72E6C4a641F24049A917DB0cb',
    wbtcAddress: '0x0555E30da8f98308EdB960aa94C0Db47230d2B9c',
    balancerVault: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
    uniswapV3Router: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
    uniswapV3Quoter: '0xb273088f0FF9400A6119C58A5c84F9c55a2c3B7D',
    sushiRouter: '0x6BdED42c6da8FBF0d2ba55B2fa120c5e0c8D7891',
    quickswapRouter: '0x0000000000000000000000000000000000000000',
    alchemyPaymasterAddress: '0x0000000000000000000000000000000000000000',
    faucetUrl: 'https://faucet.quicknode.com/base',
    faucetNote: 'Free ETH for gas — QuickNode faucet',
  },
};

export const CHAIN_KEYS = Object.keys(CHAINS);
export const SCAN_INTERVAL_MS = 5000;

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
    default: return '';
  }
}

export const TOKEN_PAIRS: [string, string][] = [
  ['WETH', 'USDC'], ['WETH', 'USDT'], ['WETH', 'DAI'],
  ['WBTC', 'WETH'], ['USDC', 'USDT'], ['USDC', 'DAI'], ['USDT', 'DAI'],
];

export const V3_FEES = [500, 3000, 10000];

export interface LongTailToken {
  symbol: string;
  address: string;
  chain: string;
  coingeckoId: string;
  category: 'meme' | 'gaming' | 'ai' | 'defi' | 'l2';
}

export const LONG_TAIL_TOKENS: LongTailToken[] = [
  { symbol: 'LDO', address: '0xC3Ca790749c2972Ef7A8f7a82a921c9200407B6e', chain: 'polygon', coingeckoId: 'lido-dao', category: 'defi' },
  { symbol: 'WMATIC', address: '0x0d500B1d8E8Fb9Fb2771a49E6DdAd40e3285B057', chain: 'polygon', coingeckoId: 'matic-network', category: 'l2' },
  { symbol: 'GHST', address: '0x385Eeac5cB36121143590692602Fe5e5D776E252', chain: 'polygon', coingeckoId: 'aavegotchi', category: 'gaming' },
  { symbol: 'ARB', address: '0x912CE59144191C1204E64559FE8253a0e49E6548', chain: 'arbitrum', coingeckoId: 'arbitrum', category: 'l2' },
  { symbol: 'GMX', address: '0xfc5A1A6EB076a2C7aD06eDfD9cB3c4c7dF7F8a3', chain: 'arbitrum', coingeckoId: 'gmx', category: 'defi' },
  { symbol: 'RDNT', address: '0x3082CC235060a1fFA0C6b4a0E1c4F9cBB2e91c7F', chain: 'arbitrum', coingeckoId: 'radiant-capital', category: 'defi' },
  { symbol: 'OP', address: '0x4200000000000000000000000000000000000042', chain: 'optimism', coingeckoId: 'optimism', category: 'l2' },
  { symbol: 'VELO', address: '0x3c8B650257cFb5fEA2b4f7B9aC6F7c2e1c6B2c3D', chain: 'optimism', coingeckoId: 'velodrome-finance', category: 'defi' },
  { symbol: 'SNX', address: '0x8700dAec35aF8F886F84c3986B9399756B5F7Fe2', chain: 'optimism', coingeckoId: 'havven', category: 'defi' },
  { symbol: 'DEGEN', address: '0x4ed4E862152247d343c0aC5f7a3f6c8c93C1F2B5', chain: 'base', coingeckoId: 'degen', category: 'meme' },
  { symbol: 'BRETT', address: '0x4F3E1cF7c8c8B5c4e8B5e8c8B5c4e8B5e8c8B5c4', chain: 'base', coingeckoId: 'brett', category: 'meme' },
  { symbol: 'AERO', address: '0x940E2B1a8c8c5c4e8B5e8c8B5c4e8B5e8c8B5c4e', chain: 'base', coingeckoId: 'aerodrome-finance', category: 'defi' },
];

export function getAlchemyRpcUrl(chainKey: string, apiKey: string): string {
  const chain = CHAINS[chainKey];
  if (!chain || !apiKey) return chain?.rpcUrl || '';
  return chain.alchemyRpcBase + apiKey;
}

export function getFlashbotsProvider(chainKey: string): string {
  const chain = CHAINS[chainKey];
  return chain?.flashbotsRpc || 'https://rpc.flashbots.net';
}

export function getProviderConfig(chainKey: string, alchemyApiKey?: string): { url: string; isFlashbots: boolean } {
  if (alchemyApiKey) {
    return { url: getAlchemyRpcUrl(chainKey, alchemyApiKey), isFlashbots: false };
  }
  const chain = CHAINS[chainKey];
  return { url: chain.rpcUrl, isFlashbots: false };
}
