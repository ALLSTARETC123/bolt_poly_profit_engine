import { useEffect, useRef, useCallback, useState } from 'react';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Multiple RPC endpoints - public ones first, then API-key ones as backup
const RPC_ENDPOINTS = {
  // Public Polygon RPC endpoints (no API key needed)
  polygonPublic: 'https://polygon-rpc.com',
  polygonPublic2: 'https://rpc.ankr.com/polygon',
  polygonPublic3: 'https://polygon-mainnet.public.blastapi.io',
  // API-key endpoints (may be rate limited)
  infura: `https://polygon-mainnet.infura.io/v3/${import.meta.env.VITE_INFURA_KEY || '09760d45e6844c8b95cc8af069f96160'}`,
  alchemy: 'https://polygon-mainnet.g.alchemy.com/v2/wf-n8242VyUxgSwmWNs9h',
};

// WebSocket endpoints for real-time mempool
const WS_ENDPOINTS = {
  blast: 'wss://polygon-mainnet.public.blastapi.io/ws',
  ankr: 'wss://rpc.ankr.com/polygon/ws',
  infura: `wss://polygon-mainnet.infura.io/ws/v3/${import.meta.env.VITE_INFURA_KEY || '09760d45e6844c8b95cc8af069f96160'}`,
  alchemy: 'wss://polygon-mainnet.g.alchemy.com/v2/wf-n8242VyUxgSwmWNs9h',
};

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

const KNOWN_DEX_ROUTERS = new Set([
  '0xa5e0829caced8ffdd4de3c43696c57f7d7a678ff',
  '0x1b02da8cb0d097eb8d57a175b88c7d8b47997506',
  '0xe592427a0aece92de3edee1f18e0157c05861564',
  '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45',
  '0x1111111254eeb25477b68fb85ed929f73a960582',
  '0xdef1c0ded9bec7f1a1670819833240f027b25eff',
  '0x445fe580ef8d70ff569ab36e898fbb8d7e5ebf7',
  '0xf0511f123164602042ab2bCF02111fA5D3Fe97CD',
]);

export interface MempoolTransaction {
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

export interface OptimizationResult {
  hasOpportunity: boolean;
  type: string;
  dex: string;
  functionName: string;
  gasSaved: number;
  profitEstimate: number;
  confidence: number;
  reason: string;
}

export interface FeedStatus {
  primary: 'connecting' | 'connected' | 'disconnected' | 'polling';
  secondary: 'connecting' | 'connected' | 'disconnected';
  txPerMin: number;
  activeRpc: string;
}

interface UseMempoolMonitorOptions {
  enabled: boolean;
  minGasPrice?: number;
  onTransaction?: (tx: MempoolTransaction, chain: 'polygon', result: OptimizationResult) => void;
  onError?: (error: Error) => void;
}

function detectDexInteraction(tx: MempoolTransaction) {
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

  if (!isDex || gasPrice < 5e9) {
    return { hasOpportunity: false, type: '', dex: '', functionName: '', gasSaved: 0, profitEstimate: 0, confidence: 0, reason: 'Not a DEX transaction' };
  }

  const baseFeeGwei = 30e9;
  const overpayRatio = gasPrice / baseFeeGwei;
  const isSingleDex = meta && !['1inch V5', 'Paraswap V5', '0x Protocol'].includes(meta.dex);
  const isHighGas = overpayRatio > 1.5;
  const hasOptimizableGas = gasLimit > 150000;

  if (!isSingleDex && !isHighGas) {
    return { hasOpportunity: false, type: '', dex: meta?.dex || 'unknown', functionName: meta?.name || '', gasSaved: 0, profitEstimate: 0, confidence: 0, reason: 'Already using aggregator at fair gas' };
  }

  let gasSaved = 0, type = '', confidence = 0, reason = '';

  if (isHighGas && overpayRatio > 2) {
    gasSaved = Math.floor(gasLimit * 0.15 + 10000);
    type = 'gas_reduction';
    confidence = Math.min(0.97, 0.82 + (overpayRatio - 2) * 0.05);
    reason = `Gas ${(gasPrice / 1e9).toFixed(1)} GWEI is ${overpayRatio.toFixed(1)}x above base fee`;
  } else if (isSingleDex) {
    gasSaved = Math.floor(gasLimit * 0.08 + 15000);
    type = 'route_optimization';
    confidence = 0.78 + Math.random() * 0.12;
    reason = `Single-DEX swap via ${meta?.dex} — aggregator likely yields better price`;
  } else if (hasOptimizableGas) {
    gasSaved = Math.floor(gasLimit * 0.1);
    type = 'slippage_reduction';
    confidence = 0.75 + Math.random() * 0.1;
    reason = `Gas limit ${gasLimit.toLocaleString()} on ${meta?.dex || 'DEX'} — route split available`;
  }

  if (gasSaved === 0) {
    return { hasOpportunity: false, type: '', dex: meta?.dex || '', functionName: meta?.name || '', gasSaved: 0, profitEstimate: 0, confidence: 0, reason: 'No profitable optimization found' };
  }

  return {
    hasOpportunity: true,
    type,
    dex: meta?.dex || 'unknown',
    functionName: meta?.name || selector,
    gasSaved,
    profitEstimate: (gasSaved * gasPrice) / 1e18,
    confidence,
    reason,
  };
}

// Race all available RPCs to fetch tx details
async function fetchTxFromAny(txHash: string): Promise<any | null> {
  const payload = JSON.stringify({
    jsonrpc: '2.0', id: 1,
    method: 'eth_getTransactionByHash',
    params: [txHash],
  });

  const urls = [
    RPC_ENDPOINTS.polygonPublic,
    RPC_ENDPOINTS.polygonPublic2,
    RPC_ENDPOINTS.polygonPublic3,
    RPC_ENDPOINTS.infura,
    RPC_ENDPOINTS.alchemy,
  ];

  const fetchFrom = async (url: string) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        signal: controller.signal,
      });
      const d = await r.json();
      clearTimeout(timeout);
      if (!d.result) throw new Error('null result');
      return d.result;
    } catch {
      clearTimeout(timeout);
      throw new Error('fetch failed');
    }
  };

  // Try all endpoints in parallel, return first success
  for (const url of urls) {
    try {
      const result = await fetchFrom(url);
      return result;
    } catch {
      continue;
    }
  }
  return null;
}

// Poll for new blocks and their pending transactions
async function pollPendingTransactions(
  lastBlock: { number: number; hash: string },
  urls: string[]
): Promise<{ txHashes: string[]; latestBlock: { number: number; hash: string } }> {
  const payload = JSON.stringify({
    jsonrpc: '2.0', id: 1,
    method: 'eth_getBlockByNumber',
    params: ['pending', false],
  });

  for (const url of urls) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        signal: controller.signal,
      });
      const d = await r.json();
      clearTimeout(timeout);
      if (d.result?.transactions) {
        const txHashes = d.result.transactions.filter((h: string) => h.startsWith('0x'));
        const blockNum = parseInt(d.result.number || '0', 16);
        return { txHashes, latestBlock: { number: blockNum, hash: d.result.hash || '' } };
      }
    } catch {
      continue;
    }
  }
  return { txHashes: [], latestBlock: lastBlock };
}

export function useMempoolMonitor(options: UseMempoolMonitorOptions) {
  const { enabled, minGasPrice = 5e9, onTransaction, onError } = options;

  const primaryWs = useRef<WebSocket | null>(null);
  const secondaryWs = useRef<WebSocket | null>(null);
  const pollInterval = useRef<number>();
  const retryTimeout = useRef<number>();
  const isRunning = useRef(false);
  const seenHashes = useRef(new Set<string>());
  const txCountRef = useRef(0);
  const txCountWindowRef = useRef(0);

  const [feedStatus, setFeedStatus] = useState<FeedStatus>({
    primary: 'disconnected',
    secondary: 'disconnected',
    txPerMin: 0,
    activeRpc: 'none',
  });

  useEffect(() => {
    const interval = setInterval(() => {
      setFeedStatus(prev => ({ ...prev, txPerMin: txCountWindowRef.current }));
      txCountWindowRef.current = 0;
    }, 60000);
    return () => clearInterval(interval);
  }, []);

  const handleHash = useCallback(async (txHash: string, rpcUrl?: string) => {
    if (!isRunning.current) return;
    if (seenHashes.current.has(txHash)) return;
    seenHashes.current.add(txHash);
    txCountRef.current++;
    txCountWindowRef.current++;

    if (seenHashes.current.size > 8000) {
      const arr = Array.from(seenHashes.current);
      seenHashes.current = new Set(arr.slice(arr.length - 4000));
    }

    if (rpcUrl) {
      setFeedStatus(prev => ({ ...prev, activeRpc: rpcUrl }));
    }

    try {
      const raw = await fetchTxFromAny(txHash);
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

      supabase.from('mempool_transactions').insert({
        transaction_hash: tx.hash,
        from_address: tx.from,
        to_address: tx.to,
        value: parseInt(tx.value, 16).toString(),
        gas_price: gasPrice.toString(),
        gas_limit: parseInt(tx.gas, 16).toString(),
        data: tx.input.slice(0, 10),
        status: 'pending',
        max_fee_per_gas: tx.maxFeePerGas ? parseInt(tx.maxFeePerGas, 16).toString() : null,
        max_priority_fee: tx.maxPriorityFeePerGas ? parseInt(tx.maxPriorityFeePerGas, 16).toString() : null,
        transaction_type: 2,
        route_opportunity: result.hasOpportunity ? result : null,
      }).then(({ error }) => {
        if (error && !error.message.includes('duplicate')) {
          console.warn('DB insert:', error.message);
        }
      });

      onTransaction?.(tx, 'polygon', result);
    } catch {
      // individual fetch failures are silent
    }
  }, [minGasPrice, onTransaction]);

  const connectWebSocket = useCallback((
    name: 'primary' | 'secondary',
    wsUrl: string,
    key: string
  ) => {
    console.log(`[${name}] Attempting WebSocket: ${wsUrl.slice(0, 40)}...`);
    setFeedStatus(prev => ({ ...prev, [name]: 'connecting' }));

    try {
      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        console.log(`[${name}] WebSocket connected`);
        ws.send(JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'eth_subscribe',
          params: ['newPendingTransactions']
        }));
        setFeedStatus(prev => ({ ...prev, [name]: 'connected', activeRpc: key }));
      };

      ws.onmessage = (evt) => {
        try {
          const d = JSON.parse(evt.data);
          const hash = d.params?.result;
          if (hash && typeof hash === 'string' && hash.startsWith('0x')) {
            handleHash(hash, key);
          }
        } catch { /* skip bad frames */ }
      };

      ws.onerror = (evt) => {
        console.warn(`[${name}] WebSocket error for ${key}`);
        setFeedStatus(prev => ({ ...prev, [name]: 'disconnected' }));
      };

      ws.onclose = () => {
        console.log(`[${name}] WebSocket closed`);
        setFeedStatus(prev => ({ ...prev, [name]: 'disconnected' }));
      };

      return ws;
    } catch (e) {
      console.warn(`[${name}] Failed to create WebSocket:`, e);
      setFeedStatus(prev => ({ ...prev, [name]: 'disconnected' }));
      return null;
    }
  }, [handleHash]);

  const startPolling = useCallback(() => {
    console.log('[polling] Starting block polling as fallback');
    setFeedStatus(prev => ({ ...prev, primary: 'polling', activeRpc: 'polygon-rpc.com (polling)' }));

    const urls = [
      RPC_ENDPOINTS.polygonPublic,
      RPC_ENDPOINTS.polygonPublic2,
      RPC_ENDPOINTS.polygonPublic3,
    ];

    let lastBlock = { number: 0, hash: '' };

    pollInterval.current = window.setInterval(async () => {
      if (!isRunning.current) return;

      const result = await pollPendingTransactions(lastBlock, urls);
      if (result.txHashes.length > 0) {
        for (const hash of result.txHashes.slice(0, 50)) {
          handleHash(hash, 'polling');
        }
      }
      if (result.latestBlock.number > lastBlock.number) {
        lastBlock = result.latestBlock;
      }
    }, 1000); // Poll every second

  }, [handleHash]);

  const start = useCallback(() => {
    if (isRunning.current) return;
    isRunning.current = true;
    seenHashes.current.clear();
    txCountRef.current = 0;

    // Try WebSocket connections first (in order of reliability)
    // Public WebSocket endpoints often don't support eth_subscribe
    // So we try them, but fall back to polling if they fail

    let wsConnectedPrimary = false;
    let wsConnectedSecondary = false;

    // Try blast first (public WebSocket)
    primaryWs.current = connectWebSocket('primary', WS_ENDPOINTS.blast, 'blast');
    wsConnectedPrimary = !!primaryWs.current;

    // Try infura as secondary after a short delay
    retryTimeout.current = window.setTimeout(() => {
      if (isRunning.current) {
        secondaryWs.current = connectWebSocket('secondary', WS_ENDPOINTS.infura, 'infura');
        wsConnectedSecondary = !!secondaryWs.current;
      }
    }, 2000);

    // If WebSocket fails after 5s, start polling
    setTimeout(() => {
      if (isRunning.current && feedStatus.primary === 'disconnected' && feedStatus.secondary === 'disconnected') {
        startPolling();
      }
    }, 5000);

  }, [connectWebSocket, startPolling, feedStatus.primary, feedStatus.secondary]);

  const stop = useCallback(() => {
    isRunning.current = false;
    primaryWs.current?.close();
    secondaryWs.current?.close();
    primaryWs.current = null;
    secondaryWs.current = null;
    clearTimeout(retryTimeout.current);
    clearInterval(pollInterval.current);
    pollInterval.current = undefined;
    retryTimeout.current = undefined;
    setFeedStatus({
      primary: 'disconnected',
      secondary: 'disconnected',
      txPerMin: 0,
      activeRpc: 'none'
    });
  }, []);

  useEffect(() => {
    if (enabled) start(); else stop();
    return stop;
  }, [enabled, start, stop]);

  useEffect(() => {
    // Auto-start polling if both WebSockets fail and we're enabled
    if (!enabled || !isRunning.current) return;

    const checkFallback = setTimeout(() => {
      const primaryOk = feedStatus.primary === 'connected';
      const secondaryOk = feedStatus.secondary === 'connected';
      const alreadyPolling = feedStatus.primary === 'polling' || feedStatus.secondary === 'polling';

      if (!primaryOk && !secondaryOk && !alreadyPolling && isRunning.current) {
        console.log('[fallback] WebSockets failed, starting polling');
        startPolling();
      }
    }, 6000);

    return () => clearTimeout(checkFallback);
  }, [enabled, feedStatus, startPolling]);

  return { feedStatus };
}

export function useServiceOptimization() {
  const analyzeOpportunity = useCallback((tx: { hash: string; from: string; value: string; gasPrice: string }) => {
    return computeOptimization({
      hash: tx.hash,
      from: tx.from,
      to: '',
      value: tx.value,
      gas: '0x30D40',
      gasPrice: tx.gasPrice,
      input: '0x',
      nonce: 0,
      chainId: 137,
    });
  }, []);
  return { analyzeOpportunity };
}
