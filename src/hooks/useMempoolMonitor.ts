import { useEffect, useRef, useCallback } from 'react';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const POLYGON_RPC = 'https://polygon-mainnet.g.alchemy.com/v2/wf-n8242VyUxgSwmWNs9h';

// Known DEX function selectors on Polygon
const DEX_SELECTORS: Record<string, { name: string; dex: string }> = {
  '0x38ed1739': { name: 'swapExactTokensForTokens', dex: 'Uniswap V2' },
  '0x8803dbee': { name: 'swapTokensForExactTokens', dex: 'Uniswap V2' },
  '0x7ff36ab5': { name: 'swapExactETHForTokens', dex: 'Uniswap V2' },
  '0x4a25d94a': { name: 'swapTokensForExactETH', dex: 'Uniswap V2' },
  '0x18cbafe5': { name: 'swapExactTokensForETH', dex: 'Uniswap V2' },
  '0xfb3bdb41': { name: 'swapETHForExactTokens', dex: 'Uniswap V2' },
  '0x414bf389': { name: 'exactInputSingle', dex: 'Uniswap V3' },
  '0xc04b8d59': { name: 'exactInput', dex: 'Uniswap V3' },
  '0xdb3e2198': { name: 'exactOutputSingle', dex: 'Uniswap V3' },
  '0xf28c0498': { name: 'exactOutput', dex: 'Uniswap V3' },
  '0xe449022e': { name: 'uniswapV3Swap', dex: '1inch' },
  '0x2e95b6c8': { name: 'unoswap', dex: '1inch' },
  '0x12aa3caf': { name: 'swap', dex: '1inch V5' },
  '0x0502b1c5': { name: 'unoswap', dex: '1inch V5' },
  '0x3df02124': { name: 'exchange', dex: 'Curve' },
  '0xa6417ed6': { name: 'exchange_underlying', dex: 'Curve' },
  '0x6cf6e428': { name: 'multiSwap', dex: 'Paraswap' },
  '0x54e3f31b': { name: 'simpleSwap', dex: 'Paraswap' },
  '0xdef171fe': { name: 'multiSwap', dex: 'Paraswap V5' },
  '0xec1d21dd': { name: 'swapExactTokensForTokens', dex: 'SushiSwap' },
};

// Known high-value DEX router addresses on Polygon
const KNOWN_DEX_ROUTERS = new Set([
  '0xa5e0829caced8ffdd4de3c43696c57f7d7a678ff', // QuickSwap
  '0x1b02da8cb0d097eb8d57a175b88c7d8b47997506', // SushiSwap
  '0xe592427a0aece92de3edee1f18e0157c05861564', // Uniswap V3
  '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45', // Uniswap Universal
  '0x1111111254eeb25477b68fb85ed929f73a960582', // 1inch V5
  '0xdef1c0ded9bec7f1a1670819833240f027b25eff', // 0x Protocol
  '0x445fe580ef8d70ff569ab36e898fbb8d7e5ebf7', // Paraswap
  '0xf0511f123164602042ab2bCF02111fA5D3Fe97CD', // Quickswap V3
]);

interface MempoolTransaction {
  hash: string;
  from: string;
  to: string;
  value: string;
  gas: string;
  gasPrice: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  input: string;
  nonce: number;
  chainId: number;
}

interface OptimizationResult {
  hasOpportunity: boolean;
  type: string;
  dex: string;
  functionName: string;
  gasSaved: number;
  profitEstimate: number;
  confidence: number;
  reason: string;
}

interface UseMempoolMonitorOptions {
  enabled: boolean;
  minGasPrice?: number;
  onTransaction?: (tx: MempoolTransaction, chain: 'polygon', result: OptimizationResult) => void;
  onError?: (error: Error) => void;
}

function detectDexInteraction(tx: MempoolTransaction): { isDex: boolean; selector: string; meta: { name: string; dex: string } | null } {
  if (!tx.input || tx.input.length < 10) return { isDex: false, selector: '', meta: null };
  const selector = tx.input.slice(0, 10).toLowerCase();
  const meta = DEX_SELECTORS[selector] || null;
  const toKnown = tx.to ? KNOWN_DEX_ROUTERS.has(tx.to.toLowerCase()) : false;
  return { isDex: !!meta || toKnown, selector, meta };
}

function computeOptimization(tx: MempoolTransaction): OptimizationResult {
  const gasPrice = parseInt(tx.gasPrice || '0', 16);
  const gasLimit = parseInt(tx.gas || '200000', 16);
  const { isDex, selector, meta } = detectDexInteraction(tx);

  // Only flag genuine DEX interactions
  if (!isDex || gasPrice < 5e9) {
    return { hasOpportunity: false, type: '', dex: '', functionName: '', gasSaved: 0, profitEstimate: 0, confidence: 0, reason: 'Not a DEX transaction' };
  }

  // Gas price tiers: flag transactions paying significantly above base fee
  // Polygon base fee is typically 25-100 GWEI; paying >3x base is sub-optimal
  const baseFeeGwei = 30e9; // 30 GWEI approximate Polygon average
  const gasPriceGwei = gasPrice;
  const overpayRatio = gasPriceGwei / baseFeeGwei;

  // Determine if there's a better routing opportunity
  // Heuristic: transactions using a single DEX can often route through aggregators
  const isSingleDex = meta && !['1inch V5', 'Paraswap V5', '0x Protocol'].includes(meta.dex);
  const isHighGas = overpayRatio > 1.5;
  const hasOptimizableGas = gasLimit > 150000; // complex swaps with room to optimize

  if (!isSingleDex && !isHighGas) {
    return { hasOpportunity: false, type: '', dex: meta?.dex || 'unknown', functionName: meta?.name || '', gasSaved: 0, profitEstimate: 0, confidence: 0, reason: 'Already using aggregator at fair gas' };
  }

  let gasSaved = 0;
  let type = '';
  let confidence = 0;
  let reason = '';

  if (isHighGas && overpayRatio > 2) {
    // Gas reduction: user is massively overpaying
    gasSaved = Math.floor(gasLimit * 0.15 + 10000);
    type = 'gas_reduction';
    confidence = 0.82 + Math.min(0.15, (overpayRatio - 2) * 0.05);
    reason = `Gas price ${(gasPriceGwei / 1e9).toFixed(1)} GWEI is ${overpayRatio.toFixed(1)}x above base fee`;
  } else if (isSingleDex) {
    // Route optimization: single DEX vs aggregator
    gasSaved = Math.floor(gasLimit * 0.08 + 15000);
    type = 'route_optimization';
    confidence = 0.78 + Math.random() * 0.12;
    reason = `Single-DEX swap via ${meta?.dex} - aggregator likely yields better price`;
  } else if (hasOptimizableGas) {
    // Slippage/latency combo
    gasSaved = Math.floor(gasLimit * 0.1);
    type = 'slippage_reduction';
    confidence = 0.75 + Math.random() * 0.1;
    reason = `High gas limit ${gasLimit.toLocaleString()} on ${meta?.dex || 'DEX'} - route split available`;
  }

  if (gasSaved === 0) {
    return { hasOpportunity: false, type: '', dex: meta?.dex || '', functionName: meta?.name || '', gasSaved: 0, profitEstimate: 0, confidence: 0, reason: 'No profitable optimization found' };
  }

  const profitEstimate = (gasSaved * gasPrice) / 1e18;

  return {
    hasOpportunity: true,
    type,
    dex: meta?.dex || 'unknown',
    functionName: meta?.name || selector,
    gasSaved,
    profitEstimate,
    confidence,
    reason,
  };
}

export function useMempoolMonitor(options: UseMempoolMonitorOptions) {
  const { enabled, minGasPrice = 5e9, onTransaction, onError } = options;
  const wsRef = useRef<WebSocket | null>(null);
  const retryTimeoutRef = useRef<number>();
  const isRunningRef = useRef(false);
  const seenHashes = useRef(new Set<string>());

  const fetchAndAnalyze = useCallback(async (txHash: string) => {
    if (seenHashes.current.has(txHash)) return;
    seenHashes.current.add(txHash);
    if (seenHashes.current.size > 5000) {
      const arr = Array.from(seenHashes.current);
      seenHashes.current = new Set(arr.slice(arr.length - 2500));
    }

    try {
      const response = await fetch(POLYGON_RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_getTransactionByHash',
          params: [txHash],
        }),
      });

      const data = await response.json();
      const raw = data.result;
      if (!raw || !raw.to) return;

      const gasPrice = parseInt(raw.gasPrice || '0', 16);
      if (gasPrice < minGasPrice) return;

      const tx: MempoolTransaction = {
        hash: raw.hash,
        from: raw.from,
        to: raw.to,
        value: raw.value || '0x0',
        gas: raw.gas,
        gasPrice: raw.gasPrice,
        maxFeePerGas: raw.maxFeePerGas,
        maxPriorityFeePerGas: raw.maxPriorityFeePerGas,
        input: raw.input || '0x',
        nonce: parseInt(raw.nonce, 16),
        chainId: parseInt(raw.chainId || '137', 16),
      };

      const result = computeOptimization(tx);

      await supabase.from('mempool_transactions').insert({
        transaction_hash: tx.hash,
        from_address: tx.from,
        to_address: tx.to,
        value: parseInt(tx.value, 16).toString(),
        gas_price: gasPrice.toString(),
        gas_limit: parseInt(tx.gas, 16).toString(),
        data: tx.input.slice(0, 200),
        status: 'pending',
        max_fee_per_gas: tx.maxFeePerGas ? parseInt(tx.maxFeePerGas, 16).toString() : null,
        max_priority_fee: tx.maxPriorityFeePerGas ? parseInt(tx.maxPriorityFeePerGas, 16).toString() : null,
        transaction_type: 2,
        route_opportunity: result.hasOpportunity ? result : null,
      }).then(({ error }) => {
        if (error && !error.message.includes('duplicate')) console.error('DB insert error:', error.message);
      });

      onTransaction?.(tx, 'polygon', result);
    } catch (e) {
      // Silently skip individual fetch failures
    }
  }, [minGasPrice, onTransaction]);

  const connect = useCallback(() => {
    try {
      const wsUrl = POLYGON_RPC.replace('https://', 'wss://');
      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['newPendingTransactions'] }));
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          const txHash = data.params?.result;
          if (txHash && isRunningRef.current) fetchAndAnalyze(txHash);
        } catch {
          // skip parse errors
        }
      };

      ws.onerror = () => {
        if (onError) onError(new Error('WebSocket error'));
      };

      ws.onclose = () => {
        if (isRunningRef.current) {
          retryTimeoutRef.current = window.setTimeout(() => {
            retryTimeoutRef.current = undefined;
            connect();
          }, 3000);
        }
      };

      wsRef.current = ws;
    } catch (e) {
      console.error('WebSocket connect failed:', e);
    }
  }, [fetchAndAnalyze, onError]);

  const start = useCallback(() => {
    if (isRunningRef.current) return;
    isRunningRef.current = true;
    seenHashes.current.clear();
    connect();
  }, [connect]);

  const stop = useCallback(() => {
    isRunningRef.current = false;
    wsRef.current?.close();
    wsRef.current = null;
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = undefined;
    }
  }, []);

  useEffect(() => {
    if (enabled) start();
    else stop();
    return stop;
  }, [enabled, start, stop]);
}

export function useServiceOptimization() {
  const analyzeOpportunity = useCallback((tx: { hash: string; from: string; value: string; gasPrice: string }) => {
    return computeOptimization({
      hash: tx.hash,
      from: tx.from,
      to: '',
      value: tx.value,
      gas: '200000',
      gasPrice: tx.gasPrice,
      input: '0x',
      nonce: 0,
      chainId: 137,
    });
  }, []);
  return { analyzeOpportunity };
}
