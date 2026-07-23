export interface ChainConfig {
  key: string;
  name: string;
  chainId: number;
  rpcUrl: string;
  blockTimeMs: number;
  nativeSymbol: string;
  usdcAddress: string;
  wethAddress: string;
  flashLoanProvider: string;
}

export const CHAINS: Record<string, ChainConfig> = {
  polygon: {
    key: 'polygon',
    name: 'Polygon',
    chainId: 137,
    rpcUrl: 'https://polygon-rpc.com',
    blockTimeMs: 2000,
    nativeSymbol: 'MATIC',
    usdcAddress: '0x2791Bca1f2de4661ED88A30C99A7a9c9604150Bf',
    wethAddress: '0x0d500B1d8E8Fb9Fb2771a49E6DdAd40e3285B057',
    flashLoanProvider: 'balancer',
  },
  arbitrum: {
    key: 'arbitrum',
    name: 'Arbitrum',
    chainId: 42161,
    rpcUrl: 'https://arb1.arbitrum.io/rpc',
    blockTimeMs: 250,
    nativeSymbol: 'ETH',
    usdcAddress: '0xaf88d065e77c8cC2239D7c0c0c0c0c0c0c0c0c0c',
    wethAddress: '0x82aF49447D8a07e3bd95BD0d56f692Fb9E66F8a4',
    flashLoanProvider: 'balancer',
  },
  optimism: {
    key: 'optimism',
    name: 'Optimism',
    chainId: 10,
    rpcUrl: 'https://mainnet.optimism.io',
    blockTimeMs: 2000,
    nativeSymbol: 'ETH',
    usdcAddress: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
    wethAddress: '0x4200000000000000000000000000000000000006',
    flashLoanProvider: 'balancer',
  },
  base: {
    key: 'base',
    name: 'Base',
    chainId: 8453,
    rpcUrl: 'https://mainnet.base.org',
    blockTimeMs: 2000,
    nativeSymbol: 'ETH',
    usdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    wethAddress: '0x4200000000000000000000000000000000000006',
    flashLoanProvider: 'balancer',
  },
};

export const CHAIN_KEYS = Object.keys(CHAINS);
export const SCAN_INTERVAL_MS = 3000;
