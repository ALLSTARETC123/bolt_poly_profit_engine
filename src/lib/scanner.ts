import { ethers } from 'ethers';
import { CHAINS, CHAIN_KEYS, V2_PAIR_ABI, V2_FACTORY_ABI, PAIR_PATHS, TWO_DEX_PAIRS, type DexConfig, type TokenConfig } from './chains';

export interface ArbitrageOpportunity {
  chain: string;
  opportunityType: string;
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
  blockNumber: number;
}

export interface ScanResult {
  chain: string;
  opportunities: ArbitrageOpportunity[];
  scanTimeMs: number;
  error?: string;
}

const FLASH_AMOUNTS: Record<string, number> = {
  WMATIC: 50000, WETH: 100, USDC: 100000, USDT: 100000, DAI: 100000, ARB: 100000, OP: 100000,
};

export async function scanAllChains(): Promise<ScanResult[]> {
  return Promise.all(CHAIN_KEYS.map(scanChain));
}

async function scanChain(chainKey: string): Promise<ScanResult> {
  const start = Date.now();
  const chain = CHAINS[chainKey];
  if (!chain) return { chain: chainKey, opportunities: [], scanTimeMs: 0 };
  try {
    const provider = new ethers.JsonRpcProvider(chain.rpc[0]);
    const blockNumber = await provider.getBlockNumber();
    const [twoDex, triangular] = await Promise.allSettled([
      scanTwoDex(chainKey, provider),
      scanTriangular(chainKey, provider),
    ]);
    const opps: ArbitrageOpportunity[] = [];
    if (twoDex.status === 'fulfilled') opps.push(...twoDex.value);
    if (triangular.status === 'fulfilled') opps.push(...triangular.value);
    const gasCost = await fetchGasCost(chainKey, provider);
    const withNet = opps.map(o => ({
      ...o, estimatedGasCost: gasCost,
      netProfit: o.estimatedProfit - gasCost,
      profitMarginPct: o.estimatedProfit > 0 ? ((o.estimatedProfit - gasCost) / o.estimatedProfit) * 100 : 0,
      blockNumber,
    }));
    return {
      chain: chainKey,
      opportunities: withNet.filter(o => o.netProfit > 0).sort((a, b) => b.netProfit - a.netProfit),
      scanTimeMs: Date.now() - start,
    };
  } catch (err: unknown) {
    return { chain: chainKey, opportunities: [], scanTimeMs: Date.now() - start, error: String(err) };
  }
}

async function scanTwoDex(chainKey: string, provider: ethers.JsonRpcProvider): Promise<ArbitrageOpportunity[]> {
  const chain = CHAINS[chainKey];
  const pairs = TWO_DEX_PAIRS[chainKey] || [];
  const opps: ArbitrageOpportunity[] = [];
  const results = await Promise.allSettled(pairs.map(async ([tokenA, tokenB]) => {
    const prices = await getBestPrice(chainKey, provider, tokenA, tokenB);
    if (prices.length < 2) return null;
    const best = prices[0], worst = prices[prices.length - 1];
    if (best.price <= 0 || worst.price <= 0) return null;
    const spread = ((best.price - worst.price) / worst.price) * 100;
    if (spread < 0.1) return null;
    const flashAmount = FLASH_AMOUNTS[tokenA] || 10000;
    const estProfit = (flashAmount * spread) / 100 * 0.5;
    return {
      chain: chainKey, opportunityType: 'two_dex',
      tokenPath: [tokenA, tokenB],
      tokenAddresses: [chain.tokens[tokenA]?.address, chain.tokens[tokenB]?.address].filter(Boolean) as string[],
      dexPath: [best.dex, worst.dex],
      flashLoanAsset: chain.tokens[tokenA]?.address || '',
      flashLoanAmount: flashAmount, estimatedProfit: estProfit,
      estimatedGasCost: 0, netProfit: 0, profitMarginPct: 0,
      confidenceScore: Math.min(1, spread / 5), blockNumber: 0,
    };
  }));
  for (const r of results) if (r.status === 'fulfilled' && r.value) opps.push(r.value);
  return opps;
}

async function scanTriangular(chainKey: string, provider: ethers.JsonRpcProvider): Promise<ArbitrageOpportunity[]> {
  const chain = CHAINS[chainKey];
  const paths = PAIR_PATHS[chainKey] || [];
  const opps: ArbitrageOpportunity[] = [];
  const results = await Promise.allSettled(paths.map(async ([a, b, c]) => {
    const [p1, p2, p3] = await Promise.all([
      getBestPrice(chainKey, provider, a, b),
      getBestPrice(chainKey, provider, b, c),
      getBestPrice(chainKey, provider, c, a),
    ]);
    if (!p1.length || !p2.length || !p3.length) return null;
    const buyA = p1[0], midBC = p2[0], sellCA = p3[0];
    if (buyA.price <= 0 || midBC.price <= 0 || sellCA.price <= 0) return null;
    const startAmount = FLASH_AMOUNTS[a] || 10000;
    const afterStep1 = startAmount / buyA.price;
    const afterStep2 = afterStep1 / midBC.price;
    const endAmount = afterStep2 * sellCA.price;
    const estProfit = endAmount - startAmount;
    if (estProfit <= 0) return null;
    return {
      chain: chainKey, opportunityType: 'triangular',
      tokenPath: [a, b, c, a],
      tokenAddresses: [a, b, c].map(t => chain.tokens[t]?.address || '').filter(Boolean),
      dexPath: [buyA.dex, midBC.dex, sellCA.dex],
      flashLoanAsset: chain.tokens[a]?.address || '',
      flashLoanAmount: startAmount, estimatedProfit: estProfit,
      estimatedGasCost: 0, netProfit: 0, profitMarginPct: 0,
      confidenceScore: Math.min(1, estProfit / (startAmount * 0.01)), blockNumber: 0,
    };
  }));
  for (const r of results) if (r.status === 'fulfilled' && r.value) opps.push(r.value);
  return opps;
}

interface PriceResult { price: number; dex: string }

async function getBestPrice(chainKey: string, provider: ethers.JsonRpcProvider, tokenA: string, tokenB: string): Promise<PriceResult[]> {
  const chain = CHAINS[chainKey];
  const tA = chain.tokens[tokenA], tB = chain.tokens[tokenB];
  if (!tA || !tB) return [];
  const amountIn = ethers.parseUnits('1', tA.decimals);
  const results = await Promise.allSettled(
    chain.dexes.map(async (dex) => {
      const price = await getPriceFromDex(provider, dex, tA, tB, amountIn);
      return { price, dex: dex.name };
    })
  );
  const prices: PriceResult[] = [];
  for (const r of results) if (r.status === 'fulfilled' && r.value.price > 0) prices.push(r.value);
  return prices.sort((a, b) => b.price - a.price);
}

async function getPriceFromDex(provider: ethers.JsonRpcProvider, dex: DexConfig, tokenIn: TokenConfig, tokenOut: TokenConfig, amountIn: bigint): Promise<number> {
  try {
    if (!dex.factory) return 0;
    const factory = new ethers.Contract(dex.factory, V2_FACTORY_ABI, provider);
    const pairAddress = await factory.getPair(tokenIn.address, tokenOut.address);
    if (pairAddress === ethers.ZeroAddress) return 0;
    const pair = new ethers.Contract(pairAddress, V2_PAIR_ABI, provider);
    const [reserve0, reserve1] = await pair.getReserves();
    const token0: string = await pair.token0();
    let reserveIn: bigint, reserveOut: bigint;
    if (token0.toLowerCase() === tokenIn.address.toLowerCase()) { reserveIn = reserve0; reserveOut = reserve1; }
    else { reserveIn = reserve1; reserveOut = reserve0; }
    if (reserveIn <= 0n || reserveOut <= 0n) return 0;
    const amountOut = (amountIn * reserveOut) / (reserveIn + amountIn);
    return parseFloat(ethers.formatUnits(amountOut, tokenOut.decimals));
  } catch { return 0; }
}

async function fetchGasCost(chainKey: string, provider: ethers.JsonRpcProvider): Promise<number> {
  try {
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice || ethers.parseUnits('30', 'gwei');
    const gasCostNative = parseFloat(ethers.formatEther(gasPrice * 500000n));
    const chain = CHAINS[chainKey];
    const native = chain.tokens['WMATIC'] || chain.tokens['WETH'] || chain.tokens['OP'];
    if (!native) return 0.5;
    const prices = await getBestPrice(chainKey, provider, native.symbol, 'USDC');
    if (!prices.length) return 0.5;
    return gasCostNative * prices[0].price;
  } catch { return 0.5; }
}


