export interface PriceHistoryEntry {
  tokenPair: string;
  chain: string;
  dex: string;
  price: number;
  timestamp: number;
}

export interface ZScoreSignal {
  tokenPair: string;
  chain: string;
  currentSpread: number;
  meanSpread: number;
  stdDev: number;
  zScore: number;
  signalType: 'CONVERGENCE' | 'DIVERGENCE';
  confidence: number;
  expectedReversionTime: number;
  estimatedProfit: number;
  entryPrice: number;
  targetPrice: number;
  sampleSize: number;
}

export interface StatArbModel {
  pairKey: string;
  chain: string;
  spreads: number[];
  timestamps: number[];
  windowSize: number;
  minSamples: number;
  entryZThreshold: number;
  exitZThreshold: number;
  maxZScore: number;
}

const MAX_WINDOW = 200;
const MIN_SAMPLES = 20;
const ENTRY_Z = 2.0;
const EXIT_Z = 0.5;
const MAX_Z = 5.0;
const REVERSION_TIME_MS = 60000;

const models = new Map<string, StatArbModel>();

function getModelKey(chain: string, pair: string): string {
  return `${chain}:${pair}`;
}

export function recordSpread(chain: string, pair: string, spread: number): void {
  const key = getModelKey(chain, pair);
  let model = models.get(key);
  if (!model) {
    model = {
      pairKey: pair, chain,
      spreads: [], timestamps: [],
      windowSize: MAX_WINDOW, minSamples: MIN_SAMPLES,
      entryZThreshold: ENTRY_Z, exitZThreshold: EXIT_Z, maxZScore: MAX_Z,
    };
    models.set(key, model);
  }
  const now = Date.now();
  model.spreads.push(spread);
  model.timestamps.push(now);
  if (model.spreads.length > model.windowSize) {
    model.spreads.shift();
    model.timestamps.shift();
  }
}

export function getZScoreSignal(chain: string, pair: string): ZScoreSignal | null {
  const key = getModelKey(chain, pair);
  const model = models.get(key);
  if (!model || model.spreads.length < model.minSamples) return null;

  const spreads = model.spreads;
  const n = spreads.length;
  const mean = spreads.reduce((a, b) => a + b, 0) / n;
  const variance = spreads.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const stdDev = Math.sqrt(variance);
  if (stdDev < 1e-8) return null;

  const currentSpread = spreads[n - 1];
  const zScore = (currentSpread - mean) / stdDev;

  if (Math.abs(zScore) < model.entryZThreshold) return null;

  const signalType: 'CONVERGENCE' | 'DIVERGENCE' = zScore > 0 ? 'CONVERGENCE' : 'DIVERGENCE';
  const confidence = Math.min(0.95, Math.min(Math.abs(zScore) / model.maxZScore, 1) * 0.6 + 0.35);
  const targetPrice = mean;
  const entryPrice = currentSpread;
  const expectedMove = Math.abs(currentSpread - mean);
  const flashLoanAmount = 50000;
  const estimatedProfit = (expectedMove / 100) * flashLoanAmount * 0.5;

  return {
    tokenPair: pair, chain,
    currentSpread, meanSpread: mean, stdDev,
    zScore, signalType, confidence,
    expectedReversionTime: REVERSION_TIME_MS,
    estimatedProfit, entryPrice, targetPrice,
    sampleSize: n,
  };
}

export function getAllSignals(): ZScoreSignal[] {
  const signals: ZScoreSignal[] = [];
  for (const [key] of models) {
    const [chain, pair] = key.split(':');
    const sig = getZScoreSignal(chain, pair);
    if (sig) signals.push(sig);
  }
  return signals.sort((a, b) => Math.abs(b.zScore) - Math.abs(a.zScore));
}

export function getModelStats(): { pair: string; chain: string; samples: number; mean: number; stdDev: number; currentZ: number }[] {
  const stats: { pair: string; chain: string; samples: number; mean: number; stdDev: number; currentZ: number }[] = [];
  for (const [key, model] of models) {
    const n = model.spreads.length;
    if (n === 0) continue;
    const mean = model.spreads.reduce((a, b) => a + b, 0) / n;
    const variance = model.spreads.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
    const stdDev = Math.sqrt(variance);
    const currentZ = stdDev > 1e-8 ? (model.spreads[n - 1] - mean) / stdDev : 0;
    const [chain, pair] = key.split(':');
    stats.push({ pair, chain, samples: n, mean, stdDev, currentZ });
  }
  return stats.sort((a, b) => Math.abs(b.currentZ) - Math.abs(a.currentZ));
}

export function clearModels(): void {
  models.clear();
}

export function getModelCount(): number {
  return models.size;
}
