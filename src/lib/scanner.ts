import { ethers } from 'ethers';
import {
  CHAINS, CHAIN_KEYS, ChainConfig, TokenConfig,
  V2_PAIR_ABI, V2_FACTORY_ABI, V3_QUOTER_ABI, DODO_FACTORY_ABI,
  TRIANGULAR_PATHS, TWO_DEX_PAIRS, MULTI_HOP_PATHS,
} from './chains';

export interface ArbitrageOpportunity {
  chain: string;
  opportunityType: 'two_dex' | 'triangular' | 'multi_hop';
  tokenPath: string[];
  tokenAddresses: string[];
  dexPath: string[];
  flashLoanAsset: string;
  flashLoanAmount: number;
  estimatedProfit: number;
  estimatedGasCost: number;
  netProfit: number;
  profitMarginPct: number;
  confidenceScore: number;
  flashProvider: 'balancer_v2' | 'dodo_v2';
  blockNumber: number;
}

export interface ScanResult {
  chain: string;
  opportunities: ArbitrageOpportunity[];
  scanTimeMs: number;
  error?: string;
}

const FLASH_LOAN_AMOUNTS: Record<string, number> = {
  WMATIC: 50000, WETH: 100, USDC: 100000, USDT: 100000,
  DAI: 100000, WBTC: 2, ARB: 100000, OP: 100000,
};

export async function scanAllChains(): Promise<ScanResult[]> {
  return Promise.all(CHAIN_KEYS.map(chainKey => scanChain(chainKey)));
}

async function scanChain(chainKey: string): Promise<ScanResult> {
  const start = Date.now();
  const chain = CHAINS[chainKey];
  if (!chain) return { chain: chainKey, opportunities: [], scanTimeMs: 0 };

  try {
    const provider = new ethers.JsonRpcProvider(chain.rpc[0]);
    const blockNumber = await provider.getBlockNumber();

    const [twoDex, triangular, multiHop] = await Promise.allSettled([
      scanTwoDexArb(chainKey, provider),
      scanTriangularArb(chainKey, provider),
      scanMultiHopArb(chainKey, provider),
    ]);

    const opps: ArbitrageOpportunity[] = [];
    if (twoDex.status === 'fulfilled') opps.push(...twoDex.value);
    if (triangular.status === 'fulfilled') opps.push(...triangular.value);
    if (multiHop.status === 'fulfilled') opps.push(...multiHop.value);

    const gasCost = await fetchGasCostUsd(chainKey, provider);
    const withNet = opps.map(o => ({
      ...o,
      estimatedGasCost: gasCost,
      netProfit: o.estimatedProfit - gasCost,
      profitMarginPct: o.estimatedProfit > 0 ? ((o.estimatedProfit - gasCost) / o.estimatedProfit) * 100 : 0,
      blockNumber,
    }));

    return {
      chain: chainKey,
      opportunities: withNet.filter(o => o.netProfit > 0).sort((a, b) => b.netProfit - a.netProfit),
      scanTimeMs: Date.now() - start,
    };
  } catch (err: any) {
    return { chain: chainKey, opportunities: [], scanTimeMs: Date.now() - start, error: err.message };
  }
}

export async function scanTwoDexArb(chainKey: string, provider: ethers.JsonRpcProvider): Promise<ArbitrageOpportunity[]> {
  const chain = CHAINS[chainKey];
  const pairs = TWO_DEX_PAIRS[chainKey] || [];
  const opps: ArbitrageOpportunity[] = [];

  const results = await Promise.allSettled(pairs.map(async ([tokenA, tokenB]) => {
    const prices = await getBestPrice(chainKey, provider, tokenA, tokenB);
    if (prices.length < 2) return null;

    const sorted = [...prices].sort((a, b) => b.price - a.price);
    const best = sorted[0];
    const worst = sorted[sorted.length - 1];
    if (best.price <= 0 || worst.price <= 0) return null;

    const spread = ((best.price - worst.price) / worst.price) * 100;
    if (spread < 0.1) return null;

    const flashAmount = FLASH_LOAN_AMOUNTS[tokenA] || 10000;
    const estProfit = (flashAmount * spread) / 100 * 0.5;
    const dodoPool = await findDodoPool(chainKey, provider, chain.tokens[tokenA]?.address, chain.tokens[tokenB]?.address);

    return {
      chain: chainKey,
      opportunityType: 'two_dex' as const,
      tokenPath: [tokenA, tokenB],
      tokenAddresses: [chain.tokens[tokenA]?.address, chain.tokens[tokenB]?.address].filter(Boolean) as string[],
      dexPath: [best.dex, worst.dex],
      flashLoanAsset: chain.tokens[tokenA]?.address || '',
      flashLoanAmount: flashAmount,
      estimatedProfit: estProfit,
      estimatedGasCost: 0,
      netProfit: 0,
      profitMarginPct: 0,
      confidenceScore: Math.min(1, spread / 5),
      flashProvider: dodoPool ? 'dodo_v2' as const : 'balancer_v2' as const,
      blockNumber: 0,
    };
  }));

  for (const r of results) if (r.status === 'fulfilled' && r.value) opps.push(r.value);
  return opps;
}

export async function scanTriangularArb(chainKey: string, provider: ethers.JsonRpcProvider): Promise<ArbitrageOpportunity[]> {
  const chain = CHAINS[chainKey];
  const paths = TRIANGULAR_PATHS[chainKey] || [];
  const opps: ArbitrageOpportunity[] = [];

  const results = await Promise.allSettled(paths.map(async ([a, b, c]) => {
    const [p1, p2, p3] = await Promise.all([
      getBestPrice(chainKey, provider, a, b),
      getBestPrice(chainKey, provider, b, c),
      getBestPrice(chainKey, provider, c, a),
    ]);

    if (p1.length === 0 || p2.length === 0 || p3.length === 0) return null;

    const buyA = p1[0];
    const midBC = p2[0];
    const sellCA = p3[0];
    if (buyA.price <= 0 || midBC.price <= 0 || sellCA.price <= 0) return null;

    const startAmount = FLASH_LOAN_AMOUNTS[a] || 10000;
    const afterStep1 = startAmount / buyA.price;
    const afterStep2 = afterStep1 / midBC.price;
    const endAmount = afterStep2 * sellCA.price;
    const estProfit = endAmount - startAmount;

    if (estProfit <= 0) return null;

    const dodoPool = await findDodoPool(chainKey, provider, chain.tokens[a]?.address, chain.tokens[b]?.address);

    return {
      chain: chainKey,
      opportunityType: 'triangular' as const,
      tokenPath: [a, b, c, a],
      tokenAddresses: [a, b, c].map(t => chain.tokens[t]?.address || '').filter(Boolean),
      dexPath: [buyA.dex, midBC.dex, sellCA.dex],
      flashLoanAsset: chain.tokens[a]?.address || '',
      flashLoanAmount: startAmount,
      estimatedProfit: estProfit,
      estimatedGasCost: 0,
      netProfit: 0,
      profitMarginPct: 0,
      confidenceScore: Math.min(1, estProfit / (startAmount * 0.01)),
      flashProvider: dodoPool ? 'dodo_v2' as const : 'balancer_v2' as const,
      blockNumber: 0,
    };
  }));

  for (const r of results) if (r.status === 'fulfilled' && r.value) opps.push(r.value);
  return opps;
}

export async function scanMultiHopArb(chainKey: string, provider: ethers.JsonRpcProvider): Promise<ArbitrageOpportunity[]> {
  const chain = CHAINS[chainKey];
  const paths = MULTI_HOP_PATHS[chainKey] || [];
  const opps: ArbitrageOpportunity[] = [];

  const results = await Promise.allSettled(paths.map(async (path) => {
    const prices: { price: number; dex: string }[] = [];
    for (let i = 0; i < path.length - 1; i++) {
      const p = await getBestPrice(chainKey, provider, path[i], path[i + 1]);
      if (p.length > 0) prices.push(p[0]);
    }
    if (prices.length < path.length - 1) return null;

    let amount = FLASH_LOAN_AMOUNTS[path[0]] || 10000;
    for (const p of prices) {
      if (p.price <= 0) return null;
      amount = amount / p.price;
    }
    const estProfit = amount - (FLASH_LOAN_AMOUNTS[path[0]] || 10000);
    if (estProfit <= 0) return null;

    const dodoPool = await findDodoPool(chainKey, provider, chain.tokens[path[0]]?.address, chain.tokens[path[1]]?.address);

    return {
      chain: chainKey,
      opportunityType: 'multi_hop' as const,
      tokenPath: path,
      tokenAddresses: path.map(t => chain.tokens[t]?.address || '').filter(Boolean),
      dexPath: prices.map(p => p.dex),
      flashLoanAsset: chain.tokens[path[0]]?.address || '',
      flashLoanAmount: FLASH_LOAN_AMOUNTS[path[0]] || 10000,
      estimatedProfit: estProfit,
      estimatedGasCost: 0,
      netProfit: 0,
      profitMarginPct: 0,
      confidenceScore: Math.min(1, estProfit / 100),
      flashProvider: dodoPool ? 'dodo_v2' as const : 'balancer_v2' as const,
      blockNumber: 0,
    };
  }));

  for (const r of results) if (r.status === 'fulfilled' && r.value) opps.push(r.value);
  return opps;
}

interface PriceResult { price: number; dex: string }

async function getBestPrice(chainKey: string, provider: ethers.JsonRpcProvider, tokenA: string, tokenB: string): Promise<PriceResult[]> {
  const chain = CHAINS[chainKey];
  const tokenAConfig = chain.tokens[tokenA];
  const tokenBConfig = chain.tokens[tokenB];
  if (!tokenAConfig || !tokenBConfig) return [];

  const amountIn = ethers.parseUnits('1', tokenAConfig.decimals);
  const results = await Promise.allSettled(
    chain.dexes.map(async (dex) => {
      try {
        const price = await getPriceFromDex(chainKey, provider, dex, tokenAConfig, tokenBConfig, amountIn);
        return { price, dex: dex.name };
      } catch { return null; }
    })
  );

  const prices: PriceResult[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value && r.value.price > 0) prices.push(r.value);
  }
  return prices.sort((a, b) => b.price - a.price);
}

async function getPriceFromDex(
  chainKey: string, provider: ethers.JsonRpcProvider,
  dex: any, tokenIn: TokenConfig, tokenOut: TokenConfig, amountIn: bigint,
): Promise<number> {
  const chain = CHAINS[chainKey];

  if (dex.type === 'uniswap_v2' || dex.type === 'algebra' || dex.type === 'velodrome') {
    try {
      const factory = new ethers.Contract(dex.factory, V2_FACTORY_ABI, provider);
      const pairAddress = await factory.getPair(tokenIn.address, tokenOut.address);
      if (pairAddress === ethers.ZeroAddress) return 0;

      const pair = new ethers.Contract(pairAddress, V2_PAIR_ABI, provider);
      const [reserve0, reserve1] = await pair.getReserves();
      const token0 = await pair.token0();

      let reserveIn: bigint, reserveOut: bigint;
      if (token0.toLowerCase() === tokenIn.address.toLowerCase()) {
        reserveIn = reserve0; reserveOut = reserve1;
      } else {
        reserveIn = reserve1; reserveOut = reserve0;
      }

      if (reserveIn <= 0n || reserveOut <= 0n) return 0;
      const amountOut = (amountIn * reserveOut) / (reserveIn + amountIn);
      return parseFloat(ethers.formatUnits(amountOut, tokenOut.decimals));
    } catch { return 0; }
  }

  if (dex.type === 'uniswap_v3') {
    try {
      const quoter = new ethers.Contract(dex.quoter, V3_QUOTER_ABI, provider);
      for (const fee of [3000, 500, 10000]) {
        try {
          const amountOut = await quoter.quoteExactInputSingle(tokenIn.address, tokenOut.address, amountIn, fee, 0);
          if (amountOut > 0n) return parseFloat(ethers.formatUnits(amountOut, tokenOut.decimals));
        } catch { continue; }
      }
      return 0;
    } catch { return 0; }
  }

  return 0;
}

export async function findDodoPool(
  chainKey: string, provider: ethers.JsonRpcProvider,
  baseToken: string | undefined, quoteToken: string | undefined,
): Promise<string | null> {
  if (!baseToken || !quoteToken) return null;
  const chain = CHAINS[chainKey];
  try {
    const factory = new ethers.Contract(chain.dvmFactory, DODO_FACTORY_ABI, provider);
    const pool = await factory.getDVM(baseToken, quoteToken);
    if (pool && pool !== ethers.ZeroAddress) return pool;
  } catch { /* DODO not available */ }
  return null;
}

export async function fetchGasCostUsd(chainKey: string, provider: ethers.JsonRpcProvider): Promise<number> {
  try {
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice || ethers.parseUnits('30', 'gwei');
    const gasLimit = 500000n;
    const gasCostNative = ethers.formatEther(gasPrice * gasLimit);

    const chain = CHAINS[chainKey];
    const nativeToken = chain.tokens.WMATIC || chain.tokens.WETH || chain.tokens.OP;
    if (!nativeToken) return 0.5;

    const usdc = chain.tokens.USDC;
    if (!usdc) return 0.5;

    const prices = await getBestPrice(chainKey, provider, nativeToken.symbol, 'USDC');
    if (prices.length === 0) return 0.5;

    return parseFloat(gasCostNative) * prices[0].price;
  } catch { return 0.5; }
}
