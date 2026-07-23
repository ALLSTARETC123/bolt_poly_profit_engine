import { CHAINS, CHAIN_KEYS } from './chains';

export interface ArbitrageOpportunity {
  chain: string;
  opportunityType: 'triangular' | 'cross-dex';
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
}

export interface ScanResult {
  chain: string;
  blockNumber: number;
  opportunities: ArbitrageOpportunity[];
  scanTimeMs: number;
  error?: string;
}

const DEX_NAMES = ['Uniswap V3', 'SushiSwap', 'QuickSwap', 'Balancer', 'Curve'];

function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

function generateOpportunities(chainKey: string, blockNumber: number): ArbitrageOpportunity[] {
  const chain = CHAINS[chainKey];
  const rng = seededRandom(blockNumber + chain.chainId);
  const count = Math.floor(rng() * 4);
  const opps: ArbitrageOpportunity[] = [];

  for (let i = 0; i < count; i++) {
    const isTriangular = rng() > 0.5;
    const flashAmount = 10000 + rng() * 90000;
    const grossProfit = flashAmount * (0.001 + rng() * 0.005);
    const gasCost = 0.5 + rng() * 2;
    const netProfit = grossProfit - gasCost;

    if (netProfit <= 0) continue;

    const tokens = isTriangular
      ? ['USDC', 'WETH', 'USDC']
      : ['USDC', 'WETH'];
    const dexes = tokens.slice(0, -1).map(() => DEX_NAMES[Math.floor(rng() * DEX_NAMES.length)]);

    opps.push({
      chain: chainKey,
      opportunityType: isTriangular ? 'triangular' : 'cross-dex',
      tokenPath: tokens,
      dexPath: dexes,
      flashLoanAsset: chain.usdcAddress,
      flashLoanAmount: flashAmount,
      estimatedProfit: grossProfit,
      estimatedGasCost: gasCost,
      netProfit,
      profitMarginPct: (netProfit / flashAmount) * 100,
      confidenceScore: 0.7 + rng() * 0.3,
      blockNumber,
    });
  }

  return opps.sort((a, b) => b.netProfit - a.netProfit);
}

export async function scanAllChains(): Promise<ScanResult[]> {
  const results: ScanResult[] = [];

  for (const chainKey of CHAIN_KEYS) {
    const start = Date.now();
    try {
      const blockNumber = Math.floor(Date.now() / 1000) + CHAINS[chainKey].chainId;
      const opportunities = generateOpportunities(chainKey, blockNumber);
      results.push({
        chain: chainKey,
        blockNumber,
        opportunities,
        scanTimeMs: Date.now() - start,
      });
    } catch (err: unknown) {
      results.push({
        chain: chainKey,
        blockNumber: 0,
        opportunities: [],
        scanTimeMs: Date.now() - start,
        error: String(err),
      });
    }
  }

  return results;
}
