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
  opportunityType: 'triangular' | 'cross-dex';
  tokenPath: string[];
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
  poolReserves: Record<string, string>;
  priceImpact: number;
  v3Fees: number[];
}

export interface ScanResult {
  chain: string;
  blockNumber: number;
  opportunities: ArbitrageOpportunity[];
  scanTimeMs: number;
  poolPrices: PoolPrice[];
  error?: string;
}

const V3_QUOTER_ABI = [
  {
    inputs: [
      { name: 'tokenIn', type: 'address' },
      { name: 'tokenOut', type: 'address' },
      { name: 'fee', type: 'uint24' },
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

const TOKEN_PRICE_USD: Record<string, number> = {
  WETH: 3200,
  USDC: 1,
  USDT: 1,
  DAI: 1,
  WBTC: 62000,
  WMATIC: 0.8,
};

function getProvider(chainKey: string): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(CHAINS[chainKey].rpcUrl);
}

async function getTokenDecimals(provider: ethers.JsonRpcProvider, tokenAddress: string): Promise<number> {
  if (tokenAddress === '0x0000000000000000000000000000000000000000') return 18;
  try {
    const contract = new ethers.Contract(tokenAddress, ERC20_DECIMALS_ABI, provider);
    const decimals = await contract.decimals();
    return Number(decimals);
  } catch {
    return 18;
  }
}

function usdToAmount(usd: number, decimals: number, priceUsd: number): bigint {
  const tokenAmount = usd / priceUsd;
  return ethers.parseUnits(tokenAmount.toFixed(Math.min(decimals, 6)), decimals);
}

function amountToUsd(amount: bigint, decimals: number, priceUsd: number): number {
  return Number(ethers.formatUnits(amount, decimals)) * priceUsd;
}

async function fetchV3Quote(
  provider: ethers.JsonRpcProvider,
  chainKey: string,
  tokenIn: string,
  tokenOut: string,
  fee: number,
  amountIn: bigint
): Promise<bigint | null> {
  const chain = CHAINS[chainKey];
  if (!chain.uniswapV3Quoter || chain.uniswapV3Quoter === '0x') return null;
  try {
    const quoter = new ethers.Contract(chain.uniswapV3Quoter, V3_QUOTER_ABI, provider);
    const amountOut = await quoter.quoteExactInputSingle.staticCall(tokenIn, tokenOut, fee, amountIn, 0);
    return amountOut as bigint;
  } catch {
    return null;
  }
}

async function fetchV2Quote(
  provider: ethers.JsonRpcProvider,
  routerAddress: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint
): Promise<bigint | null> {
  if (!routerAddress || routerAddress === '0x0000000000000000000000000000000000000000') return null;
  try {
    const router = new ethers.Contract(routerAddress, V2_ROUTER_ABI, provider);
    const amounts = await router.getAmountsOut(amountIn, [tokenIn, tokenOut]);
    return amounts[1] as bigint;
  } catch {
    return null;
  }
}

async function scanChainPrices(chainKey: string): Promise<{ prices: PoolPrice[]; blockNumber: number; scanTimeMs: number }> {
  const start = Date.now();
  const provider = getProvider(chainKey);
  const blockNumber = await provider.getBlockNumber();
  const prices: PoolPrice[] = [];

  for (const [tokenInSym, tokenOutSym] of TOKEN_PAIRS) {
    const tokenIn = getTokenAddress(chainKey, tokenInSym);
    const tokenOut = getTokenAddress(chainKey, tokenOutSym);
    if (!tokenIn || !tokenOut) continue;
    if (tokenIn === '0x0000000000000000000000000000000000000000') continue;
    if (tokenOut === '0x0000000000000000000000000000000000000000') continue;

    const decimalsIn = await getTokenDecimals(provider, tokenIn);
    const decimalsOut = await getTokenDecimals(provider, tokenOut);
    const priceInUsd = TOKEN_PRICE_USD[tokenInSym] || 1;
    const sampleAmount = usdToAmount(SAMPLE_AMOUNT_USD, decimalsIn, priceInUsd);

    for (const fee of V3_FEES) {
      const amountOut = await fetchV3Quote(provider, chainKey, tokenIn, tokenOut, fee, sampleAmount);
      if (amountOut && amountOut > 0n) {
        const outUsd = amountToUsd(amountOut, decimalsOut, TOKEN_PRICE_USD[tokenOutSym] || 1);
        const price = outUsd / SAMPLE_AMOUNT_USD;
        prices.push({ tokenIn: tokenInSym, tokenOut: tokenOutSym, dex: 'uniswap_v3', fee, price, liquidity: Number(ethers.formatUnits(amountOut, decimalsOut)) });
      }
    }

    for (const dexName of DEX_NAMES_V2) {
      const routerAddr = dexName === 'sushi' ? CHAINS[chainKey].sushiRouter : CHAINS[chainKey].quickswapRouter;
      const amountOut = await fetchV2Quote(provider, routerAddr, tokenIn, tokenOut, sampleAmount);
      if (amountOut && amountOut > 0n) {
        const outUsd = amountToUsd(amountOut, decimalsOut, TOKEN_PRICE_USD[tokenOutSym] || 1);
        const price = outUsd / SAMPLE_AMOUNT_USD;
        prices.push({ tokenIn: tokenInSym, tokenOut: tokenOutSym, dex: dexName, fee: 3000, price, liquidity: Number(ethers.formatUnits(amountOut, decimalsOut)) });
      }
    }
  }

  return { prices, blockNumber, scanTimeMs: Date.now() - start };
}

function findArbitrageOpportunities(chainKey: string, blockNumber: number, prices: PoolPrice[]): ArbitrageOpportunity[] {
  const opps: ArbitrageOpportunity[] = [];

  for (const [tokenInSym, tokenOutSym] of TOKEN_PAIRS) {
    const matching = prices.filter(p => p.tokenIn === tokenInSym && p.tokenOut === tokenOutSym);
    if (matching.length < 2) continue;

    matching.sort((a, b) => b.price - a.price);
    const best = matching[0];
    const worst = matching[matching.length - 1];
    if (best.price <= 0 || worst.price <= 0) continue;

    const spreadPct = ((best.price - worst.price) / worst.price) * 100;
    if (spreadPct < 0.05) continue;

    const flashAmount = Math.min(50000, Math.max(1000, SAMPLE_AMOUNT_USD * 100));
    const grossProfit = flashAmount * (spreadPct / 100) * 0.5;
    const gasCost = 0.3 + (chainKey === 'arbitrum' ? 0.1 : 0.5);
    const netProfit = grossProfit - gasCost;
    if (netProfit <= 0.01) continue;

    opps.push({
      id: `${chainKey}-${blockNumber}-xd-${tokenInSym}-${tokenOutSym}`,
      chain: chainKey,
      opportunityType: 'cross-dex',
      tokenPath: [tokenInSym, tokenOutSym, tokenInSym],
      dexPath: [best.dex, worst.dex],
      poolAddresses: [],
      flashLoanAsset: getTokenAddress(chainKey, tokenInSym),
      flashLoanAmount: flashAmount,
      estimatedProfit: grossProfit,
      estimatedGasCost: gasCost,
      netProfit,
      profitMarginPct: (netProfit / flashAmount) * 100,
      confidenceScore: Math.min(0.95, 0.65 + spreadPct / 5),
      blockNumber,
      poolReserves: {},
      priceImpact: spreadPct * 0.05,
      v3Fees: [best.fee, worst.fee],
    });
  }

  return opps.sort((a, b) => b.netProfit - a.netProfit);
}

export async function scanAllChains(): Promise<ScanResult[]> {
  const results: ScanResult[] = [];

  for (const chainKey of CHAIN_KEYS) {
    try {
      const { prices, blockNumber, scanTimeMs } = await scanChainPrices(chainKey);
      const opportunities = findArbitrageOpportunities(chainKey, blockNumber, prices);
      results.push({ chain: chainKey, blockNumber, opportunities, scanTimeMs, poolPrices: prices });
    } catch (err: unknown) {
      results.push({ chain: chainKey, blockNumber: 0, opportunities: [], scanTimeMs: 0, poolPrices: [], error: String(err) });
    }
  }

  return results;
}
