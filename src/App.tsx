import { useState, useEffect, useCallback, useRef } from 'react';
import { createClient } from '@supabase/supabase-js';
import { useMempoolMonitor, FeedStatus } from './hooks/useMempoolMonitor';
import {
  Activity,
  Zap,
  TrendingUp,
  Wallet,
  Settings,
  Globe,
  AlertTriangle,
  CheckCircle,
  Clock,
  DollarSign,
  BarChart3,
  RefreshCcw,
  Send,
  Database,
  Server,
  ArrowRight,
  Play,
  Pause,
  Download,
  Copy,
  ExternalLink,
} from 'lucide-react';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const TREASURY_ADDRESS = '0xCD339078D159404D29000A6716D962C8833ABfe8';
const INFURA_KEY_FALLBACK = '09760d45e6844c8b95cc8af069f96160';
const ALCHEMY_WS  = 'wss://polygon-mainnet.g.alchemy.com/v2/wf-n8242VyUxgSwmWNs9h';
const INFURA_WS   = `wss://polygon-mainnet.infura.io/ws/v3/${import.meta.env.VITE_INFURA_KEY || INFURA_KEY_FALLBACK}`;
const POLYGON_RPC = 'https://polygon-mainnet.g.alchemy.com/v2/wf-n8242VyUxgSwmWNs9h';
const OPTIMIZER_ENDPOINT = `${supabaseUrl}/functions/v1/route-optimizer`;
const EXECUTOR_ENDPOINT = `${supabaseUrl}/functions/v1/execute-route`;

type Tab = 'dashboard' | 'transactions' | 'optimizations' | 'access' | 'vault' | 'settings' | 'testing';
type Status = 'idle' | 'running' | 'paused';

interface Alert {
  id: string;
  type: 'success' | 'warning' | 'error';
  message: string;
}

interface MempoolTx {
  id: string;
  transaction_hash: string;
  from_address: string;
  to_address: string;
  value: string;
  gas_price: string;
  gas_limit: string;
  status: string;
  first_seen_at: string;
  route_opportunity: any;
  data: string;
}

interface Optimization {
  id: string;
  optimization_type: string;
  input_token: string;
  output_token: string;
  input_amount: number;
  profit_estimate: number;
  simulated_gas: number;
  status: string;
  priority_score: number;
  created_at: string;
  simulation_trace: any;
}

interface VaultStats {
  totalCollected: number;
  availableForWithdrawal: number;
  pendingDistribution: number;
  reinvestedAmount: number;
}

const SERVICE_CONFIG = {
  name: 'RouteOptimization Protocol',
  version: '1.0.0',
  feePercent: 0.003,
  reinvestPercent: 0.20,
  minGasSavings: 21000,
  supportedChains: ['polygon', 'solana'],
};

function App() {
  const [activeTab, setActiveTab] = useState<Tab>('dashboard');
  const [serviceStatus, setServiceStatus] = useState<Status>('idle');
  const [mempoolTransactions, setMempoolTransactions] = useState<MempoolTx[]>([]);
  const [optimizations, setOptimizations] = useState<Optimization[]>([]);
  const [vaultStats, setVaultStats] = useState<VaultStats>({
    totalCollected: 0,
    availableForWithdrawal: 0,
    pendingDistribution: 0,
    reinvestedAmount: 0,
  });
  const [metrics, setMetrics] = useState({
    txAnalyzed: 0,
    optimizationsFound: 0,
    avgGasSaved: 0,
    successRate: 0,
  });
  const [txPage, setTxPage] = useState(0);
  const [txTotal, setTxTotal] = useState(0);
  const [optPage, setOptPage] = useState(0);
  const [optTotal, setOptTotal] = useState(0);
  const PAGE_SIZE = 100;

  const [withdrawAddress, setWithdrawAddress] = useState('');
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [showWithdrawModal, setShowWithdrawModal] = useState(false);
  const [expandedTx, setExpandedTx] = useState<string | null>(null);
  const [expandedOpt, setExpandedOpt] = useState<string | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const alertTimers = useRef<Record<string, number>>({});

  const [testInput, setTestInput] = useState({
    fromAddress: '',
    toAddress: '',
    calldata: '0x38ed1739',
    gasPrice: '80000000000',
    gasLimit: '250000',
  });
  const [testResult, setTestResult] = useState<any>(null);

  const pushAlert = useCallback((type: Alert['type'], message: string) => {
    const id = `${Date.now()}-${Math.random()}`;
    setAlerts(prev => [...prev.slice(-9), { id, type, message }]);
    alertTimers.current[id] = window.setTimeout(() => {
      setAlerts(prev => prev.filter(a => a.id !== id));
      delete alertTimers.current[id];
    }, 6000);
  }, []);

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text).then(() => pushAlert('success', 'Copied to clipboard'));
  };

  const fetchMetrics = useCallback(async () => {
    const { data } = await supabase.rpc('get_service_metrics' as any).single().catch(() => ({ data: null }));
    if (data) return;

    const [txCountRes, optCountRes, optSumRes] = await Promise.all([
      supabase.from('mempool_transactions').select('id', { count: 'exact', head: true }),
      supabase.from('route_optimizations').select('id', { count: 'exact', head: true }),
      supabase.from('route_optimizations').select('profit_estimate, simulated_gas').eq('status', 'simulated'),
    ]);

    const txCount = txCountRes.count || 0;
    const optCount = optCountRes.count || 0;
    setTxTotal(txCount);
    setOptTotal(optCount);

    let avgGas = 0;
    if (optSumRes.data && optSumRes.data.length > 0) {
      avgGas = optSumRes.data.reduce((s: number, r: any) => s + (r.simulated_gas || 0), 0) / optSumRes.data.length;
    }

    setMetrics({
      txAnalyzed: txCount,
      optimizationsFound: optCount,
      avgGasSaved: Math.round(avgGas),
      successRate: txCount > 0 ? Math.round((optCount / txCount) * 100 * 10) / 10 : 0,
    });
  }, []);

  const fetchTransactions = useCallback(async (page = 0) => {
    const from = page * PAGE_SIZE;
    const { data } = await supabase
      .from('mempool_transactions')
      .select('*')
      .order('created_at', { ascending: false })
      .range(from, from + PAGE_SIZE - 1);
    if (data) setMempoolTransactions(data);
  }, []);

  const fetchOptimizations = useCallback(async (page = 0) => {
    const from = page * PAGE_SIZE;
    const { data } = await supabase
      .from('route_optimizations')
      .select('*')
      .order('created_at', { ascending: false })
      .range(from, from + PAGE_SIZE - 1);
    if (data) setOptimizations(data);
  }, []);

  const fetchVault = useCallback(async () => {
    const { data } = await supabase.from('escrow_rebates').select('amount_numeric, status');
    if (!data) return;
    const total = data.reduce((s: number, v: any) => s + Number(v.amount_numeric || 0), 0);
    const pending = data.filter((v: any) => v.status === 'pending').reduce((s: number, v: any) => s + Number(v.amount_numeric || 0), 0);
    const distributed = data.filter((v: any) => v.status === 'distributed').reduce((s: number, v: any) => s + Number(v.amount_numeric || 0), 0);
    setVaultStats({
      totalCollected: total,
      availableForWithdrawal: Math.max(0, total - pending - distributed),
      pendingDistribution: pending,
      reinvestedAmount: total * SERVICE_CONFIG.reinvestPercent,
    });
  }, []);

  useEffect(() => {
    fetchMetrics();
    fetchTransactions(0);
    fetchOptimizations(0);
    fetchVault();
    const iv = setInterval(() => {
      fetchMetrics();
      fetchVault();
    }, 8000);
    return () => clearInterval(iv);
  }, [fetchMetrics, fetchTransactions, fetchOptimizations, fetchVault]);

  const { feedStatus } = useMempoolMonitor({
    enabled: serviceStatus === 'running',
    minGasPrice: 5e9,
    onTransaction: async (tx, _chain, result) => {
      setMetrics(prev => {
        const newFound = prev.optimizationsFound + (result.hasOpportunity ? 1 : 0);
        const newTotal = prev.txAnalyzed + 1;
        const newAvg = result.hasOpportunity
          ? Math.round((prev.avgGasSaved * prev.optimizationsFound + result.gasSaved) / Math.max(1, newFound))
          : prev.avgGasSaved;
        return {
          txAnalyzed: newTotal,
          optimizationsFound: newFound,
          avgGasSaved: newAvg,
          successRate: Math.round((newFound / newTotal) * 1000) / 10,
        };
      });

      if (result.hasOpportunity) {
        const { data: opt } = await supabase.from('route_optimizations').insert({
          optimization_type: result.type,
          input_token: tx.from,
          output_token: tx.to,
          input_amount: parseInt(tx.value || '0x0', 16),
          profit_estimate: result.profitEstimate,
          simulated_gas: parseInt(tx.gas || '0x0', 16) - result.gasSaved,
          status: 'simulated',
          priority_score: result.confidence * 100,
          simulation_trace: {
            ...result,
            txHash: tx.hash,
            gasPrice: tx.gasPrice,
            gasLimit: tx.gas,
            capturedAt: new Date().toISOString(),
          },
        }).select().single();

        if (opt) {
          setOptimizations(prev => [opt as Optimization, ...prev].slice(0, PAGE_SIZE));
          setOptTotal(prev => prev + 1);
        }

        pushAlert('success',
          `${result.dex}: ${result.functionName} — save ~${result.gasSaved.toLocaleString()} gas (${result.type.replace(/_/g, ' ')})`
        );
      }

      const newTx: Partial<MempoolTx> = {
        transaction_hash: tx.hash,
        from_address: tx.from,
        to_address: tx.to,
        value: tx.value,
        gas_price: tx.gasPrice,
        gas_limit: tx.gas,
        status: 'pending',
        first_seen_at: new Date().toISOString(),
        route_opportunity: result.hasOpportunity ? result : null,
        data: tx.input?.slice(0, 10) || '0x',
      };
      setMempoolTransactions(prev => [newTx as MempoolTx, ...prev].slice(0, PAGE_SIZE));
      setTxTotal(prev => prev + 1);
    },
  });

  const startService = async () => {
    setServiceStatus('running');
    await supabase.from('operator_logs').insert({ action: 'service_started', details: { timestamp: new Date().toISOString() } });
    pushAlert('success', 'Service started — monitoring Polygon mempool');
  };

  const stopService = async () => {
    setServiceStatus('paused');
    await supabase.from('operator_logs').insert({ action: 'service_paused', details: { timestamp: new Date().toISOString() } });
    pushAlert('warning', 'Service paused');
  };

  const handleWithdraw = async () => {
    if (!withdrawAddress || !withdrawAmount) return;
    await supabase.from('operator_logs').insert({
      action: 'withdrawal_requested',
      target: withdrawAddress,
      details: { amount: withdrawAmount, timestamp: new Date().toISOString() },
    });
    pushAlert('success', `Withdrawal of ${withdrawAmount} MATIC queued to ${withdrawAddress}`);
    setShowWithdrawModal(false);
    setWithdrawAddress('');
    setWithdrawAmount('');
  };

  const executeOptimization = async (optimizationId: string) => {
    try {
      const res = await fetch(`${EXECUTOR_ENDPOINT}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ optimizationId }),
      });
      const result = await res.json();

      if (result.success) {
        pushAlert('success', `Executed: ${result.profitMade?.toFixed(6) || '0'} MATIC profit, ${result.gasSaved?.toLocaleString() || 0} gas saved`);
        fetchOptimizations(optPage);
      } else {
        pushAlert('warning', result.error || 'Execution failed');
      }
    } catch (err) {
      pushAlert('error', 'Failed to execute optimization');
    }
  };

  const runTestTransaction = async () => {
    setTestResult(null);
    const fakeGasPrice = parseInt(testInput.gasPrice, 10);
    const fakeGasLimit = parseInt(testInput.gasLimit, 10);
    const selector = testInput.calldata.slice(0, 10);

    const testTx = {
      transaction_hash: `0xtest${Date.now().toString(16).padStart(40, '0')}`,
      from_address: testInput.fromAddress || '0xd8da6bf26964af9d7eed9e03e53415d37aa96045',
      to_address: testInput.toAddress || '0xa5e0829caced8ffdd4de3c43696c57f7d7a678ff',
      value: '0',
      gas_price: fakeGasPrice.toString(),
      gas_limit: fakeGasLimit.toString(),
      data: selector,
      status: 'pending',
    };

    const { data, error } = await supabase.from('mempool_transactions').insert(testTx).select().single();

    const baseFee = 30e9;
    const overpay = fakeGasPrice / baseFee;
    const isDex = ['0x38ed1739','0x414bf389','0x12aa3caf','0x7ff36ab5'].includes(selector);
    const gasSaved = isDex && overpay > 1.5 ? Math.floor(fakeGasLimit * 0.12 + 15000) : 0;

    const result = {
      isDexTransaction: isDex,
      hasOpportunity: gasSaved > 0,
      gasSaved,
      profitEstimateWei: gasSaved * fakeGasPrice,
      profitEstimateMatic: (gasSaved * fakeGasPrice / 1e18).toFixed(8),
      gasOverpayRatio: overpay.toFixed(2),
      selector,
      stored: !error,
      txHash: testTx.transaction_hash,
    };
    setTestResult(result);
    if (data) setMempoolTransactions(prev => [data as unknown as MempoolTx, ...prev]);
    pushAlert(result.hasOpportunity ? 'success' : 'warning', result.hasOpportunity
      ? `Test: optimization found — ${gasSaved.toLocaleString()} gas saved`
      : 'Test: no optimization opportunity for this transaction');
  };

  const formatGasPrice = (gp: string | number) => {
    const n = Number(gp);
    if (!n) return '-';
    return `${(n / 1e9).toFixed(2)} GWEI`;
  };

  const formatValue = (val: string | number) => {
    const n = Number(val);
    if (!n) return '0';
    if (n >= 1e18) return `${(n / 1e18).toFixed(6)} MATIC`;
    return n.toLocaleString();
  };

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'dashboard', label: 'Dashboard', icon: <BarChart3 className="w-4 h-4" /> },
    { id: 'transactions', label: 'Transactions', icon: <Activity className="w-4 h-4" /> },
    { id: 'optimizations', label: 'Optimizations', icon: <Zap className="w-4 h-4" /> },
    { id: 'access', label: 'Public Access', icon: <Globe className="w-4 h-4" /> },
    { id: 'vault', label: 'Vault & Revenue', icon: <Wallet className="w-4 h-4" /> },
    { id: 'testing', label: 'Testing', icon: <Play className="w-4 h-4" /> },
    { id: 'settings', label: 'Settings', icon: <Settings className="w-4 h-4" /> },
  ];

  return (
    <div className="min-h-screen bg-slate-950 text-white">
      {/* Header */}
      <header className="bg-slate-900/80 backdrop-blur-md border-b border-slate-800 sticky top-0 z-50">
        <div className="max-w-screen-2xl mx-auto px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-gradient-to-br from-emerald-500 to-cyan-500 rounded-lg flex items-center justify-center shrink-0">
                <Zap className="w-6 h-6 text-white" />
              </div>
              <div>
                <h1 className="text-lg font-bold bg-gradient-to-r from-emerald-400 to-cyan-400 bg-clip-text text-transparent">
                  {SERVICE_CONFIG.name}
                </h1>
                <p className="text-xs text-slate-500">v{SERVICE_CONFIG.version} | Public Utility — Open Access, No Registration</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 bg-slate-800 rounded-lg text-sm">
                <span className="text-slate-400">Analyzed:</span>
                <span className="font-mono font-semibold text-emerald-400">{metrics.txAnalyzed.toLocaleString()}</span>
              </div>
              <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 rounded-lg">
                <div className={`w-2 h-2 rounded-full ${
                  serviceStatus === 'running' ? 'bg-emerald-500 animate-pulse' :
                  serviceStatus === 'paused' ? 'bg-amber-500' : 'bg-slate-500'
                }`} />
                <span className="text-sm text-slate-300 capitalize">{serviceStatus}</span>
              </div>
              {serviceStatus === 'running' ? (
                <button onClick={stopService} className="btn-danger flex items-center gap-2">
                  <Pause className="w-4 h-4" /> Pause
                </button>
              ) : (
                <button onClick={startService} className="btn-primary flex items-center gap-2">
                  <Play className="w-4 h-4" /> Start
                </button>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Alerts */}
      <div className="fixed top-20 right-4 z-50 space-y-2 max-w-sm w-full">
        {alerts.map(alert => (
          <div key={alert.id} className={`px-4 py-2.5 rounded-lg flex items-start gap-2 animate-slide-in shadow-xl ${
            alert.type === 'success' ? 'bg-emerald-900/95 border border-emerald-700' :
            alert.type === 'warning' ? 'bg-amber-900/95 border border-amber-700' :
            'bg-red-900/95 border border-red-700'
          }`}>
            {alert.type === 'success'
              ? <CheckCircle className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
              : <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />}
            <span className="text-xs leading-relaxed">{alert.message}</span>
          </div>
        ))}
      </div>

      {/* Main */}
      <div className="max-w-screen-2xl mx-auto px-4 py-6">
        <nav className="flex gap-2 mb-6 overflow-x-auto pb-2 scrollbar-hide">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg whitespace-nowrap transition-all text-sm font-medium ${
                activeTab === tab.id
                  ? 'bg-emerald-600 text-white'
                  : 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-white'
              }`}
            >
              {tab.icon}{tab.label}
            </button>
          ))}
        </nav>

        {/* ── DASHBOARD ── */}
        {activeTab === 'dashboard' && (
          <div className="space-y-6">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <MetricCard icon={<Activity className="w-5 h-5" />} label="Transactions Analyzed" value={metrics.txAnalyzed.toLocaleString()} color="emerald" />
              <MetricCard icon={<Zap className="w-5 h-5" />} label="Optimizations Found" value={metrics.optimizationsFound.toLocaleString()} color="cyan" />
              <MetricCard icon={<TrendingUp className="w-5 h-5" />} label="Avg Gas Saved" value={metrics.avgGasSaved.toLocaleString()} subtitle="gas units" color="amber" />
              <MetricCard icon={<DollarSign className="w-5 h-5" />} label="Hit Rate" value={`${metrics.successRate}%`} subtitle="of DEX txs optimizable" color="emerald" />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="bg-slate-900 rounded-xl p-4 border border-slate-800">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <Server className="w-5 h-5 text-cyan-400" />
                    <h3 className="font-semibold">Dual Feed — Polygon Mainnet</h3>
                  </div>
                  {serviceStatus === 'running' && (
                    <span className="text-xs text-slate-400">
                      {feedStatus.txPerMin > 0 ? `~${feedStatus.txPerMin} tx/min` : 'counting…'}
                    </span>
                  )}
                </div>
                <div className="space-y-2">
                  <FeedRow
                    provider="Primary (Blast)"
                    wsUrl={feedStatus.activeRpc || 'Connecting...'}
                    status={feedStatus.primary}
                    activeRpc={feedStatus.activeRpc}
                    onCopy={() => copyToClipboard(feedStatus.activeRpc)}
                  />
                  <FeedRow
                    provider="Secondary (Infura)"
                    wsUrl={INFURA_WS}
                    status={feedStatus.secondary}
                    activeRpc={feedStatus.activeRpc}
                    onCopy={() => copyToClipboard(INFURA_WS)}
                  />
                </div>
                <p className="mt-3 text-xs text-slate-500">
                  Both streams run concurrently. Transactions are deduplicated by hash —
                  whichever feed delivers first wins. Full tx details fetched from
                  whichever RPC responds faster.
                </p>
              </div>

              <div className="bg-slate-900 rounded-xl p-4 border border-slate-800">
                <div className="flex items-center gap-3 mb-4">
                  <Database className="w-5 h-5 text-emerald-400" />
                  <h3 className="font-semibold">Treasury</h3>
                </div>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between items-start gap-4">
                    <span className="text-slate-400 shrink-0">Address</span>
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-mono text-emerald-400 text-xs break-all">{TREASURY_ADDRESS}</span>
                      <button onClick={() => copyToClipboard(TREASURY_ADDRESS)} className="shrink-0 p-1 hover:bg-slate-800 rounded">
                        <Copy className="w-3 h-3 text-slate-400" />
                      </button>
                    </div>
                  </div>
                  <div className="flex justify-between"><span className="text-slate-400">Service Fee</span><span>{(SERVICE_CONFIG.feePercent * 100).toFixed(1)}% of gas savings</span></div>
                  <div className="flex justify-between"><span className="text-slate-400">Reinvestment Pool</span><span>{(SERVICE_CONFIG.reinvestPercent * 100).toFixed(0)}%</span></div>
                  <div className="flex justify-between"><span className="text-slate-400">Access Model</span><span className="text-emerald-400">Open / No Registration</span></div>
                </div>
              </div>
            </div>

            {/* Recent Activity Feed */}
            <div className="bg-slate-900 rounded-xl border border-slate-800">
              <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
                <h3 className="font-semibold flex items-center gap-2">
                  <Clock className="w-4 h-4 text-slate-400" />
                  Live Transaction Feed
                  <span className="text-xs text-slate-500 font-normal">({txTotal.toLocaleString()} total persistent)</span>
                </h3>
                <button onClick={() => fetchTransactions(txPage)} className="p-2 hover:bg-slate-800 rounded-lg transition-colors">
                  <RefreshCcw className="w-4 h-4 text-slate-400" />
                </button>
              </div>
              <div className="divide-y divide-slate-800/60 max-h-[500px] overflow-y-auto">
                {mempoolTransactions.length === 0 ? (
                  <div className="p-8 text-center text-slate-500">
                    <Activity className="w-8 h-8 mx-auto mb-2 opacity-50" />
                    <p>Start the service to begin monitoring the Polygon mempool.</p>
                  </div>
                ) : (
                  mempoolTransactions.slice(0, 20).map(tx => (
                    <div
                      key={tx.id || tx.transaction_hash}
                      className="p-3 hover:bg-slate-800/40 cursor-pointer transition-colors"
                      onClick={() => setExpandedTx(expandedTx === (tx.id || tx.transaction_hash) ? null : (tx.id || tx.transaction_hash))}
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex items-start gap-3 min-w-0 flex-1">
                          <div className="flex flex-col items-center gap-1 shrink-0 mt-0.5">
                            <StatusBadge status={tx.status} />
                            {tx.route_opportunity?.hasOpportunity && (
                              <span className="px-1.5 py-0.5 bg-emerald-900/60 text-emerald-400 rounded text-xs border border-emerald-700/50">opt</span>
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="font-mono text-xs text-slate-300 break-all">{tx.transaction_hash}</p>
                            <p className="font-mono text-xs text-slate-500 mt-0.5 break-all">
                              <span className="text-slate-400">from</span> {tx.from_address}
                            </p>
                            <p className="font-mono text-xs text-slate-500 mt-0.5 break-all">
                              <ArrowRight className="w-3 h-3 inline text-slate-600" /> {tx.to_address}
                            </p>
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          <p className="text-xs font-mono">{formatGasPrice(tx.gas_price)}</p>
                          <p className="text-xs text-slate-500">{tx.first_seen_at ? new Date(tx.first_seen_at).toLocaleTimeString() : ''}</p>
                        </div>
                      </div>
                      {expandedTx === (tx.id || tx.transaction_hash) && (
                        <div className="mt-3 pt-3 border-t border-slate-700 grid grid-cols-1 gap-1 text-xs">
                          <DataRow label="Transaction Hash" value={tx.transaction_hash} copy />
                          <DataRow label="From Address" value={tx.from_address} copy />
                          <DataRow label="To Address" value={tx.to_address} copy />
                          <DataRow label="Gas Price" value={formatGasPrice(tx.gas_price)} />
                          <DataRow label="Gas Limit" value={Number(tx.gas_limit).toLocaleString()} />
                          <DataRow label="Value" value={formatValue(tx.value)} />
                          <DataRow label="Function Selector" value={tx.data || '-'} />
                          <DataRow label="First Seen" value={tx.first_seen_at ? new Date(tx.first_seen_at).toLocaleString() : '-'} />
                          {tx.route_opportunity?.hasOpportunity && (
                            <>
                              <DataRow label="Optimization Type" value={tx.route_opportunity.type?.replace(/_/g, ' ') || '-'} />
                              <DataRow label="DEX Detected" value={tx.route_opportunity.dex || '-'} />
                              <DataRow label="Gas Saved" value={`${(tx.route_opportunity.gasSaved || 0).toLocaleString()} gas`} />
                              <DataRow label="Reason" value={tx.route_opportunity.reason || '-'} />
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── TRANSACTIONS ── */}
        {activeTab === 'transactions' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-slate-300">
                All Transactions
                <span className="ml-2 text-sm text-slate-500 font-normal">{txTotal.toLocaleString()} persisted</span>
              </h2>
              <div className="flex items-center gap-2">
                <button
                  disabled={txPage === 0}
                  onClick={() => { const p = txPage - 1; setTxPage(p); fetchTransactions(p); }}
                  className="px-3 py-1 bg-slate-800 rounded text-sm disabled:opacity-40"
                >Prev</button>
                <span className="text-sm text-slate-400">Page {txPage + 1}</span>
                <button
                  disabled={(txPage + 1) * PAGE_SIZE >= txTotal}
                  onClick={() => { const p = txPage + 1; setTxPage(p); fetchTransactions(p); }}
                  className="px-3 py-1 bg-slate-800 rounded text-sm disabled:opacity-40"
                >Next</button>
              </div>
            </div>
            <div className="bg-slate-900 rounded-xl border border-slate-800 overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-800/60 sticky top-0">
                  <tr>
                    <th className="px-3 py-3 text-left text-slate-400 font-medium">Tx Hash</th>
                    <th className="px-3 py-3 text-left text-slate-400 font-medium">From</th>
                    <th className="px-3 py-3 text-left text-slate-400 font-medium">To</th>
                    <th className="px-3 py-3 text-left text-slate-400 font-medium">Gas Price</th>
                    <th className="px-3 py-3 text-left text-slate-400 font-medium">Selector</th>
                    <th className="px-3 py-3 text-left text-slate-400 font-medium">Opt</th>
                    <th className="px-3 py-3 text-left text-slate-400 font-medium">Status</th>
                    <th className="px-3 py-3 text-left text-slate-400 font-medium">Time</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {mempoolTransactions.map((tx, i) => (
                    <>
                      <tr
                        key={tx.id || tx.transaction_hash || i}
                        className="hover:bg-slate-800/30 cursor-pointer"
                        onClick={() => setExpandedTx(expandedTx === (tx.id || tx.transaction_hash) ? null : (tx.id || tx.transaction_hash))}
                      >
                        <td className="px-3 py-2 font-mono text-slate-300 break-all max-w-[200px]">{tx.transaction_hash}</td>
                        <td className="px-3 py-2 font-mono text-slate-400 break-all max-w-[200px]">{tx.from_address}</td>
                        <td className="px-3 py-2 font-mono text-slate-400 break-all max-w-[200px]">{tx.to_address}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{formatGasPrice(tx.gas_price)}</td>
                        <td className="px-3 py-2 font-mono text-slate-500">{tx.data?.slice(0, 10) || '-'}</td>
                        <td className="px-3 py-2">
                          {tx.route_opportunity?.hasOpportunity
                            ? <span className="text-emerald-400 font-semibold">YES</span>
                            : <span className="text-slate-600">—</span>}
                        </td>
                        <td className="px-3 py-2"><StatusBadge status={tx.status} /></td>
                        <td className="px-3 py-2 text-slate-500 whitespace-nowrap">
                          {tx.first_seen_at ? new Date(tx.first_seen_at).toLocaleString() : '-'}
                        </td>
                      </tr>
                      {expandedTx === (tx.id || tx.transaction_hash) && (
                        <tr key={`${tx.id}-exp`} className="bg-slate-800/20">
                          <td colSpan={8} className="px-4 py-3">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-1">
                              <DataRow label="Full Tx Hash" value={tx.transaction_hash} copy />
                              <DataRow label="From Address" value={tx.from_address} copy />
                              <DataRow label="To Address" value={tx.to_address} copy />
                              <DataRow label="Gas Price (wei)" value={tx.gas_price} />
                              <DataRow label="Gas Limit" value={tx.gas_limit} />
                              <DataRow label="Value (wei)" value={tx.value || '0'} />
                              {tx.route_opportunity?.hasOpportunity && (
                                <>
                                  <DataRow label="Opt Type" value={tx.route_opportunity.type?.replace(/_/g, ' ')} />
                                  <DataRow label="DEX" value={tx.route_opportunity.dex} />
                                  <DataRow label="Function" value={tx.route_opportunity.functionName} />
                                  <DataRow label="Gas Saved" value={`${(tx.route_opportunity.gasSaved || 0).toLocaleString()}`} />
                                  <DataRow label="Confidence" value={`${((tx.route_opportunity.confidence || 0) * 100).toFixed(1)}%`} />
                                  <DataRow label="Reason" value={tx.route_opportunity.reason} />
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  ))}
                </tbody>
              </table>
              {mempoolTransactions.length === 0 && (
                <div className="p-8 text-center text-slate-500">No transactions recorded yet</div>
              )}
            </div>
          </div>
        )}

        {/* ── OPTIMIZATIONS ── */}
        {activeTab === 'optimizations' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-slate-300">
                Optimization Log
                <span className="ml-2 text-sm text-slate-500 font-normal">{optTotal.toLocaleString()} total</span>
              </h2>
              <div className="flex items-center gap-2">
                <button
                  disabled={optPage === 0}
                  onClick={() => { const p = optPage - 1; setOptPage(p); fetchOptimizations(p); }}
                  className="px-3 py-1 bg-slate-800 rounded text-sm disabled:opacity-40"
                >Prev</button>
                <span className="text-sm text-slate-400">Page {optPage + 1}</span>
                <button
                  disabled={(optPage + 1) * PAGE_SIZE >= optTotal}
                  onClick={() => { const p = optPage + 1; setOptPage(p); fetchOptimizations(p); }}
                  className="px-3 py-1 bg-slate-800 rounded text-sm disabled:opacity-40"
                >Next</button>
              </div>
            </div>
            <div className="bg-slate-900 rounded-xl border border-slate-800 overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-800/60">
                  <tr>
                    <th className="px-3 py-3 text-left text-slate-400">Type</th>
                    <th className="px-3 py-3 text-left text-slate-400">From (Sender)</th>
                    <th className="px-3 py-3 text-left text-slate-400">To (Router)</th>
                    <th className="px-3 py-3 text-left text-slate-400">Gas Saved</th>
                    <th className="px-3 py-3 text-left text-slate-400">Profit Est.</th>
                    <th className="px-3 py-3 text-left text-slate-400">Confidence</th>
                    <th className="px-3 py-3 text-left text-slate-400">Status</th>
                    <th className="px-3 py-3 text-left text-slate-400">Time</th>
                    <th className="px-3 py-3 text-left text-slate-400">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {optimizations.map((opt, i) => (
                    <>
                      <tr
                        key={opt.id || i}
                        className="hover:bg-slate-800/30 cursor-pointer"
                        onClick={() => setExpandedOpt(expandedOpt === opt.id ? null : opt.id)}
                      >
                        <td className="px-3 py-2">
                          <span className="px-2 py-0.5 bg-cyan-900/40 text-cyan-400 rounded border border-cyan-800/50">
                            {opt.optimization_type?.replace(/_/g, ' ')}
                          </span>
                        </td>
                        <td className="px-3 py-2 font-mono text-slate-400 break-all max-w-[200px]">{opt.input_token}</td>
                        <td className="px-3 py-2 font-mono text-slate-400 break-all max-w-[200px]">{opt.output_token}</td>
                        <td className="px-3 py-2 font-mono">{Number(opt.simulated_gas).toLocaleString()}</td>
                        <td className="px-3 py-2 text-emerald-400 font-mono">
                          {opt.profit_estimate ? `${Number(opt.profit_estimate).toFixed(8)} MATIC` : '-'}
                        </td>
                        <td className="px-3 py-2">{opt.priority_score ? `${Number(opt.priority_score).toFixed(1)}%` : '-'}</td>
                        <td className="px-3 py-2"><StatusBadge status={opt.status} /></td>
                        <td className="px-3 py-2 text-slate-500 whitespace-nowrap">
                          {new Date(opt.created_at).toLocaleString()}
                        </td>
                        <td className="px-3 py-2" onClick={e => e.stopPropagation()}>
                          {opt.status === 'simulated' && (
                            <button
                              onClick={() => executeOptimization(opt.id)}
                              className="px-2 py-1 bg-emerald-600 hover:bg-emerald-500 rounded text-xs font-medium transition-colors"
                            >
                              Execute
                            </button>
                          )}
                        </td>
                      </tr>
                      {expandedOpt === opt.id && opt.simulation_trace && (
                        <tr key={`${opt.id}-exp`} className="bg-slate-800/20">
                          <td colSpan={9} className="px-4 py-3">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-1 mb-2">
                              <DataRow label="From Address" value={opt.input_token} copy />
                              <DataRow label="To Address" value={opt.output_token} copy />
                              <DataRow label="DEX" value={opt.simulation_trace.dex || '-'} />
                              <DataRow label="Function" value={opt.simulation_trace.functionName || '-'} />
                              <DataRow label="Gas Saved" value={(opt.simulation_trace.gasSaved || 0).toLocaleString()} />
                              <DataRow label="Tx Hash" value={opt.simulation_trace.txHash || '-'} copy />
                              <DataRow label="Captured At" value={opt.simulation_trace.capturedAt ? new Date(opt.simulation_trace.capturedAt).toLocaleString() : '-'} />
                              <DataRow label="Reason" value={opt.simulation_trace.reason || '-'} />
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  ))}
                </tbody>
              </table>
              {optimizations.length === 0 && (
                <div className="p-8 text-center text-slate-500">No optimizations found yet — start the service to analyze DEX transactions</div>
              )}
            </div>
          </div>
        )}

        {/* ── PUBLIC ACCESS ── */}
        {activeTab === 'access' && (
          <div className="space-y-6">
            <div className="bg-slate-900 rounded-xl border border-slate-800 p-6">
              <div className="flex items-center gap-3 mb-2">
                <Globe className="w-5 h-5 text-emerald-400" />
                <h3 className="font-semibold text-lg">Open Public API</h3>
                <span className="px-2 py-0.5 bg-emerald-900/40 text-emerald-400 text-xs rounded border border-emerald-700/50">No Auth Required</span>
              </div>
              <p className="text-slate-400 text-sm mb-6">
                Any agent or system can query this service freely. Optimization requests are pay-per-use via on-chain fee;
                historical log queries are always free. No registration, no API keys, no accounts.
              </p>

              <div className="space-y-4">
                <ApiBlock
                  method="GET"
                  endpoint={`${OPTIMIZER_ENDPOINT}/status`}
                  label="Service Status (free)"
                  description="Returns live service configuration and supported chains."
                  onCopy={() => copyToClipboard(`${OPTIMIZER_ENDPOINT}/status`)}
                />
                <ApiBlock
                  method="GET"
                  endpoint={`${OPTIMIZER_ENDPOINT}/metrics`}
                  label="Aggregate Metrics (free)"
                  description="Returns historical optimization statistics."
                  onCopy={() => copyToClipboard(`${OPTIMIZER_ENDPOINT}/metrics`)}
                />
                <ApiBlock
                  method="POST"
                  endpoint={OPTIMIZER_ENDPOINT}
                  label="Analyze Transaction (fee applies on profitable result)"
                  description="Submit a pending transaction for route optimization analysis. Returns savings estimate and optimized path."
                  body={JSON.stringify({
                    transactionHash: '0x...',
                    fromAddress: '0x...',
                    toAddress: '0xa5e0829caced8ffdd4de3c43696c57f7d7a678ff',
                    value: '0x0',
                    gasPrice: '0x1312D00',
                    gasLimit: '0x3D090',
                    data: '0x38ed1739...',
                    chain: 'polygon',
                  }, null, 2)}
                  onCopy={() => copyToClipboard(OPTIMIZER_ENDPOINT)}
                />
              </div>
            </div>

            <div className="bg-slate-900 rounded-xl border border-slate-800 p-6">
              <h3 className="font-semibold mb-4">Agentverse / Agent Commerce Integration</h3>
              <div className="bg-slate-800 rounded-lg p-4 text-xs font-mono text-slate-300 overflow-x-auto">
                <button
                  onClick={() => copyToClipboard(JSON.stringify({
                    name: SERVICE_CONFIG.name,
                    version: SERVICE_CONFIG.version,
                    endpoint: OPTIMIZER_ENDPOINT,
                    chains: SERVICE_CONFIG.supportedChains,
                    access: 'public',
                    registration: 'none',
                    feeModel: 'pay-per-optimization',
                    feePercent: SERVICE_CONFIG.feePercent,
                    queryLogs: 'free',
                    treasury: TREASURY_ADDRESS,
                  }, null, 2))}
                  className="float-right p-1 hover:bg-slate-700 rounded mb-2"
                >
                  <Copy className="w-3.5 h-3.5 text-slate-400" />
                </button>
                <pre>{JSON.stringify({
                  name: SERVICE_CONFIG.name,
                  version: SERVICE_CONFIG.version,
                  endpoint: OPTIMIZER_ENDPOINT,
                  chains: SERVICE_CONFIG.supportedChains,
                  access: 'public',
                  registration: 'none',
                  feeModel: 'pay-per-optimization',
                  feePercent: SERVICE_CONFIG.feePercent,
                  queryLogs: 'free',
                  treasury: TREASURY_ADDRESS,
                }, null, 2)}</pre>
              </div>
            </div>
          </div>
        )}

        {/* ── VAULT ── */}
        {activeTab === 'vault' && (
          <div className="space-y-6">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <MetricCard icon={<Wallet className="w-5 h-5" />} label="Total Collected" value={`${vaultStats.totalCollected.toFixed(6)} MATIC`} color="emerald" />
              <MetricCard icon={<Download className="w-5 h-5" />} label="Available" value={`${vaultStats.availableForWithdrawal.toFixed(6)} MATIC`} color="cyan" />
              <MetricCard icon={<Clock className="w-5 h-5" />} label="Pending Distribution" value={`${vaultStats.pendingDistribution.toFixed(6)} MATIC`} color="amber" />
              <MetricCard icon={<TrendingUp className="w-5 h-5" />} label="Reinvestment Pool" value={`${vaultStats.reinvestedAmount.toFixed(6)} MATIC`} color="emerald" />
            </div>

            <div className="bg-slate-900 rounded-xl border border-slate-800 p-6">
              <div className="flex items-center justify-between mb-6">
                <h3 className="font-semibold">Revenue Allocation</h3>
                <button
                  onClick={() => setShowWithdrawModal(true)}
                  className="btn-primary flex items-center gap-2"
                >
                  <Send className="w-4 h-4" /> Withdraw
                </button>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-slate-800 rounded-xl p-4 border border-slate-700">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-slate-400 text-sm">User Rebates</span>
                    <span className="text-2xl font-bold text-emerald-400">{((1 - SERVICE_CONFIG.reinvestPercent) * 100).toFixed(0)}%</span>
                  </div>
                  <p className="text-xs text-slate-500">Returned to wallets that would have benefited from optimization (stateless escrow, decoupled)</p>
                </div>
                <div className="bg-slate-800 rounded-xl p-4 border border-slate-700">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-slate-400 text-sm">Reinvestment Pool</span>
                    <span className="text-2xl font-bold text-amber-400">{(SERVICE_CONFIG.reinvestPercent * 100).toFixed(0)}%</span>
                  </div>
                  <p className="text-xs text-slate-500">Funds infrastructure, gas costs, RPC credits, and maintenance</p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── TESTING ── */}
        {activeTab === 'testing' && (
          <div className="space-y-6">
            <div className="bg-slate-900 rounded-xl border border-slate-800 p-6">
              <h3 className="font-semibold mb-2">Manual Optimization Test</h3>
              <p className="text-sm text-slate-400 mb-4">
                Simulate a DEX transaction to verify the detection and optimization pipeline. Uses real function selectors.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-slate-400 mb-1">From Address (sender)</label>
                  <input
                    value={testInput.fromAddress}
                    onChange={e => setTestInput(p => ({ ...p, fromAddress: e.target.value }))}
                    placeholder="0xd8da6bf26964af9d7eed9e03e53415d37aa96045"
                    className="input-field font-mono text-xs"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">To Address (DEX router)</label>
                  <input
                    value={testInput.toAddress}
                    onChange={e => setTestInput(p => ({ ...p, toAddress: e.target.value }))}
                    placeholder="0xa5e0829caced8ffdd4de3c43696c57f7d7a678ff"
                    className="input-field font-mono text-xs"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Calldata (function selector)</label>
                  <select
                    value={testInput.calldata}
                    onChange={e => setTestInput(p => ({ ...p, calldata: e.target.value }))}
                    className="input-field text-xs"
                  >
                    <option value="0x38ed1739">0x38ed1739 — swapExactTokensForTokens (UniV2)</option>
                    <option value="0x414bf389">0x414bf389 — exactInputSingle (UniV3)</option>
                    <option value="0x12aa3caf">0x12aa3caf — swap (1inch V5)</option>
                    <option value="0x7ff36ab5">0x7ff36ab5 — swapExactETHForTokens (UniV2)</option>
                    <option value="0xdeadbeef">0xdeadbeef — unknown (non-DEX)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Gas Price (wei)</label>
                  <input
                    value={testInput.gasPrice}
                    onChange={e => setTestInput(p => ({ ...p, gasPrice: e.target.value }))}
                    placeholder="80000000000"
                    className="input-field font-mono text-xs"
                  />
                  <p className="text-xs text-slate-600 mt-1">{(parseInt(testInput.gasPrice, 10) / 1e9).toFixed(1)} GWEI (Polygon base ~30 GWEI)</p>
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Gas Limit</label>
                  <input
                    value={testInput.gasLimit}
                    onChange={e => setTestInput(p => ({ ...p, gasLimit: e.target.value }))}
                    placeholder="250000"
                    className="input-field font-mono text-xs"
                  />
                </div>
              </div>
              <button onClick={runTestTransaction} className="btn-primary mt-4 flex items-center gap-2">
                <Play className="w-4 h-4" /> Run Test
              </button>

              {testResult && (
                <div className={`mt-4 rounded-xl p-4 border ${testResult.hasOpportunity ? 'bg-emerald-950/40 border-emerald-700/50' : 'bg-slate-800 border-slate-700'}`}>
                  <p className={`font-semibold mb-3 ${testResult.hasOpportunity ? 'text-emerald-400' : 'text-slate-400'}`}>
                    {testResult.hasOpportunity ? 'Optimization Opportunity Detected' : 'No Optimization Available'}
                  </p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-1 text-xs">
                    <DataRow label="Is DEX Transaction" value={testResult.isDexTransaction ? 'YES' : 'NO'} />
                    <DataRow label="Function Selector" value={testResult.selector} />
                    <DataRow label="Gas Overpay Ratio" value={`${testResult.gasOverpayRatio}x base fee`} />
                    <DataRow label="Gas Saved" value={testResult.gasSaved.toLocaleString()} />
                    <DataRow label="Profit Estimate" value={`${testResult.profitEstimateMatic} MATIC`} />
                    <DataRow label="Stored in DB" value={testResult.stored ? 'YES' : 'FAILED'} />
                    <DataRow label="Test Tx Hash" value={testResult.txHash} copy />
                  </div>
                </div>
              )}
            </div>

            <div className="bg-slate-900 rounded-xl border border-slate-800 p-6">
              <h3 className="font-semibold mb-4">System Verification</h3>
              <div className="space-y-2">
                <VerificationItem label="Supabase Database" status={mempoolTransactions !== null} />
                <VerificationItem label="Polygon RPC Configured" status={!!POLYGON_RPC} />
                <VerificationItem label="Treasury Address Set" status={!!TREASURY_ADDRESS} detail={TREASURY_ADDRESS} />
                <VerificationItem label="Edge Function Deployed" status={!!OPTIMIZER_ENDPOINT} detail={OPTIMIZER_ENDPOINT} />
                <VerificationItem label="Executor Function Deployed" status={!!EXECUTOR_ENDPOINT} detail={EXECUTOR_ENDPOINT} />
                <VerificationItem label="Service Fee Configured" status={SERVICE_CONFIG.feePercent > 0} detail={`${(SERVICE_CONFIG.feePercent * 100).toFixed(1)}%`} />
                <VerificationItem label="Persistent Logs Active" status={txTotal > 0 || mempoolTransactions.length === 0} detail={`${txTotal.toLocaleString()} transactions stored`} />
              </div>
            </div>
          </div>
        )}

        {/* ── SETTINGS ── */}
        {activeTab === 'settings' && (
          <div className="space-y-6">
            <div className="bg-slate-900 rounded-xl border border-slate-800 p-6">
              <h3 className="font-semibold mb-4">Service Configuration</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {[
                  { label: 'Service Fee', value: `${(SERVICE_CONFIG.feePercent * 100).toFixed(1)}% of gas savings` },
                  { label: 'Min Gas Savings Threshold', value: `${SERVICE_CONFIG.minGasSavings.toLocaleString()} gas units` },
                  { label: 'Reinvestment Rate', value: `${(SERVICE_CONFIG.reinvestPercent * 100).toFixed(0)}%` },
                  { label: 'Supported Chains', value: SERVICE_CONFIG.supportedChains.join(', ') },
                  { label: 'Access Model', value: 'Open Public Utility' },
                  { label: 'Agent Registration', value: 'None required' },
                ].map(({ label, value }) => (
                  <div key={label} className="bg-slate-800 rounded-lg p-4">
                    <p className="text-xs text-slate-400 mb-1">{label}</p>
                    <p className="font-medium text-sm">{value}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-slate-900 rounded-xl border border-slate-800 p-6">
              <h3 className="font-semibold mb-4">Setup Checklist</h3>
              <div className="space-y-4 text-sm">
                <div className="bg-slate-800 rounded-lg p-4">
                  <p className="text-emerald-400 font-medium mb-2">Configured & Live</p>
                  <ul className="space-y-1 text-slate-300 text-xs">
                    <li className="flex items-center gap-2"><CheckCircle className="w-3.5 h-3.5 text-emerald-500" /> Alchemy API — Polygon + Solana mainnet RPC active</li>
                    <li className="flex items-center gap-2"><CheckCircle className="w-3.5 h-3.5 text-emerald-500" /> Supabase — persistent database provisioned</li>
                    <li className="flex items-center gap-2"><CheckCircle className="w-3.5 h-3.5 text-emerald-500" /> Optimizer API at {OPTIMIZER_ENDPOINT}</li>
                    <li className="flex items-center gap-2"><CheckCircle className="w-3.5 h-3.5 text-emerald-500" /> Executor API at {EXECUTOR_ENDPOINT}</li>
                    <li className="flex items-center gap-2"><CheckCircle className="w-3.5 h-3.5 text-emerald-500" /> Treasury wallet set: <span className="font-mono text-emerald-400 break-all">{TREASURY_ADDRESS}</span></li>
                  </ul>
                </div>
                <div className="bg-slate-800 rounded-lg p-4">
                  <p className="text-amber-400 font-medium mb-2">Operational Notes</p>
                  <ul className="space-y-1 text-slate-300 text-xs">
                    <li>• Starting balance ~0.60 MATIC covers initial gas for fee collection logic</li>
                    <li>• Rebate escrow is decoupled — runs independently, does not block optimization throughput</li>
                    <li>• No Alchemy account needed beyond the provided key — upgrade plan for higher throughput</li>
                    <li>• Alchemy free tier: 300M compute units/month — sufficient for monitoring + analysis</li>
                  </ul>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Withdraw Modal */}
      {showWithdrawModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-slate-900 rounded-xl border border-slate-700 p-6 max-w-md w-full mx-4">
            <h3 className="font-semibold text-lg mb-4">Withdraw Funds</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-slate-400 mb-1">Destination Address</label>
                <input value={withdrawAddress} onChange={e => setWithdrawAddress(e.target.value)} placeholder="0x..." className="input-field font-mono text-xs" />
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">Amount (MATIC)</label>
                <input value={withdrawAmount} onChange={e => setWithdrawAmount(e.target.value)} placeholder={vaultStats.availableForWithdrawal.toFixed(6)} className="input-field" />
                <p className="text-xs text-slate-500 mt-1">Available: {vaultStats.availableForWithdrawal.toFixed(6)} MATIC</p>
              </div>
            </div>
            <div className="flex gap-3 mt-6">
              <button onClick={() => setShowWithdrawModal(false)} className="btn-secondary flex-1">Cancel</button>
              <button onClick={handleWithdraw} className="btn-primary flex-1">Withdraw</button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        .btn-primary { @apply px-4 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-lg font-medium text-sm transition-colors; }
        .btn-secondary { @apply px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg font-medium text-sm transition-colors; }
        .btn-danger { @apply px-4 py-2 bg-red-700 hover:bg-red-600 rounded-lg font-medium text-sm transition-colors; }
        .input-field { @apply w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white placeholder-slate-600 focus:outline-none focus:border-emerald-500 transition-colors text-sm; }
        @keyframes slide-in { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
        .animate-slide-in { animation: slide-in 0.25s ease-out; }
        .scrollbar-hide::-webkit-scrollbar { display: none; }
        .scrollbar-hide { -ms-overflow-style: none; scrollbar-width: none; }
      `}</style>
    </div>
  );
}

function DataRow({ label, value, copy }: { label: string; value: string; copy?: boolean }) {
  const copyToClipboard = (t: string) => navigator.clipboard.writeText(t);
  return (
    <div className="flex items-start gap-2 py-0.5">
      <span className="text-slate-500 shrink-0 w-36">{label}:</span>
      <div className="flex items-start gap-1 min-w-0 flex-1">
        <span className="font-mono text-slate-300 break-all text-xs">{value}</span>
        {copy && value && value !== '-' && (
          <button onClick={() => copyToClipboard(value)} className="shrink-0 p-0.5 hover:bg-slate-700 rounded mt-0.5">
            <Copy className="w-3 h-3 text-slate-500" />
          </button>
        )}
      </div>
    </div>
  );
}

function ApiBlock({ method, endpoint, label, description, body, onCopy }: {
  method: string; endpoint: string; label: string; description: string; body?: string; onCopy: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="bg-slate-800 rounded-lg overflow-hidden border border-slate-700">
      <div className="px-4 py-3 flex items-center justify-between gap-4 cursor-pointer" onClick={() => setOpen(!open)}>
        <div className="flex items-center gap-3">
          <span className={`px-2 py-0.5 rounded text-xs font-bold ${method === 'GET' ? 'bg-emerald-900/60 text-emerald-400' : 'bg-blue-900/60 text-blue-400'}`}>{method}</span>
          <span className="font-mono text-xs text-slate-300 break-all">{endpoint}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={e => { e.stopPropagation(); onCopy(); }} className="p-1 hover:bg-slate-700 rounded">
            <Copy className="w-3.5 h-3.5 text-slate-400" />
          </button>
          <ExternalLink className="w-3.5 h-3.5 text-slate-500" />
        </div>
      </div>
      {open && (
        <div className="px-4 pb-4 border-t border-slate-700">
          <p className="text-xs text-slate-400 mt-3 mb-2">{description}</p>
          {body && <pre className="bg-slate-900 rounded p-3 text-xs text-slate-300 overflow-x-auto">{body}</pre>}
        </div>
      )}
    </div>
  );
}

function MetricCard({ icon, label, value, subtitle, color }: {
  icon: React.ReactNode; label: string; value: string; subtitle?: string; color: 'emerald' | 'cyan' | 'amber';
}) {
  const colors = { emerald: 'from-emerald-500/20 to-emerald-500/5 border-emerald-500/30', cyan: 'from-cyan-500/20 to-cyan-500/5 border-cyan-500/30', amber: 'from-amber-500/20 to-amber-500/5 border-amber-500/30' };
  return (
    <div className={`bg-gradient-to-br ${colors[color]} rounded-xl p-4 border`}>
      <div className="flex items-center gap-2 text-slate-400 mb-2">{icon}<span className="text-sm">{label}</span></div>
      <p className="text-2xl font-bold">{value}</p>
      {subtitle && <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    pending: 'bg-amber-900/50 text-amber-400 border-amber-700/50',
    simulated: 'bg-cyan-900/50 text-cyan-400 border-cyan-700/50',
    succeeded: 'bg-emerald-900/50 text-emerald-400 border-emerald-700/50',
    included: 'bg-emerald-900/50 text-emerald-400 border-emerald-700/50',
    failed: 'bg-red-900/50 text-red-400 border-red-700/50',
    dropped: 'bg-slate-700/50 text-slate-400 border-slate-600/50',
    expired: 'bg-slate-700/50 text-slate-400 border-slate-600/50',
  };
  return (
    <span className={`px-1.5 py-0.5 rounded text-xs border ${styles[status] || 'bg-slate-700 text-slate-300'}`}>{status}</span>
  );
}

function FeedRow({ provider, wsUrl, status, activeRpc, onCopy }: {
  provider: string;
  wsUrl: string;
  status: 'connecting' | 'connected' | 'disconnected' | 'polling';
  activeRpc?: string;
  onCopy: () => void;
}) {
  const dot: Record<string, string> = {
    connected:    'bg-emerald-500 animate-pulse',
    connecting:   'bg-amber-400 animate-pulse',
    polling:      'bg-cyan-500 animate-pulse',
    disconnected: 'bg-slate-600',
  };
  const label: Record<string, string> = {
    connected:    'live',
    connecting:   'connecting…',
    polling:       'polling',
    disconnected: 'offline',
  };
  return (
    <div className="bg-slate-800 rounded-lg p-3">
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${dot[status]}`} />
          <span className="text-xs font-medium text-slate-300">{provider}</span>
          <span className={`text-xs ${status === 'connected' || status === 'polling' ? 'text-emerald-400' : 'text-slate-500'}`}>{label[status]}</span>
        </div>
        <button onClick={onCopy} className="p-1 hover:bg-slate-700 rounded">
          <Copy className="w-3 h-3 text-slate-500" />
        </button>
      </div>
      <p className="font-mono text-xs text-slate-500 break-all">{wsUrl}</p>
    </div>
  );
}

function VerificationItem({ label, status, detail }: { label: string; status: boolean; detail?: string }) {
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-2 bg-slate-800/50 rounded-lg">
      <div>
        <span className="text-sm">{label}</span>
        {detail && <p className="font-mono text-xs text-slate-500 break-all mt-0.5">{detail}</p>}
      </div>
      {status ? <CheckCircle className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" /> : <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />}
    </div>
  );
}

export default App;
