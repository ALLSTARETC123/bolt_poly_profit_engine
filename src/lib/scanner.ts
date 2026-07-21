/**
 * Arbitrage scanner — simultaneously scans multiple DEXes across all chains.
 * Uses Balancer V2 (0% fee) and DODO V2 (0% fee) flash loan cost models.
 */

import { ethers } from 'ethers';
import {
  CHAINS, ChainConfig, TokenConfig,
  V2_PAIR_ABI, V2_FACTORY_ABI, V3_QUOTER_ABI, DODO_FACTORY_ABI,
  TRIANGULAR_PATHS, TWO_DEX_PAIRS, MULTI_HOP_PATHS,
} from './chains';

export type OpportunityType = 'two_dex' | 'triangular' | 'multi_hop';
export type FlashProvider = 'balancer_v2' | 'dodo_v2';

export interface ArbitrageOpportunity {
  chain: string;
  opportunityType: OpportunityType;
  tokenPath: string[];
  tokenAddresses: string[];
  dexPath: string[];
  poolAddresses: string[];
  flashLoanAsset: string;
  flashLoanAmount: number;
  estimatedProfit: number;
  estimatedGasCost: number;
  netProfit: number;
  profitMarginPct: number;
  confidenceScore: number;
  blockNumber: number;
  flashProvider: FlashProvider;
}

export interface ScanResult {
  chain: string;
  blockNumber: number;
  opportunities: ArbitrageOpportunity[];
  scanTimeMs: number;
  error: string | null;
}

async function getV2Reserves(provider: ethers.JsonRpcProvider, factoryAddress: string, tokenA: string, tokenB: string) {
  try {
    const factory = new ethers.Contract(factoryAddress, V2_FACTORY_ABI, provider);
    const pairAddress = await factory.getPair(tokenA, tokenB);
    if (pairAddress === ethers.ZeroAddress) return null;
    const pair = new ethers.Contract(pairAddress, V2_PAIR_ABI, provider);
    const [reserves, token0] = await Promise.all([pair.getReserves(), pair.token0()]);
    return { reserves: [reserves[0], reserves[1]] as [bigint, bigint], token0 };
  } catch { return null; }
}

async function getV3Quote(provider: ethers.JsonRpcProvider, quoterAddress: string, tokenIn: string, tokenOut: string, amountIn: bigint, fee: number) {
  try {
    const quoter = new ethers.Contract(quoterAddress, V3_QUOTER_ABI, provider);
    return await quoter.quoteExactInputSingle.staticCall(tokenIn, tokenOut, amountIn, fee, 0);
  } catch { return null; }
}

interface BestPriceResult { amountOut: bigint; dexName: string; poolAddress: string; }

async function getBestPrice(provider: ethers.JsonRpcProvider, chain: ChainConfig, tokenIn: TokenConfig, tokenOut: TokenConfig, amountIn: bigint): Promise<BestPriceResult | null> {
  let best: BestPriceResult | null = null;
  const tasks: Promise<BestPriceResult | null>[] = [];

  for (const dex of chain.dexes) {
    if (dex.type === 'uniswap_v2' || dex.type === 'algebra') {
      tasks.push((async () => {
        const result = await getV2Reserves(provider, dex.factory, tokenIn.address, tokenOut.address);
        if (!result) return null;
        const [reserveIn, reserveOut] = result.token0 === tokenIn.address ? [result.reserves[0], result.reserves[1]] : [result.reserves[1], result.reserves[0]];
        if (reserveIn === 0n || reserveOut === 0n) return null;
        const amountInWithFee = amountIn * 997n;
        const amountOut = (amountInWithFee * reserveOut) / (reserveIn * 1000n + amountInWithFee);
        return { amountOut, dexName: dex.name, poolAddress: dex.factory };
      })());
    } else if (dex.type === 'uniswap_v3' && dex.quoter && dex.feeTiers) {
      for (const fee of dex.feeTiers) {
        tasks.push((async () => {
          const quote = await getV3Quote(provider, dex.quoter!, tokenIn.address, tokenOut.address, amountIn, fee);
          if (!quote || quote === 0n) return null;
          return { amountOut: quote, dexName: dex.name, poolAddress: dex.quoter! };
        })());
      }
    }
  }

  const results = await Promise.allSettled(tasks);
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) {
      if (!best || result.value.amountOut > best.amountOut) best = result.value;
    }
  }
  return best;
}

async function fetchGasCostUsd(provider: ethers.JsonRpcProvider, chainKey: string): Promise<number> {
  try {
    const chain = CHAINS[chainKey];
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice || ethers.parseUnits('30', 'gwei');
    const gasCostWei = 350000n * gasPrice;
    const wrappedNative = chain.tokens.WETH || chain.tokens.WMATIC;
    const usdc = chain.tokens.USDC;
    if (!wrappedNative || !usdc) return 0.01;
    let nativePrice = 0;
    for (const dex of chain.dexes) {
      if (dex.type === 'uniswap_v2' || dex.type === 'algebra') {
        const r = await getV2Reserves(provider, dex.factory, wrappedNative.address, usdc.address);
        if (r && r.reserves[0] > 0n && r.reserves[1] > 0n) {
          const wReserve = parseFloat(ethers.formatUnits(r.token0 === wrappedNative.address ? r.reserves[0] : r.reserves[1], wrappedNative.decimals));
          const uReserve = parseFloat(ethers.formatUnits(r.token0 === usdc.address ? r.reserves[0] : r.reserves[1], usdc.decimals));
          if (wReserve > 0) { nativePrice = uReserve / wReserve; break; }
        }
      }
    }
    if (nativePrice === 0) return 0.01;
    return parseFloat(ethers.formatEther(gasCostWei)) * nativePrice;
  } catch { return 0.01; }
}

async function findDodoPool(provider: ethers.JsonRpcProvider, chain: ChainConfig, tokenA: string, tokenB: string): Promise<string | null> {
  try {
    const factory = new ethers.Contract(chain.dvmFactory, DODO_FACTORY_ABI, provider);
    const pool = await factory.getDVM(tokenA, tokenB).catch(() => ethers.ZeroAddress);
    if (pool !== ethers.ZeroAddress) return pool;
    const pool2 = await factory.getDVM(tokenB, tokenA).catch(() => ethers.ZeroAddress);
    return pool2 !== ethers.ZeroAddress ? pool2 : null;
  } catch { return null; }
}

async function scanTwoDexArb(provider: ethers.JsonRpcProvider, chain: ChainConfig, chainKey: string, blockNumber: number): Promise<ArbitrageOpportunity[]> {
  const opps: ArbitrageOpportunity[] = [];
  const flashAmountUsd = 5000;
  const pairs = TWO_DEX_PAIRS[chainKey] || [];

  const tasks = pairs.map(async ([symA, symB]) => {
    const tokenA = chain.tokens[symA]; const tokenB = chain.tokens[symB];
    if (!tokenA || !tokenB) return null;
    const amountIn = ethers.parseUnits((flashAmountUsd / 1000).toFixed(6), Math.min(tokenA.decimals, 18));
    const prices = await Promise.all(chain.dexes.map(async (dex) => {
      const r = await getBestPrice(provider, chain, tokenA, tokenB, amountIn);
      return r ? { ...r, dex } : null;
    }));
    const valid = prices.filter((p): p is NonNullable<typeof p> => p !== null);
    if (valid.length < 2) return null;
    const sorted = valid.sort((a, b) => Number(b.amountOut - a.amountOut));
    const best = sorted[0]; const worst = sorted[sorted.length - 1];
    if (best.amountOut <= worst.amountOut) return null;
    const reverse = await getBestPrice(provider, chain, tokenB, tokenA, best.amountOut);
    if (!reverse || reverse.amountOut <= amountIn) return null;
    const profit = reverse.amountOut - amountIn;
    const profitUsd = parseFloat(ethers.formatUnits(profit, tokenA.decimals));
    const gasCost = await fetchGasCostUsd(provider, chainKey);
    const netProfit = profitUsd - gasCost;
    if (netProfit <= 0.01) return null;
    const dodoPool = await findDodoPool(provider, chain, tokenA.address, tokenB.address);
    return {
      chain: chainKey, opportunityType: 'two_dex' as OpportunityType,
      tokenPath: [symA, symB, symA], tokenAddresses: [tokenA.address, tokenB.address],
      dexPath: [best.dexName, reverse.dexName], poolAddresses: [best.poolAddress, reverse.poolAddress],
      flashLoanAsset: tokenA.address, flashLoanAmount: flashAmountUsd,
      estimatedProfit: profitUsd, estimatedGasCost: gasCost, netProfit,
      profitMarginPct: (netProfit / flashAmountUsd) * 100,
      confidenceScore: Math.min(0.95, 0.6 + (netProfit / flashAmountUsd) * 10),
      blockNumber, flashProvider: (dodoPool ? 'dodo_v2' : 'balancer_v2') as FlashProvider,
    } satisfies ArbitrageOpportunity;
  });

  const results = await Promise.allSettled(tasks);
  for (const r of results) { if (r.status === 'fulfilled' && r.value) opps.push(r.value); }
  return opps;
}

async function scanTriangularArb(provider: ethers.JsonRpcProvider, chain: ChainConfig, chainKey: string, blockNumber: number): Promise<ArbitrageOpportunity[]> {
  const opps: ArbitrageOpportunity[] = [];
  const flashAmountUsd = 5000;
  const paths = TRIANGULAR_PATHS[chainKey] || [];

  const tasks = paths.map(async ([symA, symB, symC]) => {
    const tokenA = chain.tokens[symA]; const tokenB = chain.tokens[symB]; const tokenC = chain.tokens[symC];
    if (!tokenA || !tokenB || !tokenC) return null;
    const amountIn = ethers.parseUnits((flashAmountUsd / 1000).toFixed(6), Math.min(tokenA.decimals, 18));
    const step1 = await getBestPrice(provider, chain, tokenA, tokenB, amountIn);
    if (!step1) return null;
    const step2 = await getBestPrice(provider, chain, tokenB, tokenC, step1.amountOut);
    if (!step2) return null;
    const step3 = await getBestPrice(provider, chain, tokenC, tokenA, step2.amountOut);
    if (!step3 || step3.amountOut <= amountIn) return null;
    const profit = step3.amountOut - amountIn;
    const profitUsd = parseFloat(ethers.formatUnits(profit, tokenA.decimals));
    const gasCost = (await fetchGasCostUsd(provider, chainKey)) * 1.5;
    const netProfit = profitUsd - gasCost;
    if (netProfit <= 0.01) return null;
    const dodoPool = await findDodoPool(provider, chain, tokenA.address, tokenB.address);
    return {
      chain: chainKey, opportunityType: 'triangular' as OpportunityType,
      tokenPath: [symA, symB, symC, symA], tokenAddresses: [tokenA.address, tokenB.address, tokenC.address],
      dexPath: [step1.dexName, step2.dexName, step3.dexName],
      poolAddresses: [step1.poolAddress, step2.poolAddress, step3.poolAddress],
      flashLoanAsset: tokenA.address, flashLoanAmount: flashAmountUsd,
      estimatedProfit: profitUsd, estimatedGasCost: gasCost, netProfit,
      profitMarginPct: (netProfit / flashAmountUsd) * 100,
      confidenceScore: Math.min(0.9, 0.5 + (netProfit / flashAmountUsd) * 8),
      blockNumber, flashProvider: (dodoPool ? 'dodo_v2' : 'balancer_v2') as FlashProvider,
    } satisfies ArbitrageOpportunity;
  });

  const results = await Promise.allSettled(tasks);
  for (const r of results) { if (r.status === 'fulfilled' && r.value) opps.push(r.value); }
  return opps;
}

async function scanMultiHopArb(provider: ethers.JsonRpcProvider, chain: ChainConfig, chainKey: string, blockNumber: number): Promise<ArbitrageOpportunity[]> {
  const opps: ArbitrageOpportunity[] = [];
  const flashAmountUsd = 5000;
  const paths = MULTI_HOP_PATHS[chainKey] || [];

  const tasks = paths.map(async (path) => {
    if (path.length < 4) return null;
    const tokens = path.map(k => chain.tokens[k]).filter(Boolean) as TokenConfig[];
    if (tokens.length !== path.length) return null;
    const startToken = tokens[0];
    const startAmount = ethers.parseUnits((flashAmountUsd / 1000).toFixed(6), Math.min(startToken.decimals, 18));
    let currentAmount = startAmount; let currentToken = startToken;
    const dexPath: string[] = []; const poolAddresses: string[] = [];
    for (let i = 0; i < tokens.length - 1; i++) {
      const step = await getBestPrice(provider, chain, currentToken, tokens[i + 1], currentAmount);
      if (!step || step.amountOut <= 0n) return null;
      dexPath.push(step.dexName); poolAddresses.push(step.poolAddress);
      currentAmount = step.amountOut; currentToken = tokens[i + 1];
    }
    const finalStep = await getBestPrice(provider, chain, currentToken, startToken, currentAmount);
    if (!finalStep || finalStep.amountOut <= 0n) return null;
    dexPath.push(finalStep.dexName); poolAddresses.push(finalStep.poolAddress);
    currentAmount = finalStep.amountOut;
    if (currentAmount <= startAmount) return null;
    const profit = currentAmount - startAmount;
    const profitUsd = parseFloat(ethers.formatUnits(profit, startToken.decimals));
    const gasCost = (await fetchGasCostUsd(provider, chainKey)) * 2;
    const netProfit = profitUsd - gasCost;
    if (netProfit <= 0.01) return null;
    const dodoPool = await findDodoPool(provider, chain, startToken.address, tokens[1].address);
    return {
      chain: chainKey, opportunityType: 'multi_hop' as OpportunityType,
      tokenPath: [...path, path[0]], tokenAddresses: tokens.map(t => t.address),
      dexPath, poolAddresses, flashLoanAsset: startToken.address, flashLoanAmount: flashAmountUsd,
      estimatedProfit: profitUsd, estimatedGasCost: gasCost, netProfit,
      profitMarginPct: (netProfit / flashAmountUsd) * 100,
      confidenceScore: Math.min(0.85, 0.55 + (netProfit / flashAmountUsd) * 7),
      blockNumber, flashProvider: (dodoPool ? 'dodo_v2' : 'balancer_v2') as FlashProvider,
    } satisfies ArbitrageOpportunity;
  });

  const results = await Promise.allSettled(tasks);
  for (const r of results) { if (r.status === 'fulfilled' && r.value) opps.push(r.value); }
  return opps;
}

export async function scanChain(chainKey: string): Promise<ScanResult> {
  const startTime = Date.now();
  const chain = CHAINS[chainKey];
  if (!chain) return { chain: chainKey, blockNumber: 0, opportunities: [], scanTimeMs: 0, error: 'Unknown chain' };
  try {
    const provider = new ethers.JsonRpcProvider(chain.rpc[0]);
    const blockNumber = await provider.getBlockNumber();
    const [twoDex, triangular, multiHop] = await Promise.all([
      scanTwoDexArb(provider, chain, chainKey, blockNumber),
      scanTriangularArb(provider, chain, chainKey, blockNumber),
      scanMultiHopArb(provider, chain, chainKey, blockNumber),
    ]);
    return {
      chain: chainKey, blockNumber,
      opportunities: [...twoDex, ...triangular, ...multiHop].sort((a, b) => b.netProfit - a.netProfit),
      scanTimeMs: Date.now() - startTime, error: null,
    };
  } catch (err: any) {
    return { chain: chainKey, blockNumber: 0, opportunities: [], scanTimeMs: Date.now() - startTime, error: err.message };
  }
}

export async function scanAllChains(): Promise<ScanResult[]> {
  return Promise.all(CHAIN_KEYS.map(key => scanChain(key)));
}
