/**
 * Arbitrage Scanner
 *
 * Queries real DEX pools on Polygon, Arbitrum, and Optimism to find
 * profitable arbitrage opportunities:
 * - Two-DEX arbitrage: same token pair on different DEXes
 * - Triangular arbitrage: A -> B -> C -> A
 * - Multi-hop: longer routes across DEXes
 * - Pool imbalance: pools with skewed reserves that create price opportunities
 *
 * All prices are fetched from real on-chain pools via RPC calls.
 * No mock data.
 */

import { ethers } from 'ethers';
import {
  CHAINS, ChainConfig, DexConfig, TokenConfig,
  ERC20_ABI, V2_PAIR_ABI, V2_FACTORY_ABI,
  V3_QUOTER_ABI, V3_FACTORY_ABI, V3_POOL_ABI,
  TRIANGULAR_PATHS, TWO_DEX_PAIRS, MULTI_HOP_PATHS,
} from './chains';

export interface ArbitrageOpportunity {
  chain: string;
  opportunityType: 'two_dex' | 'triangular' | 'multi_hop' | 'pool_imbalance';
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
  poolReserves: Record<string, string[]>;
  priceImpact: number;
  confidenceScore: number;
  blockNumber: number;
}

export interface ScanResult {
  chain: string;
  opportunities: ArbitrageOpportunity[];
  blockNumber: number;
  scanDurationMs: number;
  rpcLatencyMs: number;
  error: string | null;
}

// Get a provider with fallback RPCs
async function getProvider(chain: ChainConfig): Promise<{ provider: ethers.JsonRpcProvider; latency: number } | null> {
  for (const rpc of chain.rpc) {
    const start = Date.now();
    try {
      const provider = new ethers.JsonRpcProvider(rpc);
      // Quick test
      const block = await provider.getBlockNumber();
      const latency = Date.now() - start;
      if (block > 0) return { provider, latency };
    } catch {
      continue;
    }
  }
  return null;
}

// Get V2 pair reserves
async function getV2Reserves(
  provider: ethers.JsonRpcProvider,
  factoryAddress: string,
  tokenA: string,
  tokenB: string
): Promise<{ reserves: [bigint, bigint]; pairAddress: string; token0: string } | null> {
  try {
    const factory = new ethers.Contract(factoryAddress, V2_FACTORY_ABI, provider);
    const pairAddress = await factory.getPair(tokenA, tokenB);
    if (pairAddress === ethers.ZeroAddress) return null;

    const pair = new ethers.Contract(pairAddress, V2_PAIR_ABI, provider);
    const [reserve0, reserve1] = await pair.getReserves();
    const token0 = await pair.token0();

    // Order reserves by our token order
    const reserves: [bigint, bigint] = token0.toLowerCase() === tokenA.toLowerCase()
      ? [reserve0, reserve1]
      : [reserve1, reserve0];

    return { reserves, pairAddress, token0 };
  } catch {
    return null;
  }
}

// Get V3 quote (amount out for amount in)
async function getV3Quote(
  provider: ethers.JsonRpcProvider,
  quoterAddress: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  fee: number
): Promise<{ amountOut: bigint; poolAddress: string } | null> {
  try {
    const quoter = new ethers.Contract(quoterAddress, V3_QUOTER_ABI, provider);
    const amountOut = await quoter.quoteExactInputSingle.staticCall(tokenIn, tokenOut, amountIn, fee, 0);
    return { amountOut, poolAddress: ethers.ZeroAddress };
  } catch {
    return null;
  }
}

// Get V3 pool address
async function getV3Pool(
  provider: ethers.JsonRpcProvider,
  factoryAddress: string,
  tokenA: string,
  tokenB: string,
  fee: number
): Promise<string | null> {
  try {
    const factory = new ethers.Contract(factoryAddress, V3_FACTORY_ABI, provider);
    const pool = await factory.getPool(tokenA, tokenB, fee);
    if (pool === ethers.ZeroAddress) return null;
    return pool;
  } catch {
    return null;
  }
}

// Calculate V2 amount out given reserves
function getV2AmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, feeBps: number = 30): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const amountInWithFee = amountIn * BigInt(10000 - feeBps);
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn * BigInt(10000) + amountInWithFee;
  return numerator / denominator;
}

// Calculate V2 amount in given desired amount out
function getV2AmountIn(amountOut: bigint, reserveIn: bigint, reserveOut: bigint, feeBps: number = 30): bigint {
  if (amountOut <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const numerator = reserveIn * amountOut * BigInt(10000);
  const denominator = (reserveOut - amountOut) * BigInt(10000 - feeBps);
  return numerator / denominator + 1n;
}

// Get the best price for a token pair across all DEXes on a chain
async function getBestPrice(
  provider: ethers.JsonRpcProvider,
  chain: ChainConfig,
  tokenIn: TokenConfig,
  tokenOut: TokenConfig,
  amountIn: bigint
): Promise<{ dexName: string; amountOut: bigint; poolAddress: string; dexType: string } | null> {
  let best: { dexName: string; amountOut: bigint; poolAddress: string; dexType: string } | null = null;

  for (const dex of chain.dexes) {
    try {
      if (dex.type === 'uniswap_v2' || dex.type === 'algebra') {
        const result = await getV2Reserves(provider, dex.factory, tokenIn.address, tokenOut.address);
        if (result) {
          const amountOut = getV2AmountOut(amountIn, result.reserves[0], result.reserves[1]);
          if (!best || amountOut > best.amountOut) {
            best = { dexName: dex.name, amountOut, poolAddress: result.pairAddress, dexType: dex.type };
          }
        }
      } else if (dex.type === 'uniswap_v3' && dex.quoter && dex.feeTiers) {
        for (const fee of dex.feeTiers) {
          const quote = await getV3Quote(provider, dex.quoter, tokenIn.address, tokenOut.address, amountIn, fee);
          if (quote && quote.amountOut > 0n) {
            if (!best || quote.amountOut > best.amountOut) {
              best = { dexName: `${dex.name} (${fee/10000}%)`, amountOut: quote.amountOut, poolAddress: quote.poolAddress, dexType: dex.type };
            }
          }
        }
      }
    } catch {
      continue;
    }
  }

  return best;
}

// Scan for two-DEX arbitrage (same pair, different DEXes)
async function scanTwoDexArb(
  provider: ethers.JsonRpcProvider,
  chain: ChainConfig,
  chainKey: string,
  blockNumber: number
): Promise<ArbitrageOpportunity[]> {
  const opportunities: ArbitrageOpportunity[] = [];
  const pairs = TWO_DEX_PAIRS[chainKey] || [];

  for (const [tokenAKey, tokenBKey] of pairs) {
    const tokenA = chain.tokens[tokenAKey];
    const tokenB = chain.tokens[tokenBKey];
    if (!tokenA || !tokenB) continue;

    // Use a reasonable flash loan amount (1000 units of the more stable token)
    const stableToken = tokenA.decimals >= tokenB.decimals ? tokenB : tokenA;
    const flashAmount = ethers.parseUnits('1000', stableToken.decimals);
    const flashAsset = stableToken.address;

    // Get prices on all DEXes
    const prices: { dex: string; amountOut: bigint; poolAddress: string; dexType: string; tokenIn: string; tokenOut: string }[] = [];

    for (const dex of chain.dexes) {
      try {
        if (dex.type === 'uniswap_v2' || dex.type === 'algebra') {
          const result = await getV2Reserves(provider, dex.factory, tokenA.address, tokenB.address);
          if (result && result.reserves[0] > 0n && result.reserves[1] > 0n) {
            const out1 = getV2AmountOut(flashAmount, result.reserves[0], result.reserves[1]);
            const result2 = await getV2Reserves(provider, dex.factory, tokenB.address, tokenA.address);
            if (result2) {
              const out2 = getV2AmountOut(out1, result2.reserves[0], result2.reserves[1]);
              prices.push({ dex: dex.name, amountOut: out2, poolAddress: result.pairAddress, dexType: dex.type, tokenIn: tokenA.address, tokenOut: tokenB.address });
            }
          }
        } else if (dex.type === 'uniswap_v3' && dex.quoter && dex.feeTiers) {
          for (const fee of dex.feeTiers) {
            const quote1 = await getV3Quote(provider, dex.quoter, tokenA.address, tokenB.address, flashAmount, fee);
            if (quote1 && quote1.amountOut > 0n) {
              const quote2 = await getV3Quote(provider, dex.quoter, tokenB.address, tokenA.address, quote1.amountOut, fee);
              if (quote2 && quote2.amountOut > 0n) {
                prices.push({
                  dex: `${dex.name} (${fee/10000}%)`,
                  amountOut: quote2.amountOut,
                  poolAddress: ethers.ZeroAddress,
                  dexType: dex.type,
                  tokenIn: tokenA.address,
                  tokenOut: tokenB.address,
                });
              }
            }
          }
        }
      } catch {
        continue;
      }
    }

    // Find the best buy DEX and best sell DEX
    if (prices.length >= 2) {
      // Sort by amount out (we want to buy low, sell high)
      // The amountOut here is the result of A -> B -> A, so higher is better
      // But we need to compare: buy B on DEX1, sell B on DEX2
      // Actually we need to compare the price of A->B on different DEXes

      // Let's get the A->B price on each DEX
      const buyPrices: { dex: string; bOut: bigint; poolAddress: string }[] = [];
      for (const dex of chain.dexes) {
        try {
          if (dex.type === 'uniswap_v2' || dex.type === 'algebra') {
            const result = await getV2Reserves(provider, dex.factory, tokenA.address, tokenB.address);
            if (result) {
              const bOut = getV2AmountOut(flashAmount, result.reserves[0], result.reserves[1]);
              if (bOut > 0n) buyPrices.push({ dex: dex.name, bOut, poolAddress: result.pairAddress });
            }
          } else if (dex.type === 'uniswap_v3' && dex.quoter && dex.feeTiers) {
            for (const fee of dex.feeTiers) {
              const quote = await getV3Quote(provider, dex.quoter, tokenA.address, tokenB.address, flashAmount, fee);
              if (quote && quote.amountOut > 0n) {
                buyPrices.push({ dex: `${dex.name} (${fee/10000}%)`, bOut: quote.amountOut, poolAddress: ethers.ZeroAddress });
              }
            }
          }
        } catch { continue; }
      }

      if (buyPrices.length >= 2) {
        // Sort by best buy price (most B out for A in)
        buyPrices.sort((a, b) => Number(b.bOut - a.bOut) > 0 ? -1 : 1);
        const bestBuy = buyPrices[0]; // Most B per A
        const bestSell = buyPrices[buyPrices.length - 1]; // Least B per A = buy B cheap here

        // Buy B on bestSell (cheapest), sell B on bestBuy (most expensive)
        const bAmount = bestSell.bOut; // B tokens we get from the cheaper DEX
        // Now sell B back to A on the expensive DEX
        // We need to get the B->A price on the bestBuy DEX
        let aBack: bigint = 0n;
        let sellPoolAddress = bestBuy.poolAddress;

        for (const dex of chain.dexes) {
          try {
            if (dex.type === 'uniswap_v2' || dex.type === 'algebra') {
              const result = await getV2Reserves(provider, dex.factory, tokenB.address, tokenA.address);
              if (result && dex.name === bestBuy.dex.split(' (')[0]) {
                aBack = getV2AmountOut(bAmount, result.reserves[0], result.reserves[1]);
                sellPoolAddress = result.pairAddress;
                break;
              }
            } else if (dex.type === 'uniswap_v3' && dex.quoter && dex.feeTiers) {
              const feeMatch = bestBuy.dex.match(/(\d+\.?\d*)%/);
              const fee = feeMatch ? parseFloat(feeMatch[1]) * 10000 : 3000;
              const quote = await getV3Quote(provider, dex.quoter, tokenB.address, tokenA.address, bAmount, fee);
              if (quote) {
                aBack = quote.amountOut;
                sellPoolAddress = ethers.ZeroAddress;
                break;
              }
            }
          } catch { continue; }
        }

        if (aBack > flashAmount) {
          const profit = aBack - flashAmount;
          const profitUsd = parseFloat(ethers.formatUnits(profit, stableToken.decimals));
          const flashAmountUsd = parseFloat(ethers.formatUnits(flashAmount, stableToken.decimals));
          const gasCostUsd = await fetchGasCostUsd(provider, chainKey);
          const netProfit = profitUsd - gasCostUsd; // Balancer V2: 0% flash loan fee
          const margin = (netProfit / flashAmountUsd) * 100;

          if (netProfit > 0.01) {
            opportunities.push({
              chain: chainKey,
              opportunityType: 'two_dex',
              tokenPath: [tokenAKey, tokenBKey, tokenAKey],
              tokenAddresses: [tokenA.address, tokenB.address],
              dexPath: [bestSell.dex, bestBuy.dex],
              poolAddresses: [bestSell.poolAddress, sellPoolAddress],
              flashLoanAsset: flashAsset,
              flashLoanAmount: flashAmountUsd,
              estimatedProfit: profitUsd,
              estimatedGasCost: gasCostUsd,
              netProfit,
              profitMarginPct: margin,
              poolReserves: {},
              priceImpact: 0,
              confidenceScore: Math.min(0.95, 0.7 + (margin / 10)),
              blockNumber,
            });
          }
        }
      }
    }
  }

  return opportunities;
}

// Scan for triangular arbitrage (A -> B -> C -> A)
async function scanTriangularArb(
  provider: ethers.JsonRpcProvider,
  chain: ChainConfig,
  chainKey: string,
  blockNumber: number
): Promise<ArbitrageOpportunity[]> {
  const opportunities: ArbitrageOpportunity[] = [];
  const paths = TRIANGULAR_PATHS[chainKey] || [];

  for (const [tokenAKey, tokenBKey, tokenCKey] of paths) {
    const tokenA = chain.tokens[tokenAKey];
    const tokenB = chain.tokens[tokenBKey];
    const tokenC = chain.tokens[tokenCKey];
    if (!tokenA || !tokenB || !tokenC) continue;

    // Start with 1000 units of token A
    const startAmount = ethers.parseUnits('1000', tokenA.decimals);
    let currentAmount = startAmount;
    let currentToken = tokenA;
    const dexPath: string[] = [];
    const poolAddresses: string[] = [];
    let profitable = true;

    // A -> B
    const step1 = await getBestPrice(provider, chain, tokenA, tokenB, currentAmount);
    if (!step1 || step1.amountOut <= 0n) { profitable = false; }
    else {
      dexPath.push(step1.dexName);
      poolAddresses.push(step1.poolAddress);
      currentAmount = step1.amountOut;
      currentToken = tokenB;
    }

    // B -> C
    if (profitable) {
      const step2 = await getBestPrice(provider, chain, tokenB, tokenC, currentAmount);
      if (!step2 || step2.amountOut <= 0n) { profitable = false; }
      else {
        dexPath.push(step2.dexName);
        poolAddresses.push(step2.poolAddress);
        currentAmount = step2.amountOut;
        currentToken = tokenC;
      }
    }

    // C -> A
    if (profitable) {
      const step3 = await getBestPrice(provider, chain, tokenC, tokenA, currentAmount);
      if (!step3 || step3.amountOut <= 0n) { profitable = false; }
      else {
        dexPath.push(step3.dexName);
        poolAddresses.push(step3.poolAddress);
        currentAmount = step3.amountOut;
      }
    }

    if (profitable && currentAmount > startAmount) {
      const profit = currentAmount - startAmount;
      const profitUsd = parseFloat(ethers.formatUnits(profit, tokenA.decimals));
      const flashAmountUsd = parseFloat(ethers.formatUnits(startAmount, tokenA.decimals));
      const gasCostUsd = (await fetchGasCostUsd(provider, chainKey)) * 1.5; // More complex route
      const netProfit = profitUsd - gasCostUsd; // Balancer V2: 0% flash loan fee
      const margin = (netProfit / flashAmountUsd) * 100;

      if (netProfit > 0.01) {
        opportunities.push({
          chain: chainKey,
          opportunityType: 'triangular',
          tokenPath: [tokenAKey, tokenBKey, tokenCKey, tokenAKey],
          tokenAddresses: [tokenA.address, tokenB.address, tokenC.address],
          dexPath,
          poolAddresses,
          flashLoanAsset: tokenA.address,
          flashLoanAmount: flashAmountUsd,
          estimatedProfit: profitUsd,
          estimatedGasCost: gasCostUsd,
          netProfit,
          profitMarginPct: margin,
          poolReserves: {},
          priceImpact: 0,
          confidenceScore: Math.min(0.92, 0.65 + (margin / 8)),
          blockNumber,
        });
      }
    }
  }

  return opportunities;
}

// Scan for pool imbalances (skewed reserves that create opportunities)
async function scanPoolImbalance(
  provider: ethers.JsonRpcProvider,
  chain: ChainConfig,
  chainKey: string,
  blockNumber: number
): Promise<ArbitrageOpportunity[]> {
  const opportunities: ArbitrageOpportunity[] = [];
  const pairs = TWO_DEX_PAIRS[chainKey] || [];

  for (const [tokenAKey, tokenBKey] of pairs) {
    const tokenA = chain.tokens[tokenAKey];
    const tokenB = chain.tokens[tokenBKey];
    if (!tokenA || !tokenB) continue;

    for (const dex of chain.dexes) {
      if (dex.type !== 'uniswap_v2' && dex.type !== 'algebra') continue;

      try {
        const result = await getV2Reserves(provider, dex.factory, tokenA.address, tokenB.address);
        if (!result) continue;

        const [reserveA, reserveB] = result.reserves;
        if (reserveA <= 0n || reserveB <= 0n) continue;

        // Normalize reserves to comparable units
        const reserveADecimals = parseFloat(ethers.formatUnits(reserveA, tokenA.decimals));
        const reserveBDecimals = parseFloat(ethers.formatUnits(reserveB, tokenB.decimals));

        if (reserveADecimals <= 0 || reserveBDecimals <= 0) continue;

        // Check for imbalance ratio
        const ratio = reserveADecimals / reserveBDecimals;

        // Compare with other DEXes to see if this pool's price is off
        for (const otherDex of chain.dexes) {
          if (otherDex.name === dex.name) continue;
          if (otherDex.type !== 'uniswap_v2' && otherDex.type !== 'algebra') continue;

          try {
            const otherResult = await getV2Reserves(provider, otherDex.factory, tokenA.address, tokenB.address);
            if (!otherResult) continue;

            const [otherReserveA, otherReserveB] = otherResult.reserves;
            if (otherReserveA <= 0n || otherReserveB <= 0n) continue;

            const otherRatio = parseFloat(ethers.formatUnits(otherReserveA, tokenA.decimals)) /
                               parseFloat(ethers.formatUnits(otherReserveB, tokenB.decimals));

            if (otherRatio <= 0) continue;

            // Price difference between the two pools
            const priceDiffPct = Math.abs((ratio - otherRatio) / otherRatio) * 100;

            if (priceDiffPct > 0.5) {
              // There's a meaningful price difference between pools
              const flashAmount = 500; // Conservative amount
              const flashAmountWei = ethers.parseUnits(flashAmount.toString(), tokenA.decimals);

              // Buy on the cheaper pool, sell on the expensive one
              const cheapDex = ratio < otherRatio ? dex : otherDex;
              const expensiveDex = ratio < otherRatio ? otherDex : dex;

              const buyResult = ratio < otherRatio ? result : otherResult;
              const sellResult = ratio < otherRatio ? otherResult : result;

              const bOut = getV2AmountOut(flashAmountWei, buyResult.reserves[0], buyResult.reserves[1]);
              const aBack = getV2AmountOut(bOut, sellResult.reserves[1], sellResult.reserves[0]);

              if (aBack > flashAmountWei) {
                const profit = aBack - flashAmountWei;
                const profitUsd = parseFloat(ethers.formatUnits(profit, tokenA.decimals));
                const gasCostUsd = await fetchGasCostUsd(provider, chainKey);
                const netProfit = profitUsd - gasCostUsd; // Balancer V2: 0% flash loan fee
                const margin = (netProfit / flashAmount) * 100;

                if (netProfit > 0.01) {
                  opportunities.push({
                    chain: chainKey,
                    opportunityType: 'pool_imbalance',
                    tokenPath: [tokenAKey, tokenBKey, tokenAKey],
                    tokenAddresses: [tokenA.address, tokenB.address],
                    dexPath: [cheapDex.name, expensiveDex.name],
                    poolAddresses: [cheapDex.name, expensiveDex.name],
                    flashLoanAsset: tokenA.address,
                    flashLoanAmount: flashAmount,
                    estimatedProfit: profitUsd,
                    estimatedGasCost: gasCostUsd,
                    netProfit,
                    profitMarginPct: margin,
                    poolReserves: {
                      [cheapDex.name]: [ethers.formatUnits(buyResult.reserves[0], tokenA.decimals), ethers.formatUnits(buyResult.reserves[1], tokenB.decimals)],
                      [expensiveDex.name]: [ethers.formatUnits(sellResult.reserves[0], tokenA.decimals), ethers.formatUnits(sellResult.reserves[1], tokenB.decimals)],
                    },
                    priceImpact: priceDiffPct,
                    confidenceScore: Math.min(0.88, 0.6 + (priceDiffPct / 20)),
                    blockNumber,
                  });
                }
              }
            }
          } catch { continue; }
        }
      } catch { continue; }
    }
  }

  return opportunities;
}

// Fetch real gas cost in USD for a chain using live fee data and DEX spot price
async function fetchGasCostUsd(provider: ethers.JsonRpcProvider, chainKey: string): Promise<number> {
  try {
    const chain = CHAINS[chainKey];
    const gasUnits = 350000n; // Estimated gas for flash loan execution
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice || ethers.parseUnits('30', 'gwei');
    const gasCostWei = gasUnits * gasPrice;

    // Get native token price from DEX (wrapped native / USDC pair)
    const wrappedNative = chain.tokens.WETH || chain.tokens.WMATIC;
    const usdc = chain.tokens.USDC;
    if (!wrappedNative || !usdc) return 0.01;

    const nativePriceUsd = await getNativeTokenPriceUsd(provider, chain, wrappedNative, usdc);
    const gasCostEth = parseFloat(ethers.formatEther(gasCostWei));
    return gasCostEth * nativePriceUsd;
  } catch {
    return 0.01; // Fallback
  }
}

// Get native token USD price from DEX spot price
async function getNativeTokenPriceUsd(
  provider: ethers.JsonRpcProvider,
  chain: ChainConfig,
  wrappedNative: TokenConfig,
  usdc: TokenConfig
): Promise<number> {
  try {
    // Try V2 pools first
    for (const dex of chain.dexes) {
      if (dex.type === 'uniswap_v2' || dex.type === 'algebra') {
        const result = await getV2Reserves(provider, dex.factory, wrappedNative.address, usdc.address);
        if (result && result.reserves[0] > 0n && result.reserves[1] > 0n) {
          const wnativeReserve = parseFloat(ethers.formatUnits(result.reserves[0], wrappedNative.decimals));
          const usdcReserve = parseFloat(ethers.formatUnits(result.reserves[1], usdc.decimals));
          if (wnativeReserve > 0) return usdcReserve / wnativeReserve;
        }
      }
    }
    // Try V3
    for (const dex of chain.dexes) {
      if (dex.type === 'uniswap_v3' && dex.quoter && dex.feeTiers) {
        for (const fee of dex.feeTiers) {
          const quote = await getV3Quote(provider, dex.quoter, wrappedNative.address, usdc.address, ethers.parseUnits('1', wrappedNative.decimals), fee);
          if (quote && quote.amountOut > 0n) {
            return parseFloat(ethers.formatUnits(quote.amountOut, usdc.decimals));
          }
        }
      }
    }
  } catch {
    // ignore
  }
  return 0;
}

// Scan for multi-hop arbitrage (4+ hops: A -> B -> C -> D -> A)
async function scanMultiHopArb(
  provider: ethers.JsonRpcProvider,
  chain: ChainConfig,
  chainKey: string,
  blockNumber: number
): Promise<ArbitrageOpportunity[]> {
  const opportunities: ArbitrageOpportunity[] = [];
  const paths = MULTI_HOP_PATHS[chainKey] || [];

  for (const path of paths) {
    if (path.length < 4) continue;

    const tokens = path.map(k => chain.tokens[k]).filter(Boolean) as TokenConfig[];
    if (tokens.length !== path.length) continue;

    const startToken = tokens[0];
    const startAmount = ethers.parseUnits('1000', startToken.decimals);
    let currentAmount = startAmount;
    let currentToken = startToken;
    const dexPath: string[] = [];
    const poolAddresses: string[] = [];
    let profitable = true;

    for (let i = 0; i < tokens.length - 1; i++) {
      const nextToken = tokens[i + 1];
      const step = await getBestPrice(provider, chain, currentToken, nextToken, currentAmount);
      if (!step || step.amountOut <= 0n) { profitable = false; break; }
      dexPath.push(step.dexName);
      poolAddresses.push(step.poolAddress);
      currentAmount = step.amountOut;
      currentToken = nextToken;
    }

    // Final hop back to start token
    if (profitable) {
      const finalStep = await getBestPrice(provider, chain, currentToken, startToken, currentAmount);
      if (!finalStep || finalStep.amountOut <= 0n) { profitable = false; }
      else {
        dexPath.push(finalStep.dexName);
        poolAddresses.push(finalStep.poolAddress);
        currentAmount = finalStep.amountOut;
      }
    }

    if (profitable && currentAmount > startAmount) {
      const profit = currentAmount - startAmount;
      const profitUsd = parseFloat(ethers.formatUnits(profit, startToken.decimals));
      const flashAmountUsd = parseFloat(ethers.formatUnits(startAmount, startToken.decimals));
      const gasCostUsd = (await fetchGasCostUsd(provider, chainKey)) * 2; // More hops = more gas
      const netProfit = profitUsd - gasCostUsd; // Balancer V2: 0% flash loan fee
      const margin = (netProfit / flashAmountUsd) * 100;

      if (netProfit > 0.01) {
        opportunities.push({
          chain: chainKey,
          opportunityType: 'multi_hop',
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
          poolReserves: {},
          priceImpact: 0,
          confidenceScore: Math.min(0.85, 0.55 + (margin / 12)),
          blockNumber,
        });
      }
    }
  }

  return opportunities;
}

// Main scan function — scans a single chain for all opportunity types
export async function scanChain(chainKey: string): Promise<ScanResult> {
  const startTime = Date.now();
  const chain = CHAINS[chainKey];
  if (!chain) {
    return { chain: chainKey, opportunities: [], blockNumber: 0, scanDurationMs: 0, rpcLatencyMs: 0, error: 'Unknown chain' };
  }

  const providerResult = await getProvider(chain);
  if (!providerResult) {
    return { chain: chainKey, opportunities: [], blockNumber: 0, scanDurationMs: Date.now() - startTime, rpcLatencyMs: 0, error: 'All RPCs failed' };
  }

  const { provider, latency } = providerResult;
  const blockNumber = await provider.getBlockNumber();
  const allOpportunities: ArbitrageOpportunity[] = [];

  try {
    // Scan all four types in parallel
    const [twoDex, triangular, imbalance, multiHop] = await Promise.all([
      scanTwoDexArb(provider, chain, chainKey, blockNumber),
      scanTriangularArb(provider, chain, chainKey, blockNumber),
      scanPoolImbalance(provider, chain, chainKey, blockNumber),
      scanMultiHopArb(provider, chain, chainKey, blockNumber),
    ]);

    allOpportunities.push(...twoDex, ...triangular, ...imbalance, ...multiHop);

    // Sort by net profit descending
    allOpportunities.sort((a, b) => b.netProfit - a.netProfit);

    return {
      chain: chainKey,
      opportunities: allOpportunities,
      blockNumber,
      scanDurationMs: Date.now() - startTime,
      rpcLatencyMs: latency,
      error: null,
    };
  } catch (err: any) {
    return {
      chain: chainKey,
      opportunities: [],
      blockNumber,
      scanDurationMs: Date.now() - startTime,
      rpcLatencyMs: latency,
      error: err.message || 'Scan failed',
    };
  }
}

// Scan all enabled chains
export async function scanAllChains(enabledChains: string[]): Promise<ScanResult[]> {
  const results = await Promise.all(enabledChains.map(chain => scanChain(chain)));
  return results;
}
