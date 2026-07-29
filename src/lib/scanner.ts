import { ethers } from 'ethers';
import { CHAINS, CHAIN_KEYS, TOKEN_PAIRS, V3_FEES, getTokenAddress } from './chains';

export interface PoolPrice {
  tokenIn: string;
  tokenOut: string;
  dex: string;
  fee: number;
  price: number;
  liquidity: number;
}

export interface ArbitrageOpportunity {
  id: string;
  chain: string;
  tokenPath: string[];
  dexPath: string[];
  flashLoanAsset: string;
  flashLoanAmount: number;
  estimatedProfit: number;
  estimatedGasCost: number;
  netProfit: number;
  profitMarginPct: number;
  confidenceScore: number;
  blockNumber: number;
  priceImpact: number;
  buyDex: string;
  sellDex: string;
  spreadPct: number;
}

export interface ScanResult {
  chain: string;
  blockNumber: number;
  opportunities: ArbitrageOpportunity[];
  scanTimeMs: number;
  poolPrices: PoolPrice[];
  tokenPrices: Record<string, number>;
  error?: string;
}

const V3_QUOTER_ABI = [
  {
    inputs: [
      { name: 'tokenIn', type: 'address' },
      { name: 'tokenOut', type: 'address' },
      { name: 'fee', type: 'uint24' },
      { name: 'amountIn', type: 'uint256' },
      { name: 'sqrtPriceLimitX96', type: 'uint160' },
    ],
    name: 'quoteExactInputSingle',
    outputs: [{ name: 'amountOut', type: 'uint256' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
];

const V2_ROUTER_ABI = [
  {
    inputs: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'amountOutMin', type: 'uint256' },
      { name: 'path', type: 'address[]' },
    ],
    name: 'getAmountsOut',
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
    stateMutability: 'view',
    type: 'function',
  },
];

const ERC20_DECIMALS_ABI = [
  { inputs: [], name: 'decimals', outputs: [{ name: '', type: 'uint8' }], stateMutability: 'view', type: 'function' },
];

const DEX_NAMES_V2 = ['sushi', 'quickswap'];
const SAMPLE_AMOUNT_USD = 1000;
const FLASH_LOAN_USD = 50000;
const RPC_TIMEOUT_MS = 10000;

function isZero(addr: string): boolean {
  return !addr || addr === '0x0000000000000000000000000000000000000000';
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

function getProvider(chainKey: string): ethers.JsonRpcProvider {
  const chain = CHAINS[chainKey];
  return new ethers.JsonRpcProvider(chain.rpcUrl, {
    chainId: chain.chainId,
    name: chain.name,
    ensAddress: undefined,
  }, { staticNetwork: true, batchStallTime: 0 });
}

async function getDecimals(provider: ethers.JsonRpcProvider, addr: string): Promise<number> {
  if (isZero(addr)) return 18;
  try {
    const c = new ethers.Contract(addr, ERC20_DECIMALS_ABI, provider);
    return Number(await withTimeout(c.decimals(), RPC_TIMEOUT_MS));
  } catch { return 18; }
}

async function v3Quote(provider: ethers.JsonRpcProvider, chainKey: string, tokenIn: string, tokenOut: string, fee: number, amountIn: bigint): Promise<bigint | null> {
  const chain = CHAINS[chainKey];
  if (isZero(chain.uniswapV3Quoter)) return null;
  try {
    const q = new ethers.Contract(chain.uniswapV3Quoter, V3_QUOTER_ABI, provider);
    const out = await withTimeout(q.quoteExactInputSingle.staticCall(tokenIn, tokenOut, fee, amountIn, 0n), RPC_TIMEOUT_MS);
    return out as bigint;
  } catch { return null; }
}

async function v2Quote(provider: ethers.JsonRpcProvider, routerAddr: string, tokenIn: string, tokenOut: string, amountIn: bigint): Promise<bigint | null> {
  if (isZero(routerAddr)) return null;
  try {
    const r = new ethers.Contract(routerAddr, V2_ROUTER_ABI, provider);
    const amounts = await withTimeout(r.getAmountsOut(amountIn, [tokenIn, tokenOut]), RPC_TIMEOUT_MS);
    return amounts[1] as bigint;
  } catch { return null; }
}

async function getGasCostUsd(provider: ethers.JsonRpcProvider, chainKey: string): Promise<number> {
  try {
    const feeData = await withTimeout(provider.getFeeData(), RPC_TIMEOUT_MS);
    const gasPrice = feeData.gasPrice || 0n;
    const nativeUsd = await getNativePriceUsd(provider, chainKey);
    const gasWei = gasPrice * 450000n;
    return Number(ethers.formatEther(gasWei)) * nativeUsd;
  } catch { return 0.5; }
}

async function getNativePriceUsd(provider: ethers.JsonRpcProvider, chainKey: string): Promise<number> {
  const chain = CHAINS[chainKey];
  const weth = chain.wethAddress;
  const usdc = chain.usdcAddress;
  if (isZero(weth) || isZero(usdc)) return 1;
  try {
    const sample = ethers.parseUnits('1', 6);
    for (const fee of V3_FEES) {
      const out = await v3Quote(provider, chainKey, usdc, weth, fee, sample);
      if (out && out > 0n) {
        const dec = await getDecimals(provider, weth);
        const wethPerUsdc = Number(ethers.formatUnits(out, dec));
        return wethPerUsdc > 0 ? 1 / wethPerUsdc : 1;
      }
    }
  } catch { /* fall through */ }
  return 1;
}

async function derivePriceUsd(provider: ethers.JsonRpcProvider, chainKey: string, sym: string, addr: string, dec: number): Promise<number> {
  if (sym === 'USDC' || sym === 'USDT' || sym === 'DAI') return 1;
  const chain = CHAINS[chainKey];
  if (isZero(addr) || isZero(chain.usdcAddress)) return 0;
  try {
    const sample = ethers.parseUnits('1', dec);
    for (const fee of V3_FEES) {
      const out = await v3Quote(provider, chainKey, addr, chain.usdcAddress, fee, sample);
      if (out && out > 0n) return Number(ethers.formatUnits(out, 6));
    }
  } catch { /* fall through */ }
  return 0;
}

async function scanChain(chainKey: string): Promise<ScanResult> {
  const start = Date.now();
  const provider = getProvider(chainKey);
  let blockNumber = 0;
  try {
    blockNumber = await withTimeout(provider.getBlockNumber(), RPC_TIMEOUT_MS);
  } catch { /* continue even if block fetch fails */ }

  const prices: PoolPrice[] = [];
  const tokenPrices: Record<string, number> = {};
  const decimals: Record<string, number> = {};

  for (const sym of ['WETH', 'USDC', 'USDT', 'DAI', 'WBTC']) {
    const addr = getTokenAddress(chainKey, sym);
    if (isZero(addr)) continue;
    const dec = await getDecimals(provider, addr);
    decimals[sym] = dec;
    tokenPrices[sym] = await derivePriceUsd(provider, chainKey, sym, addr, dec);
  }

  const gasCostUsd = await getGasCostUsd(provider, chainKey);

  for (const [tIn, tOut] of TOKEN_PAIRS) {
    const addrIn = getTokenAddress(chainKey, tIn);
    const addrOut = getTokenAddress(chainKey, tOut);
    if (isZero(addrIn) || isZero(addrOut)) continue;

    const decIn = decimals[tIn] || 18;
    const decOut = decimals[tOut] || 18;
    const priceIn = tokenPrices[tIn] || 0;
    const priceOut = tokenPrices[tOut] || 0;
    if (priceIn <= 0) continue;

    const sampleAmt = ethers.parseUnits((SAMPLE_AMOUNT_USD / priceIn).toFixed(Math.min(decIn, 6)), decIn);

    for (const fee of V3_FEES) {
      const out = await v3Quote(provider, chainKey, addrIn, addrOut, fee, sampleAmt);
      if (out && out > 0n) {
        const outUsd = Number(ethers.formatUnits(out, decOut)) * priceOut;
        prices.push({ tokenIn: tIn, tokenOut: tOut, dex: 'uniswap_v3', fee, price: outUsd / SAMPLE_AMOUNT_USD, liquidity: Number(ethers.formatUnits(out, decOut)) });
      }
    }

    for (const dex of DEX_NAMES_V2) {
      const router = dex === 'sushi' ? CHAINS[chainKey].sushiRouter : CHAINS[chainKey].quickswapRouter;
      const out = await v2Quote(provider, router, addrIn, addrOut, sampleAmt);
      if (out && out > 0n) {
        const outUsd = Number(ethers.formatUnits(out, decOut)) * priceOut;
        prices.push({ tokenIn: tIn, tokenOut: tOut, dex, fee: 3000, price: outUsd / SAMPLE_AMOUNT_USD, liquidity: Number(ethers.formatUnits(out, decOut)) });
      }
    }
  }

  const opps = findOpps(chainKey, blockNumber, prices, gasCostUsd, tokenPrices);
  return { chain: chainKey, blockNumber, opportunities: opps, scanTimeMs: Date.now() - start, poolPrices: prices, tokenPrices };
}

function findOpps(chainKey: string, blockNumber: number, prices: PoolPrice[], gasCostUsd: number, tokenPrices: Record<string, number>): ArbitrageOpportunity[] {
  const opps: ArbitrageOpportunity[] = [];

  for (const [tIn, tOut] of TOKEN_PAIRS) {
    const matching = prices.filter(p => p.tokenIn === tIn && p.tokenOut === tOut);
    if (matching.length < 2) continue;

    matching.sort((a, b) => b.price - a.price);
    const best = matching[0];
    const worst = matching[matching.length - 1];
    if (best.price <= 0 || worst.price <= 0) continue;

    const spreadPct = ((best.price - worst.price) / worst.price) * 100;
    if (spreadPct < 0.05) continue;

    const grossProfit = FLASH_LOAN_USD * (spreadPct / 100) * 0.5;
    const netProfit = grossProfit - gasCostUsd;
    if (netProfit <= 0.01) continue;

    const minLiq = Math.min(best.liquidity, worst.liquidity);
    const priceImpact = minLiq > 0 ? (FLASH_LOAN_USD / (minLiq * (tokenPrices[tIn] || 1))) * 100 : 0;
    const confidence = Math.min(0.95, 0.5 + Math.min(spreadPct / 3, 0.3) + Math.min(minLiq / 100000, 0.15));

    opps.push({
      id: `${chainKey}-${blockNumber}-${tIn}-${tOut}`,
      chain: chainKey,
      tokenPath: [tIn, tOut, tIn],
      dexPath: [best.dex, worst.dex],
      flashLoanAsset: getTokenAddress(chainKey, tIn),
      flashLoanAmount: FLASH_LOAN_USD,
      estimatedProfit: grossProfit,
      estimatedGasCost: gasCostUsd,
      netProfit,
      profitMarginPct: (netProfit / FLASH_LOAN_USD) * 100,
      confidenceScore: confidence,
      blockNumber,
      priceImpact: Math.min(priceImpact, 100),
      buyDex: worst.dex,
      sellDex: best.dex,
      spreadPct,
    });
  }

  return opps.sort((a, b) => b.netProfit - a.netProfit);
}

export async function scanAllChains(): Promise<ScanResult[]> {
  const results: ScanResult[] = [];
  for (const chainKey of CHAIN_KEYS) {
    try {
      results.push(await scanChain(chainKey));
    } catch (err: unknown) {
      results.push({ chain: chainKey, blockNumber: 0, opportunities: [], scanTimeMs: 0, poolPrices: [], tokenPrices: {}, error: String(err) });
    }
  }
  return results;
}
