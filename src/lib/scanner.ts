/**
 * Arbitrage scanner — simultaneously scans multiple DEXes across all chains
 * for price discrepancies. Supports triangular, two-DEX, and multi-hop paths.
 * Uses Balancer V2 (0% fee) and DODO V2 (0% fee) flash loan cost models.
 */

import { ethers } from 'ethers';
import {
  CHAINS, ChainConfig, TokenConfig, DexConfig,
  ERC20_ABI, V2_PAIR_ABI, V2_FACTORY_ABI,
  V3_QUOTER_ABI, V3_FACTORY_ABI, DODO_FACTORY_ABI,
  TRIANGULAR_PATHS, TWO_DEX_PAIRS, MULTI_HOP_PATHS,
} from './chains';

export type OpportunityType = 'two_dex' | 'triangular' | 'multi_hop' | 'pool_imbalance';

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
  flashProvider: 'balancer_v2' | 'dodo_v2';
}

export interface ScanResult {
  chain: string;
  blockNumber: number;
  opportunities: ArbitrageOpportunity[];
  scanTimeMs: number;
  error: string | null;
}

// ─── Price fetching helpers ───────────────────────────────────

async function getV2Reserves(
  provider: ethers.JsonRpcProvider,
  factoryAddress: string,
  tokenA: string,
  tokenB: string,
): Promise<{ reserves: [bigint, bigint]; token0: string } | null> {
  try {
    const factory = new ethers.Contract(factoryAddress, V2_FACTORY_ABI, provider);
    const pairAddress = await factory.getPair(tokenA, tokenB);
    if (pairAddress === ethers.ZeroAddress) return null;

    const pair = new ethers.Contract(pairAddress, V2_PAIR_ABI, provider);
    const [reserves, token0] = await Promise.all([
      pair.getReserves(),
      pair.token0(),
    ]);

    return {
      reserves: [reserves[0], reserves[1]],
      token0,
    };
  } catch {
    return null;
  }
}

async function getV3Quote(
  provider: ethers.JsonRpcProvider,
  quoterAddress: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  fee: number,
): Promise<bigint | null> {
  try {
    const quoter = new ethers.Contract(quoterAddress, V3_QUOTER_ABI, provider);
    const amountOut = await quoter.quoteExactInputSingle.staticCall(
      tokenIn, tokenOut, amountIn, fee, 0,
    );
    return amountOut;
  } catch {
    return null;
  }
}

interface BestPriceResult {
  amountOut: bigint;
  dexName: string;
  dexType: string;
  poolAddress: string;
  fee?: number;
}

async function getBestPrice(
  provider: ethers.JsonRpcProvider,
  chain: ChainConfig,
  tokenIn: TokenConfig,
  tokenOut: TokenConfig,
  amountIn: bigint,
): Promise<BestPriceResult | null> {
  let bestResult: BestPriceResult | null = null;

  const tasks: Promise<BestPriceResult | null>[] = [];

  for (const dex of chain.dexes) {
    if (dex.type === 'uniswap_v2' || dex.type === 'algebra') {
      tasks.push((async () => {
        const result = await getV2Reserves(provider, dex.factory, tokenIn.address, tokenOut.address);
        if (!result) return null;
        const [reserveIn, reserveOut] = result.token0 === tokenIn.address
          ? [result.reserves[0], result.reserves[1]]
          : [result.reserves[1], result.reserves[0]];
        if (reserveIn === 0n || reserveOut === 0n) return null;
        const amountInWithFee = amountIn * 997n;
        const amountOut = (amountInWithFee * reserveOut) / (reserveIn * 1000n + amountInWithFee);
        return { amountOut, dexName: dex.name, dexType: dex.type, poolAddress: dex.factory };
      })());
    } else if (dex.type === 'uniswap_v3' && dex.quoter && dex.feeTiers) {
      for (const fee of dex.feeTiers) {
        tasks.push((async () => {
          const quote = await getV3Quote(provider, dex.quoter, tokenIn.address, tokenOut.address, amountIn, fee);
          if (!quote || quote === 0n) return null;
          return { amountOut: quote, dexName: `${dex.name}`, dexType: dex.type, poolAddress: dex.quoter!, fee };
        })());
      }
    }
  }

  const results = await Promise.allSettled(tasks);
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) {
      if (!bestResult || result.value.amountOut > bestResult.amountOut) {
        bestResult = result.value;
      }
    }
  }

  return bestResult;
}

// ─── Gas cost estimation ──────────────────────────────────────

async function fetchGasCostUsd(provider: ethers.JsonRpcProvider, chainKey: string): Promise<number> {
  try {
    const chain = CHAINS[chainKey];
    const gasUnits = 350000n;
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice || ethers.parseUnits('30', 'gwei');
    const gasCostWei = gasUnits * gasPrice;

    const wrappedNative = chain.tokens.WETH || chain.tokens.WMATIC;
    const usdc = chain.tokens.USDC;
    if (!wrappedNative || !usdc) return 0.01;

    const nativePriceUsd = await getNativeTokenPriceUsd(provider, chain, wrappedNative, usdc);
    const gasCostEth = parseFloat(ethers.formatEther(gasCostWei));
    return gasCostEth * nativePriceUsd;
  } catch {
    return 0.01;
  }
}

async function getNativeTokenPriceUsd(
  provider: ethers.JsonRpcProvider,
  chain: ChainConfig,
  wrappedNative: TokenConfig,
  usdc: TokenConfig,
): Promise<number> {
  try {
    for (const dex of chain.dexes) {
      if (dex.type === 'uniswap_v2' || dex.type === 'algebra') {
        const result = await getV2Reserves(provider, dex.factory, wrappedNative.address, usdc.address);
        if (result && result.reserves[0] > 0n && result.reserves[1] > 0n) {
          const wnativeReserve = parseFloat(ethers.formatUnits(
            result.token0 === wrappedNative.address ? result.reserves[0] : result.reserves[1],
            wrappedNative.decimals,
          ));
          const usdcReserve = parseFloat(ethers.formatUnits(
            result.token0 === usdc.address ? result.reserves[0] : result.reserves[1],
            usdc.decimals,
          ));
          if (wnativeReserve > 0) return usdcReserve / wnativeReserve;
        }
      }
    }
    for (const dex of chain.dexes) {
      if (dex.type === 'uniswap_v3' && dex.quoter && dex.feeTiers) {
        for (const fee of dex.feeTiers) {
          const quote = await getV3Quote(provider, dex.quoter, wrappedNative.address, usdc.address,
            ethers.parseUnits('1', wrappedNative.decimals), fee);
          if (quote && quote > 0n) {
            return parseFloat(ethers.formatUnits(quote, usdc.decimals));
          }
        }
      }
    }
  } catch {
    // ignore
  }
  return 0;
}

// ─── DODO pool lookup ─────────────────────────────────────────

async function findDodoPool(
  provider: ethers.JsonRpcProvider,
  chain: ChainConfig,
  tokenA: string,
  tokenB: string,
): Promise<string | null> {
  try {
    const factory = new ethers.Contract(chain.dvmFactory, DODO_FACTORY_ABI, provider);
    const pool = await factory.getDVM(tokenA, tokenB).catch(() => ethers.ZeroAddress);
    if (pool !== ethers.ZeroAddress) return pool;
    const pool2 = await factory.getDVM(tokenB, tokenA).catch(() => ethers.ZeroAddress);
    if (pool2 !== ethers.ZeroAddress) return pool2;
    return null;
  } catch {
    return null;
  }
}

// ─── Scanning: Two-DEX arbitrage ───────────────────────────────

async function scanTwoDexArb(
  provider: ethers.JsonRpcProvider,
  chain: ChainConfig,
  chainKey: string,
  blockNumber: number,
): Promise<ArbitrageOpportunity[]> {
  const opportunities: ArbitrageOpportunity[] = [];
  const pairs = TWO_DEX_PAIRS[chainKey] || [];

  const flashAmountUsd = 5000;

  const tasks = pairs.map(async ([symA, symB]) => {
    const tokenA = chain.tokens[symA];
    const tokenB = chain.tokens[symB];
    if (!tokenA || !tokenB) return null;

    const amountIn = ethers.parseUnits(
      (flashAmountUsd / 1000).toFixed(6),
      Math.min(tokenA.decimals, 18),
    );

    const prices = await Promise.all(
      chain.dexes.map(async (dex) => {
        const result = await getBestPrice(provider, chain, tokenA, tokenB, amountIn);
        return result ? { ...result, dex } : null;
      }),
    );

    const validPrices = prices.filter((p): p is NonNullable<typeof p> => p !== null);
    if (validPrices.length < 2) return null;

    const sorted = validPrices.sort((a, b) => Number(b.amountOut - a.amountOut));
    const best = sorted[0];
    const worst = sorted[sorted.length - 1];

    if (best.amountOut <= worst.amountOut) return null;

    const reverseResult = await getBestPrice(provider, chain, tokenB, tokenA, best.amountOut);
    if (!reverseResult) return null;

    const finalAmount = reverseResult.amountOut;
    if (finalAmount <= amountIn) return null;

    const profit = finalAmount - amountIn;
    const profitUsd = parseFloat(ethers.formatUnits(profit, tokenA.decimals));
    const gasCostUsd = await fetchGasCostUsd(provider, chainKey);
    const netProfit = profitUsd - gasCostUsd;
    const margin = (netProfit / flashAmountUsd) * 100;

    if (netProfit > 0.01) {
      const dodoPool = await findDodoPool(provider, chain, tokenA.address, tokenB.address);
      const flashProvider: 'balancer_v2' | 'dodo_v2' = dodoPool ? 'dodo_v2' : 'balancer_v2';

      return {
        chain: chainKey,
        opportunityType: 'two_dex' as OpportunityType,
        tokenPath: [symA, symB, symA],
        tokenAddresses: [tokenA.address, tokenB.address],
        dexPath: [best.dexName, reverseResult.dexName],
        poolAddresses: [best.poolAddress, reverseResult.poolAddress],
        flashLoanAsset: tokenA.address,
        flashLoanAmount: flashAmountUsd,
        estimatedProfit: profitUsd,
        estimatedGasCost: gasCostUsd,
        netProfit,
        profitMarginPct: margin,
        confidenceScore: Math.min(0.95, 0.6 + margin / 10),
        blockNumber,
        flashProvider,
      } satisfies ArbitrageOpportunity;
    }
    return null;
  });

  const results = await Promise.allSettled(tasks);
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) {
      opportunities.push(result.value);
    }
  }

  return opportunities;
}

// ─── Scanning: Triangular arbitrage ────────────────────────────

async function scanTriangularArb(
  provider: ethers.JsonRpcProvider,
  chain: ChainConfig,
  chainKey: string,
  blockNumber: number,
): Promise<ArbitrageOpportunity[]> {
  const opportunities: ArbitrageOpportunity[] = [];
  const paths = TRIANGULAR_PATHS[chainKey] || [];
  const flashAmountUsd = 5000;

  const tasks = paths.map(async ([symA, symB, symC]) => {
    const tokenA = chain.tokens[symA];
    const tokenB = chain.tokens[symB];
    const tokenC = chain.tokens[symC];
    if (!tokenA || !tokenB || !tokenC) return null;

    const amountIn = ethers.parseUnits(
      (flashAmountUsd / 1000).toFixed(6),
      Math.min(tokenA.decimals, 18),
    );

    const [step1, step2, step3] = await Promise.all([
      getBestPrice(provider, chain, tokenA, tokenB, amountIn),
      getBestPrice(provider, chain, tokenB, tokenC, 0n),
      getBestPrice(provider, chain, tokenC, tokenA, 0n),
    ]);

    if (!step1 || !step2 || !step3) return null;

    const step2Result = await getBestPrice(provider, chain, tokenB, tokenC, step1.amountOut);
    if (!step2Result) return null;
    const step3Result = await getBestPrice(provider, chain, tokenC, tokenA, step2Result.amountOut);
    if (!step3Result) return null;

    const finalAmount = step3Result.amountOut;
    if (finalAmount <= amountIn) return null;

    const profit = finalAmount - amountIn;
    const profitUsd = parseFloat(ethers.formatUnits(profit, tokenA.decimals));
    const gasCostUsd = (await fetchGasCostUsd(provider, chainKey)) * 1.5;
    const netProfit = profitUsd - gasCostUsd;
    const margin = (netProfit / flashAmountUsd) * 100;

    if (netProfit > 0.01) {
      const dodoPool = await findDodoPool(provider, chain, tokenA.address, tokenB.address);
      const flashProvider: 'balancer_v2' | 'dodo_v2' = dodoPool ? 'dodo_v2' : 'balancer_v2';

      return {
        chain: chainKey,
        opportunityType: 'triangular' as OpportunityType,
        tokenPath: [symA, symB, symC, symA],
        tokenAddresses: [tokenA.address, tokenB.address, tokenC.address],
        dexPath: [step1.dexName, step2Result.dexName, step3Result.dexName],
        poolAddresses: [step1.poolAddress, step2Result.poolAddress, step3Result.poolAddress],
        flashLoanAsset: tokenA.address,
        flashLoanAmount: flashAmountUsd,
        estimatedProfit: profitUsd,
        estimatedGasCost: gasCostUsd,
        netProfit,
        profitMarginPct: margin,
        confidenceScore: Math.min(0.9, 0.5 + margin / 12),
        blockNumber,
        flashProvider,
      } satisfies ArbitrageOpportunity;
    }
    return null;
  });

  const results = await Promise.allSettled(tasks);
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) {
      opportunities.push(result.value);
    }
  }

  return opportunities;
}

// ─── Scanning: Multi-hop arbitrage (4+ hops) ───────────────────

async function scanMultiHopArb(
  provider: ethers.JsonRpcProvider,
  chain: ChainConfig,
  chainKey: string,
  blockNumber: number,
): Promise<ArbitrageOpportunity[]> {
  const opportunities: ArbitrageOpportunity[] = [];
  const paths = MULTI_HOP_PATHS[chainKey] || [];
  const flashAmountUsd = 5000;

  const tasks = paths.map(async (path) => {
    if (path.length < 4) return null;
    const tokens = path.map(k => chain.tokens[k]).filter(Boolean) as TokenConfig[];
    if (tokens.length !== path.length) return null;

    const startToken = tokens[0];
    const startAmount = ethers.parseUnits(
      (flashAmountUsd / 1000).toFixed(6),
      Math.min(startToken.decimals, 18),
    );

    let currentAmount = startAmount;
    let currentToken = startToken;
    const dexPath: string[] = [];
    const poolAddresses: string[] = [];

    for (let i = 0; i < tokens.length - 1; i++) {
      const nextToken = tokens[i + 1];
      const step = await getBestPrice(provider, chain, currentToken, nextToken, currentAmount);
      if (!step || step.amountOut <= 0n) return null;
      dexPath.push(step.dexName);
      poolAddresses.push(step.poolAddress);
      currentAmount = step.amountOut;
      currentToken = nextToken;
    }

    const finalStep = await getBestPrice(provider, chain, currentToken, startToken, currentAmount);
    if (!finalStep || finalStep.amountOut <= 0n) return null;
    dexPath.push(finalStep.dexName);
    poolAddresses.push(finalStep.poolAddress);
    currentAmount = finalStep.amountOut;

    if (currentAmount <= startAmount) return null;

    const profit = currentAmount - startAmount;
    const profitUsd = parseFloat(ethers.formatUnits(profit, startToken.decimals));
    const gasCostUsd = (await fetchGasCostUsd(provider, chainKey)) * 2;
    const netProfit = profitUsd - gasCostUsd;
    const margin = (netProfit / flashAmountUsd) * 100;

    if (netProfit > 0.01) {
      const dodoPool = await findDodoPool(provider, chain, startToken.address, tokens[1].address);
      const flashProvider: 'balancer_v2' | 'dodo_v2' = dodoPool ? 'dodo_v2' : 'balancer_v2';

      return {
        chain: chainKey,
        opportunityType: 'multi_hop' as OpportunityType,
        tokenPath: [...path, path[0]],
        tokenAddresses: tokens.map(t => t.address),
        dexPath,
        poolAddresses,
        flashLoanAsset: startToken.address,
        flashLoanAmount: flashAmountUsd,
        estimatedProfit: profitUsd,
        estimatedGasCost: gasCostUsd,
        netProfit,
        profitMarginPct: margin,
        confidenceScore: Math.min(0.85, 0.55 + margin / 12),
        blockNumber,
        flashProvider,
      } satisfies ArbitrageOpportunity;
    }
    return null;
  });

  const results = await Promise.allSettled(tasks);
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) {
      opportunities.push(result.value);
    }
  }

  return opportunities;
}

// ─── Main scan function ────────────────────────────────────────

export async function scanChain(chainKey: string): Promise<ScanResult> {
  const startTime = Date.now();
  const chain = CHAINS[chainKey];
  if (!chain) {
    return { chain: chainKey, blockNumber: 0, opportunities: [], scanTimeMs: 0, error: 'Unknown chain' };
  }

  try {
    const provider = new ethers.JsonRpcProvider(chain.rpc[0]);
    const blockNumber = await provider.getBlockNumber();

    const [twoDex, triangular, multiHop] = await Promise.all([
      scanTwoDexArb(provider, chain, chainKey, blockNumber),
      scanTriangularArb(provider, chain, chainKey, blockNumber),
      scanMultiHopArb(provider, chain, chainKey, blockNumber),
    ]);

    const allOpportunities = [...twoDex, ...triangular, ...multiHop]
      .sort((a, b) => b.netProfit - a.netProfit);

    return {
      chain: chainKey,
      blockNumber,
      opportunities: allOpportunities,
      scanTimeMs: Date.now() - startTime,
      error: null,
    };
  } catch (err: any) {
    return {
      chain: chainKey,
      blockNumber: 0,
      opportunities: [],
      scanTimeMs: Date.now() - startTime,
      error: err.message,
    };
  }
}

export async function scanAllChains(): Promise<ScanResult[]> {
  const results = await Promise.all(CHAIN_KEYS.map(key => scanChain(key)));
  return results;
}
