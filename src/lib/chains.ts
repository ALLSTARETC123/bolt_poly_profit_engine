export interface ChainConfig {
  key: string;
  name: string;
  chainId: number;
  rpcUrl: string;
  wsUrl?: string; // Essential for Solana WebSocket event listeners
  flashbotsRpc: string;
  alchemyRpcBase: string;
  blockTimeMs: number;
  nativeSymbol: string;
  nativeCoingeckoId: string;
  
  // Mint / Contract Addresses
  usdcAddress: string;
  usdtAddress: string;
  wethAddress: string;
  daiAddress: string;
  wbtcAddress: string;
  
  // EVM Routers
  balancerVault: string;
  uniswapV3Router: string;
  uniswapV3Quoter: string;
  sushiRouter: string;
  quickswapRouter: string;
  
  // Solana / Pump.fun Program IDs
  pumpFunProgramId?: string;
  pumpFunFeeRecipient?: string;
  pumpSwapAmmId?: string; // Pump.fun internal AMM program ID
  raydiumAmmV4?: string;
  raydiumCpmm?: string;
  jupiterRouter?: string;
  
  // Relayers
  alchemyPaymasterAddress: string;
  faucetUrl: string;
  faucetNote: string;
}

export const CHAINS: Record<string, ChainConfig> = {
  polygon: {
    key: 'polygon',
    name: 'Polygon PoS',
    chainId: 137,
    rpcUrl: 'https://polygon-rpc.com',
    wsUrl: 'wss://polygon-mainnet.g.alchemy.com/v2/',
    flashbotsRpc: 'https://builder.mempool.mobi',
    alchemyRpcBase: 'https://polygon-mainnet.g.alchemy.com/v2/',
    blockTimeMs: 2100,
    nativeSymbol: 'POL',
    nativeCoingeckoId: 'polygon-ecosystem-token',
    usdcAddress: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    usdtAddress: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
    wethAddress: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
    daiAddress: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063',
    wbtcAddress: '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6',
    balancerVault: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
    uniswapV3Router: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
    uniswapV3Quoter: '0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6',
    sushiRouter: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
    quickswapRouter: '0xa5E0829cACd0E03e0941f293b7E80f6bc0638575',
    alchemyPaymasterAddress: '0x000002b28E40584049185c077d85c8fC550b06a0',
    faucetUrl: 'https://faucet.polygon.technology/',
    faucetNote: 'Polygon Official Faucet',
  },
  base: {
    key: 'base',
    name: 'Base',
    chainId: 8453,
    rpcUrl: 'https://mainnet.base.org',
    wsUrl: 'wss://base-mainnet.g.alchemy.com/v2/',
    flashbotsRpc: 'https://mainnet-sequencer.base.org',
    alchemyRpcBase: 'https://base-mainnet.g.alchemy.com/v2/',
    blockTimeMs: 2000,
    nativeSymbol: 'ETH',
    nativeCoingeckoId: 'ethereum',
    usdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    usdtAddress: '0xfde4C96c8112d0270515696155502E723c3d5248',
    wethAddress: '0x4200000000000000000000000000000000000006',
    daiAddress: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
    wbtcAddress: '0x0555E30da8f98308EdB960aa94C0Db47230d2B9c',
    balancerVault: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
    uniswapV3Router: '0x26266B49502A873804737720BCb3894D43610f53',
    uniswapV3Quoter: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
    sushiRouter: '0x838B7F828766D9d292d312c4D9F91A8A26A20E1C',
    quickswapRouter: '',
    alchemyPaymasterAddress: '0x000002b28E40584049185c077d85c8fC550b06a0',
    faucetUrl: 'https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet',
    faucetNote: 'Base Sepolia Testnet Faucet',
  },
  arbitrum: {
    key: 'arbitrum',
    name: 'Arbitrum One',
    chainId: 42161,
    rpcUrl: 'https://arb1.arbitrum.io/rpc',
    wsUrl: 'wss://arb-mainnet.g.alchemy.com/v2/',
    flashbotsRpc: 'https://relay.flashbots.net',
    alchemyRpcBase: 'https://arb-mainnet.g.alchemy.com/v2/',
    blockTimeMs: 250,
    nativeSymbol: 'ETH',
    nativeCoingeckoId: 'ethereum',
    usdcAddress: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    usdtAddress: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
    wethAddress: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    daiAddress: '0xDA10008c57151522248206977180D82aA3597c23',
    wbtcAddress: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f',
    balancerVault: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
    uniswapV3Router: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
    uniswapV3Quoter: '0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6',
    sushiRouter: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
    quickswapRouter: '',
    alchemyPaymasterAddress: '0x000002b28E40584049185c077d85c8fC550b06a0',
    faucetUrl: 'https://faucet.quicknode.com/arbitrum/sepolia',
    faucetNote: 'Arbitrum Sepolia Testnet Faucet',
  },
  optimism: {
    key: 'optimism',
    name: 'OP Mainnet',
    chainId: 10,
    rpcUrl: 'https://mainnet.optimism.io',
    wsUrl: 'wss://opt-mainnet.g.alchemy.com/v2/',
    flashbotsRpc: 'https://relay.flashbots.net',
    alchemyRpcBase: 'https://opt-mainnet.g.alchemy.com/v2/',
    blockTimeMs: 2000,
    nativeSymbol: 'ETH',
    nativeCoingeckoId: 'ethereum',
    usdcAddress: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
    usdtAddress: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58',
    wethAddress: '0x4200000000000000000000000000000000000006',
    daiAddress: '0xDA10008c57151522248206977180D82aA3597c23',
    wbtcAddress: '0x68f180fcCe6836688e9084f035309E29Bf0A2095',
    balancerVault: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
    uniswapV3Router: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
    uniswapV3Quoter: '0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6',
    sushiRouter: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
    quickswapRouter: '',
    alchemyPaymasterAddress: '0x000002b28E40584049185c077d85c8fC550b06a0',
    faucetUrl: 'https://faucet.quicknode.com/optimism/sepolia',
    faucetNote: 'Optimism Sepolia Testnet Faucet',
  },
  solana: {
    key: 'solana',
    name: 'Solana Mainnet',
    chainId: 101,
    rpcUrl: 'https://api.mainnet-beta.solana.com',
    wsUrl: 'wss://api.mainnet-beta.solana.com',
    flashbotsRpc: 'https://mainnet.block-engine.jito.wtf/api/v1/bundles',
    alchemyRpcBase: 'https://solana-mainnet.g.alchemy.com/v2/',
    blockTimeMs: 400,
    nativeSymbol: 'SOL',
    nativeCoingeckoId: 'solana',
    
    usdcAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    usdtAddress: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    wethAddress: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
    daiAddress: 'FYpdB214nbUdT2UBM2f756Zs86WRaV4UGX7ACiYTXvSJ',
    wbtcAddress: '3NZ9JMVBmGAq3fffKG22222222222222222222222222',
    
    balancerVault: '',
    uniswapV3Router: '',
    uniswapV3Quoter: '',
    sushiRouter: '',
    quickswapRouter: '',
    
    pumpFunProgramId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    pumpFunFeeRecipient: 'CebN5WG1356v3K9527xk88K3JP8P462y94G1g5D2Ea',
    pumpSwapAmmId: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
    raydiumAmmV4: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
    raydiumCpmm: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
    jupiterRouter: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
    
    alchemyPaymasterAddress: '',
    faucetUrl: 'https://faucet.solana.com/',
    faucetNote: 'Solana Devnet Faucet',
  },
};

export function getChainConfig(chainKey: string): ChainConfig {
  const config = CHAINS[chainKey];
  if (!config) {
    throw new Error(`Unsupported chain key: ${chainKey}`);
  }
  return config;
    }
