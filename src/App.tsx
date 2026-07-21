import { useState, useEffect, useCallback, useRef } from 'react';
import { createClient } from '@supabase/supabase-js';
import { useMempoolMonitor } from './hooks/useMempoolMonitor';
import {
  Activity, Zap, TrendingUp, Wallet, Settings, Globe, AlertTriangle,
  CheckCircle, Clock, DollarSign, BarChart3, RefreshCcw, Send,
  Database, Server, ArrowRight, Play, Pause, Copy, ExternalLink,
  Radio, Users, Cpu, Network, Coins, Signal, ArrowDownToLine,
  ArrowUpFromLine, Wifi, WifiOff, Search, Filter, Download,
  ChevronDown, ChevronUp, Link, Unlink, Power,
} from 'lucide-react';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const SIGNAL_API = `${supabaseUrl}/functions/v1/signal-marketplace`;

type Tab = 'dashboard' | 'wallet' | 'subscribers' | 'revenue' | 'signals' | 'agent' | 'settings';
type Status = 'idle' | 'running' | 'paused';
type Alert = { id: string; type: 'success' | 'warning' | 'error' | 'info'; message: string };

interface AgentSubscriber {
  id: string; subscriber_address: string; subscriber_name: string;
  tier: string; status: string; joined_at: string; last_query_at: string | null;
  total_queries: number; total_fet_paid: number; metadata: any;
}

interface SignalRequestLog {
  id: string; subscriber_address: string; signal_type: string; tier: string;
  result_count: number; latency_ms: number; payment_amount: number;
  payment_status: string; payment_tx_hash: string | null; created_at: string;
}

interface RevenueEntry {
  id: string; subscriber_address: string; amount_fet: number; usd_value: number;
  signal_request_id: string | null; tx_hash: string | null; block_number: number | null;
  status: string; created_at: string;
}

interface SignalItem {
  tx_hash: string; from: string; to: string; gas_price_gwei: number; gas_limit: number;
  dex: string; function: string; signal_type: string; gas_saved: number;
  confidence: number; reason: string; detected_at: string;
}

interface WalletInfo {
  wallet_address: string; agent_address: string; balance_fet: number;
  balance_updated_at: string; network: string; seed_phrase_set: boolean;
}

interface WalletTx {
  id: string; wallet_address: string; direction: string; counterparty_address: string;
  amount_fet: number; tx_hash: string; block_number: number | null;
  status: string; description: string; created_at: string;
}

interface WithdrawalReq {
  id: string; destination_address: string; amount_fet: number; status: string;
  tx_hash: string | null; requested_at: string; processed_at: string | null;
  error_message: string | null;
}

interface AgentStatus {
  service: string; status: string; agent_address: string; wallet_address: string;
  wallet_balance_fet: number; wallet_network: string; almanac_registered: boolean;
  agent_online: boolean; last_heartbeat: string | null;
  active_subscribers: number; total_queries: number; total_revenue_fet: string;
  pricing: { free: any; premium: any }; capabilities: string[]; network: string;
}

function App() {
  const [activeTab, setActiveTab] = useState<Tab>('dashboard');
  const [serviceStatus, setServiceStatus] = useState<Status>('idle');
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null);
  const [subscribers, setSubscribers] = useState<AgentSubscriber[]>([]);
  const [revenue, setRevenue] = useState<RevenueEntry[]>([]);
  const [requests, setRequests] = useState<SignalRequestLog[]>([]);
  const [signals, setSignals] = useState<SignalItem[]>([]);
  const [signalTier, setSignalTier] = useState<'free' | 'premium'>('free');
  const [signalType, setSignalType] = useState('all');
  const [wallet, setWallet] = useState<WalletInfo | null>(null);
  const [walletTxs, setWalletTxs] = useState<WalletTx[]>([]);
  const [withdrawals, setWithdrawals] = useState<WithdrawalReq[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const alertTimers = useRef<Record<string, number>>({});
  const [metrics, setMetrics] = useState({
    txAnalyzed: 0, signalsDetected: 0, activeSubscribers: 0, totalRevenueFet: 0,
  });
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [showWithdrawModal, setShowWithdrawModal] = useState(false);
  const [withdrawAddr, setWithdrawAddr] = useState('');
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [withdrawLoading, setWithdrawLoading] = useState(false);
  const [subscriberFilter, setSubscriberFilter] = useState<'all' | 'premium' | 'free' | 'active'>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const pushAlert = useCallback((type: Alert['type'], message: string) => {
    const id = `${Date.now()}-${Math.random()}`;
    setAlerts(prev => [...prev.slice(-9), { id, type, message }]);
    alertTimers.current[id] = window.setTimeout(() => {
      setAlerts(prev => prev.filter(a => a.id !== id));
      delete alertTimers.current[id];
    }, 6000);
  }, []);

  const copyToClipboard = (text: string, label?: string) => {
    navigator.clipboard.writeText(text).then(() => pushAlert('success', `${label || 'Copied'} to clipboard`));
  };

  const fetchAgentStatus = useCallback(async () => {
    try {
      const res = await fetch(`${SIGNAL_API}/status`);
      if (!res.ok) return;
      const data: AgentStatus = await res.json();
      setAgentStatus(data);
      setMetrics(prev => ({
        ...prev,
        activeSubscribers: data.active_subscribers,
        totalRevenueFet: parseFloat(data.total_revenue_fet) || 0,
      }));
    } catch { /* silent */ }
  }, []);

  const fetchSubscribers = useCallback(async () => {
    try {
      const res = await fetch(`${SIGNAL_API}/subscribers`);
      if (!res.ok) return;
      const data = await res.json();
      setSubscribers(data.subscribers || []);
    } catch { /* silent */ }
  }, []);

  const fetchRevenue = useCallback(async () => {
    try {
      const res = await fetch(`${SIGNAL_API}/revenue`);
      if (!res.ok) return;
      const data = await res.json();
      setRevenue(data.payments || []);
    } catch { /* silent */ }
  }, []);

  const fetchRequests = useCallback(async () => {
    try {
      const res = await fetch(`${SIGNAL_API}/requests`);
      if (!res.ok) return;
      const data = await res.json();
      setRequests(data.requests || []);
    } catch { /* silent */ }
  }, []);

  const fetchWallet = useCallback(async () => {
    try {
      const res = await fetch(`${SIGNAL_API}/wallet`);
      if (!res.ok) return;
      const data = await res.json();
      setWallet(data.wallet);
      setWalletTxs(data.transactions || []);
      setWithdrawals(data.withdrawals || []);
    } catch { /* silent */ }
  }, []);

  const fetchSignals = useCallback(async () => {
    try {
      const params = new URLSearchParams({ signal_type: signalType, tier: signalTier, max_results: '20' });
      const res = await fetch(`${SIGNAL_API}/signals?${params}`);
      if (!res.ok) return;
      const data = await res.json();
      setSignals(data.signals || []);
    } catch { /* silent */ }
  }, [signalType, signalTier]);

  const fetchMetrics = useCallback(async () => {
    const [txCountRes, reqCountRes] = await Promise.all([
      supabase.from('mempool_transactions').select('id', { count: 'exact', head: true }),
      supabase.from('signal_requests').select('id', { count: 'exact', head: true }),
    ]);
    setMetrics(prev => ({
      ...prev,
      txAnalyzed: txCountRes.count || 0,
      signalsDetected: reqCountRes.count || 0,
    }));
  }, []);

  useEffect(() => {
    fetchAgentStatus(); fetchSubscribers(); fetchRevenue(); fetchRequests(); fetchMetrics(); fetchWallet();
    const iv = setInterval(() => {
      fetchAgentStatus(); fetchSubscribers(); fetchRevenue(); fetchRequests(); fetchMetrics(); fetchWallet();
    }, 10000);
    return () => clearInterval(iv);
  }, [fetchAgentStatus, fetchSubscribers, fetchRevenue, fetchRequests, fetchMetrics, fetchWallet]);

  useEffect(() => {
    if (activeTab === 'signals') fetchSignals();
  }, [activeTab, fetchSignals]);

  const { feedStatus } = useMempoolMonitor({
    enabled: serviceStatus === 'running',
    minGasPrice: 5e9,
    onTransaction: async (tx, _chain, result) => {
      if (result.hasOpportunity) {
        pushAlert('success',
          `${result.dex}: ${result.functionName} — ${result.gasSaved.toLocaleString()} gas saved (${result.type.replace(/_/g, ' ')})`);
      }
      setMetrics(prev => ({
        ...prev,
        txAnalyzed: prev.txAnalyzed + 1,
        signalsDetected: prev.signalsDetected + (result.hasOpportunity ? 1 : 0),
      }));
    },
  });

  const startService = () => { setServiceStatus('running'); pushAlert('success', 'Mempool monitor started — collecting signals'); };
  const stopService = () => { setServiceStatus('paused'); pushAlert('warning', 'Mempool monitor paused'); };

  const handleWithdraw = async () => {
    if (!withdrawAddr || !withdrawAddr.startsWith('fetch1')) {
      pushAlert('error', 'Invalid address. Must start with fetch1 (Fetch.ai mainnet).');
      return;
    }
    const amount = parseFloat(withdrawAmount);
    if (!amount || amount <= 0) {
      pushAlert('error', 'Enter a valid amount greater than 0.');
      return;
    }
    setWithdrawLoading(true);
    try {
      const res = await fetch(`${SIGNAL_API}/withdraw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ destination_address: withdrawAddr, amount_fet: amount }),
      });
      const data = await res.json();
      if (!res.ok) {
        pushAlert('error', data.error || 'Withdrawal failed');
      } else {
        pushAlert('success', `Withdrawal of ${amount} FET queued. The agent will process it within 30 seconds.`);
        setShowWithdrawModal(false);
        setWithdrawAddr('');
        setWithdrawAmount('');
        fetchWallet();
      }
    } catch {
      pushAlert('error', 'Network error during withdrawal request');
    }
    setWithdrawLoading(false);
  };

  const tabs: { id: Tab; label: string; icon: React.ReactNode; badge?: number }[] = [
    { id: 'dashboard', label: 'Dashboard', icon: <BarChart3 className="w-4 h-4" /> },
    { id: 'wallet', label: 'Wallet', icon: <Wallet className="w-4 h-4" /> },
    { id: 'subscribers', label: 'Subscribers', icon: <Users className="w-4 h-4" />, badge: metrics.activeSubscribers },
    { id: 'revenue', label: 'Revenue', icon: <Coins className="w-4 h-4" /> },
    { id: 'signals', label: 'Signals', icon: <Signal className="w-4 h-4" /> },
    { id: 'agent', label: 'Agent Setup', icon: <Cpu className="w-4 h-4" /> },
    { id: 'settings', label: 'Settings', icon: <Settings className="w-4 h-4" /> },
  ];

  const totalRevenueFet = revenue
    .filter(r => r.status === 'confirmed')
    .reduce((sum, r) => sum + parseFloat(r.amount_fet?.toString() || '0'), 0);

  const premiumSubs = subscribers.filter(s => s.tier === 'premium').length;
  const freeSubs = subscribers.filter(s => s.tier === 'free').length;

  const filteredSubscribers = subscribers.filter(s => {
    if (subscriberFilter === 'premium' && s.tier !== 'premium') return false;
    if (subscriberFilter === 'free' && s.tier !== 'free') return false;
    if (subscriberFilter === 'active' && s.status !== 'active') return false;
    if (searchQuery && !s.subscriber_address.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    return true;
  });

  const walletBalance = wallet ? parseFloat(wallet.balance_fet?.toString() || '0') : 0;
  const agentOnline = agentStatus?.agent_online || false;

  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <header className="bg-slate-900/80 backdrop-blur-md border-b border-slate-800 sticky top-0 z-50">
        <div className="max-w-screen-2xl mx-auto px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-gradient-to-br from-emerald-500 to-cyan-500 rounded-lg flex items-center justify-center shrink-0">
                <Network className="w-6 h-6 text-white" />
              </div>
              <div>
                <h1 className="text-lg font-bold bg-gradient-to-r from-emerald-400 to-cyan-400 bg-clip-text text-transparent">
                  Mempool Signal Agent
                </h1>
                <p className="text-xs text-slate-500">Fetch.ai Agent Network | Autonomous Signal Marketplace</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 bg-slate-800 rounded-lg text-sm">
                {agentOnline ? <Wifi className="w-3.5 h-3.5 text-emerald-400" /> : <WifiOff className="w-3.5 h-3.5 text-slate-500" />}
                <span className="text-slate-400">Agent:</span>
                <span className={`font-mono font-semibold ${agentOnline ? 'text-emerald-400' : 'text-slate-500'}`}>
                  {agentOnline ? 'Online' : 'Offline'}
                </span>
              </div>
              <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 bg-slate-800 rounded-lg text-sm">
                <Wallet className="w-3.5 h-3.5 text-amber-400" />
                <span className="text-slate-400">Balance:</span>
                <span className="font-mono font-semibold text-amber-400">{walletBalance.toFixed(4)} FET</span>
              </div>
              <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 rounded-lg">
                <div className={`w-2 h-2 rounded-full ${
                  serviceStatus === 'running' ? 'bg-emerald-500 animate-pulse' :
                  serviceStatus === 'paused' ? 'bg-amber-500' : 'bg-slate-500'
                }`} />
                <span className="text-sm text-slate-300 capitalize">{serviceStatus}</span>
              </div>
              {serviceStatus === 'running' ? (
                <button onClick={stopService} className="px-4 py-2 bg-red-600 hover:bg-red-500 rounded-lg flex items-center gap-2 text-sm font-medium transition-colors">
                  <Pause className="w-4 h-4" /> Pause
                </button>
              ) : (
                <button onClick={startService} className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-lg flex items-center gap-2 text-sm font-medium transition-colors">
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
            alert.type === 'error' ? 'bg-red-900/95 border border-red-700' :
            'bg-cyan-900/95 border border-cyan-700'
          }`}>
            {alert.type === 'success' ? <CheckCircle className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" /> :
             alert.type === 'error' ? <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" /> :
             <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />}
            <span className="text-xs leading-relaxed">{alert.message}</span>
          </div>
        ))}
      </div>

      <div className="max-w-screen-2xl mx-auto px-4 py-6">
        <nav className="flex gap-2 mb-6 overflow-x-auto pb-2 scrollbar-hide">
          {tabs.map(tab => (
            <button key={tab.id} onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg whitespace-nowrap transition-all text-sm font-medium relative ${
                activeTab === tab.id ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-white'
              }`}>
              {tab.icon}{tab.label}
              {tab.badge !== undefined && tab.badge > 0 && (
                <span className="ml-1 px-1.5 py-0.5 bg-emerald-500/30 text-emerald-300 rounded text-xs font-mono">{tab.badge}</span>
              )}
            </button>
          ))}
        </nav>

        {/* DASHBOARD */}
        {activeTab === 'dashboard' && (
          <div className="space-y-6">
            {/* Agent Connection Banner */}
            <div className={`rounded-xl border p-4 flex items-center gap-4 ${
              agentOnline ? 'bg-emerald-900/30 border-emerald-700' : 'bg-amber-900/30 border-amber-700'
            }`}>
              {agentOnline ? (
                <div className="w-10 h-10 bg-emerald-600 rounded-lg flex items-center justify-center shrink-0">
                  <Wifi className="w-5 h-5 text-white" />
                </div>
              ) : (
                <div className="w-10 h-10 bg-amber-600 rounded-lg flex items-center justify-center shrink-0">
                  <WifiOff className="w-5 h-5 text-white" />
                </div>
              )}
              <div className="flex-1 min-w-0">
                <h3 className="text-sm font-semibold">
                  {agentOnline ? 'Agent Connected' : 'Agent Offline — Start the uAgent to connect'}
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  {agentOnline
                    ? `Last heartbeat: ${agentStatus?.last_heartbeat ? new Date(agentStatus.last_heartbeat).toLocaleTimeString() : 'unknown'}`
                    : 'The Python uAgent is not running. Go to Agent Setup to start it. The dashboard still works — signals are collected by the mempool monitor.'}
                </p>
              </div>
              {!agentOnline && (
                <button onClick={() => setActiveTab('agent')}
                  className="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 rounded-lg text-xs font-medium flex items-center gap-1.5 shrink-0">
                  <Power className="w-3.5 h-3.5" /> Start Agent
                </button>
              )}
            </div>

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <MetricCard icon={<Activity className="w-5 h-5" />} label="Signals Collected" value={metrics.txAnalyzed.toLocaleString()} subtitle="mempool txs analyzed" color="emerald" />
              <MetricCard icon={<Users className="w-5 h-5" />} label="Active Subscribers" value={metrics.activeSubscribers.toString()} subtitle={`${premiumSubs} premium, ${freeSubs} free`} color="cyan" />
              <MetricCard icon={<Coins className="w-5 h-5" />} label="Revenue (FET)" value={totalRevenueFet.toFixed(2)} subtitle="from agent payments" color="amber" />
              <MetricCard icon={<Wallet className="w-5 h-5" />} label="Wallet Balance" value={walletBalance.toFixed(4)} subtitle={`${wallet?.network || 'mainnet'} FET`} color="emerald" />
            </div>

            {/* Agent Network Status */}
            <div className="bg-slate-900 rounded-xl border border-slate-800 p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold flex items-center gap-2">
                  <Network className="w-5 h-5 text-cyan-400" /> Agent Network Status
                </h2>
                <button onClick={fetchAgentStatus} className="text-slate-400 hover:text-white"><RefreshCcw className="w-4 h-4" /></button>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="bg-slate-800/50 rounded-lg p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <Globe className="w-4 h-4 text-emerald-400" />
                    <span className="text-sm text-slate-400">Almanac Registration</span>
                  </div>
                  <p className="text-lg font-semibold">
                    {agentStatus?.almanac_registered ? (
                      <span className="text-emerald-400 flex items-center gap-1"><CheckCircle className="w-4 h-4" /> Registered</span>
                    ) : (
                      <span className="text-amber-400 flex items-center gap-1"><Clock className="w-4 h-4" /> Pending</span>
                    )}
                  </p>
                  <p className="text-xs text-slate-500 mt-1">Auto-discovery by other agents</p>
                </div>
                <div className="bg-slate-800/50 rounded-lg p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <Cpu className="w-4 h-4 text-cyan-400" />
                    <span className="text-sm text-slate-400">Agent Address</span>
                  </div>
                  <p className="text-sm font-mono text-cyan-300 truncate">
                    {agentStatus?.agent_address && agentStatus.agent_address !== 'pending_registration'
                      ? agentStatus.agent_address : 'Awaiting registration...'}
                  </p>
                </div>
                <div className="bg-slate-800/50 rounded-lg p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <Wallet className="w-4 h-4 text-amber-400" />
                    <span className="text-sm text-slate-400">Wallet Address</span>
                  </div>
                  <p className="text-sm font-mono text-amber-300 truncate">
                    {agentStatus?.wallet_address || 'Not initialized'}
                  </p>
                  {agentStatus?.wallet_address && (
                    <button onClick={() => copyToClipboard(agentStatus.wallet_address, 'Wallet address')}
                      className="text-xs text-slate-500 hover:text-white flex items-center gap-1 mt-1">
                      <Copy className="w-3 h-3" /> Copy
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* Recent Activity */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="bg-slate-900 rounded-xl border border-slate-800 p-6">
                <h3 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2">
                  <Activity className="w-4 h-4 text-emerald-400" /> Recent Signal Queries
                </h3>
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {requests.length === 0 ? (
                    <p className="text-sm text-slate-500 text-center py-8">No agent queries yet. Start the monitor to collect signals.</p>
                  ) : requests.slice(0, 10).map(req => (
                    <div key={req.id} className="flex items-center justify-between bg-slate-800/50 rounded-lg px-3 py-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                          req.tier === 'premium' ? 'bg-amber-900/60 text-amber-300' : 'bg-slate-700 text-slate-400'
                        }`}>{req.tier}</span>
                        <span className="text-xs text-slate-400 truncate">{req.signal_type}</span>
                      </div>
                      <div className="flex items-center gap-3 text-xs">
                        <span className="text-slate-500">{req.result_count} results</span>
                        <span className="text-slate-500">{req.latency_ms}ms</span>
                        <span className={req.payment_status === 'paid' ? 'text-emerald-400' : 'text-slate-500'}>
                          {req.payment_status === 'paid' ? `${req.payment_amount} FET` : req.payment_status}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="bg-slate-900 rounded-xl border border-slate-800 p-6">
                <h3 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2">
                  <Coins className="w-4 h-4 text-amber-400" /> Recent Payments
                </h3>
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {revenue.length === 0 ? (
                    <p className="text-sm text-slate-500 text-center py-8">No payments yet. Revenue appears when agents query premium signals.</p>
                  ) : revenue.slice(0, 10).map(entry => (
                    <div key={entry.id} className="flex items-center justify-between bg-slate-800/50 rounded-lg px-3 py-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <ArrowDownToLine className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                        <span className="text-xs font-mono text-slate-400 truncate">{entry.subscriber_address.slice(0, 16)}...</span>
                      </div>
                      <div className="flex items-center gap-3 text-xs">
                        <span className="text-emerald-400 font-semibold">+{parseFloat(entry.amount_fet?.toString() || '0').toFixed(2)} FET</span>
                        <span className="text-slate-500">{new Date(entry.created_at).toLocaleTimeString()}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* WALLET */}
        {activeTab === 'wallet' && (
          <div className="space-y-6">
            {/* Wallet Balance Card */}
            <div className="bg-gradient-to-br from-slate-900 to-slate-800 rounded-xl border border-slate-800 p-6">
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-lg font-semibold flex items-center gap-2">
                  <Wallet className="w-5 h-5 text-amber-400" /> Agent Wallet
                </h2>
                <div className="flex items-center gap-2">
                  <span className={`px-2 py-1 rounded text-xs font-medium ${agentOnline ? 'bg-emerald-900/60 text-emerald-300' : 'bg-slate-700 text-slate-400'}`}>
                    {agentOnline ? 'Connected' : 'Disconnected'}
                  </span>
                  <button onClick={fetchWallet} className="text-slate-400 hover:text-white"><RefreshCcw className="w-4 h-4" /></button>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <p className="text-xs text-slate-400 uppercase tracking-wide mb-1">Wallet Address</p>
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-mono text-amber-300 truncate">{wallet?.wallet_address || 'Not initialized — start the uAgent'}</p>
                    {wallet?.wallet_address && (
                      <button onClick={() => copyToClipboard(wallet.wallet_address, 'Address')} className="text-slate-400 hover:text-white shrink-0">
                        <Copy className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                  <p className="text-xs text-slate-500 mt-2">
                    Send FET from any exchange (Coinbase, Binance) to this address on the Fetch.ai mainnet.
                    This is your seed capital — real tokens, not testnet.
                  </p>
                </div>
                <div>
                  <p className="text-xs text-slate-400 uppercase tracking-wide mb-1">Balance</p>
                  <p className="text-3xl font-bold text-amber-400">{walletBalance.toFixed(4)} <span className="text-lg text-slate-400">FET</span></p>
                  <p className="text-xs text-slate-500 mt-1">
                    {wallet?.balance_updated_at ? `Updated ${new Date(wallet.balance_updated_at).toLocaleTimeString()}` : 'Not synced'}
                    {' | '}Network: {wallet?.network || 'mainnet'}
                  </p>
                </div>
              </div>

              <div className="flex gap-3 mt-6">
                <button onClick={() => copyToClipboard(wallet?.wallet_address || '', 'Deposit address')}
                  disabled={!wallet?.wallet_address}
                  className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 disabled:text-slate-500 rounded-lg flex items-center gap-2 text-sm font-medium transition-colors">
                  <ArrowDownToLine className="w-4 h-4" /> Copy Deposit Address
                </button>
                <button onClick={() => setShowWithdrawModal(true)}
                  disabled={!wallet || walletBalance <= 0}
                  className="px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:bg-slate-700 disabled:text-slate-500 rounded-lg flex items-center gap-2 text-sm font-medium transition-colors">
                  <ArrowUpFromLine className="w-4 h-4" /> Withdraw FET
                </button>
              </div>
            </div>

            {/* Deposit Instructions */}
            <div className="bg-slate-900 rounded-xl border border-slate-800 p-6">
              <h3 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2">
                <ArrowDownToLine className="w-4 h-4 text-emerald-400" /> How to Deposit FET (Seed Capital)
              </h3>
              <div className="space-y-3">
                <div className="flex gap-3">
                  <span className="w-6 h-6 rounded-full bg-emerald-600 flex items-center justify-center text-xs font-bold shrink-0">1</span>
                  <p className="text-sm text-slate-400">Buy FET on an exchange — <a href="https://www.coinbase.com/price/fetch-ai" target="_blank" rel="noopener noreferrer" className="text-cyan-400 hover:underline">Coinbase</a> or <a href="https://www.binance.com/en/trade/FET_USDT" target="_blank" rel="noopener noreferrer" className="text-cyan-400 hover:underline">Binance</a> support it.</p>
                </div>
                <div className="flex gap-3">
                  <span className="w-6 h-6 rounded-full bg-emerald-600 flex items-center justify-center text-xs font-bold shrink-0">2</span>
                  <p className="text-sm text-slate-400">Withdraw FET to the Fetch.ai mainnet (not ERC-20). Select "Fetch.ai" as the network.</p>
                </div>
                <div className="flex gap-3">
                  <span className="w-6 h-6 rounded-full bg-emerald-600 flex items-center justify-center text-xs font-bold shrink-0">3</span>
                  <p className="text-sm text-slate-400">Paste your agent's wallet address: <code className="text-amber-300 font-mono text-xs">{wallet?.wallet_address || 'fetch1...'}</code></p>
                </div>
                <div className="flex gap-3">
                  <span className="w-6 h-6 rounded-full bg-emerald-600 flex items-center justify-center text-xs font-bold shrink-0">4</span>
                  <p className="text-sm text-slate-400">The agent needs a small amount (~1 FET) for Almanac registration gas. The rest is revenue you can withdraw.</p>
                </div>
              </div>
              <div className="mt-4 p-3 bg-amber-900/30 border border-amber-700/50 rounded-lg">
                <p className="text-xs text-amber-300 flex items-start gap-2">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  If your exchange only supports ERC-20 FET, use the <a href="https://token-bridge.fetch.ai/" target="_blank" rel="noopener noreferrer" className="text-cyan-400 hover:underline">Fetch.ai Token Bridge</a> to convert to native FET.
                </p>
              </div>
            </div>

            {/* Wallet Transactions */}
            <div className="bg-slate-900 rounded-xl border border-slate-800 overflow-hidden">
              <div className="p-4 border-b border-slate-800">
                <h3 className="text-sm font-semibold text-slate-300">Wallet Transactions</h3>
              </div>
              {walletTxs.length === 0 ? (
                <p className="text-sm text-slate-500 text-center py-12">No transactions yet. Deposits and withdrawals will appear here.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-800/50 text-slate-400 text-xs uppercase">
                      <tr>
                        <th className="px-4 py-3 text-left">Type</th>
                        <th className="px-4 py-3 text-left">From/To</th>
                        <th className="px-4 py-3 text-right">Amount</th>
                        <th className="px-4 py-3 text-left">Tx Hash</th>
                        <th className="px-4 py-3 text-left">Status</th>
                        <th className="px-4 py-3 text-left">Date</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800">
                      {walletTxs.map(tx => (
                        <tr key={tx.id} className="hover:bg-slate-800/30 transition-colors">
                          <td className="px-4 py-3">
                            <span className={`flex items-center gap-1.5 text-xs font-medium ${
                              tx.direction === 'deposit' ? 'text-emerald-400' : 'text-amber-400'
                            }`}>
                              {tx.direction === 'deposit' ? <ArrowDownToLine className="w-3.5 h-3.5" /> : <ArrowUpFromLine className="w-3.5 h-3.5" />}
                              {tx.direction}
                            </span>
                          </td>
                          <td className="px-4 py-3 font-mono text-xs text-slate-400 truncate max-w-32">{tx.counterparty_address}</td>
                          <td className={`px-4 py-3 text-right font-mono font-semibold ${tx.direction === 'deposit' ? 'text-emerald-400' : 'text-amber-400'}`}>
                            {tx.direction === 'deposit' ? '+' : '-'}{parseFloat(tx.amount_fet?.toString() || '0').toFixed(4)}
                          </td>
                          <td className="px-4 py-3 font-mono text-xs text-slate-500">{tx.tx_hash ? tx.tx_hash.slice(0, 18) + '...' : '-'}</td>
                          <td className="px-4 py-3"><span className="text-xs text-emerald-400">{tx.status}</span></td>
                          <td className="px-4 py-3 text-xs text-slate-500">{new Date(tx.created_at).toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Withdrawal History */}
            {withdrawals.length > 0 && (
              <div className="bg-slate-900 rounded-xl border border-slate-800 overflow-hidden">
                <div className="p-4 border-b border-slate-800">
                  <h3 className="text-sm font-semibold text-slate-300">Withdrawal Requests</h3>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-800/50 text-slate-400 text-xs uppercase">
                      <tr>
                        <th className="px-4 py-3 text-left">Destination</th>
                        <th className="px-4 py-3 text-right">Amount</th>
                        <th className="px-4 py-3 text-left">Status</th>
                        <th className="px-4 py-3 text-left">Tx Hash</th>
                        <th className="px-4 py-3 text-left">Requested</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800">
                      {withdrawals.map(w => (
                        <tr key={w.id} className="hover:bg-slate-800/30 transition-colors">
                          <td className="px-4 py-3 font-mono text-xs text-slate-400 truncate max-w-32">{w.destination_address}</td>
                          <td className="px-4 py-3 text-right font-mono text-amber-400">{parseFloat(w.amount_fet?.toString() || '0').toFixed(4)} FET</td>
                          <td className="px-4 py-3">
                            <span className={`text-xs ${w.status === 'completed' ? 'text-emerald-400' : w.status === 'failed' ? 'text-red-400' : 'text-amber-400'}`}>
                              {w.status}
                            </span>
                          </td>
                          <td className="px-4 py-3 font-mono text-xs text-slate-500">{w.tx_hash ? w.tx_hash.slice(0, 18) + '...' : '-'}</td>
                          <td className="px-4 py-3 text-xs text-slate-500">{new Date(w.requested_at).toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {/* SUBSCRIBERS */}
        {activeTab === 'subscribers' && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <MetricCard icon={<Users className="w-5 h-5" />} label="Total Subscribers" value={subscribers.length.toString()} color="cyan" />
              <MetricCard icon={<TrendingUp className="w-5 h-5" />} label="Premium Tier" value={premiumSubs.toString()} subtitle="paying 0.5 FET/query" color="amber" />
              <MetricCard icon={<Globe className="w-5 h-5" />} label="Free Tier" value={freeSubs.toString()} subtitle="5-min delayed signals" color="emerald" />
              <MetricCard icon={<Activity className="w-5 h-5" />} label="Total Queries" value={subscribers.reduce((s, sub) => s + (sub.total_queries || 0), 0).toString()} color="cyan" />
            </div>

            <div className="bg-slate-900 rounded-xl border border-slate-800 overflow-hidden">
              <div className="p-4 border-b border-slate-800">
                <div className="flex items-center justify-between flex-wrap gap-3">
                  <h2 className="text-lg font-semibold">Agent Subscribers</h2>
                  <div className="flex items-center gap-2">
                    <div className="relative">
                      <Search className="w-4 h-4 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
                      <input
                        value={searchQuery}
                        onChange={e => setSearchQuery(e.target.value)}
                        placeholder="Search address..."
                        className="bg-slate-800 text-sm rounded-lg pl-8 pr-3 py-1.5 border border-slate-700 focus:border-emerald-500 outline-none w-40"
                      />
                    </div>
                    <div className="flex gap-1">
                      {(['all', 'premium', 'free', 'active'] as const).map(f => (
                        <button key={f} onClick={() => setSubscriberFilter(f)}
                          className={`px-3 py-1.5 rounded-lg text-xs font-medium capitalize transition-colors ${
                            subscriberFilter === f ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                          }`}>{f}</button>
                      ))}
                    </div>
                    <button onClick={fetchSubscribers} className="text-slate-400 hover:text-white"><RefreshCcw className="w-4 h-4" /></button>
                  </div>
                </div>
              </div>
              {filteredSubscribers.length === 0 ? (
                <p className="text-sm text-slate-500 text-center py-16">
                  No subscribers yet. Agents discover this service via the Fetch.ai Almanac registry.
                  <br />Start the mempool monitor to collect signals, then run the uAgent to register on the network.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-800/50 text-slate-400 text-xs uppercase">
                      <tr>
                        <th className="px-4 py-3 text-left">Agent Address</th>
                        <th className="px-4 py-3 text-left">Tier</th>
                        <th className="px-4 py-3 text-left">Status</th>
                        <th className="px-4 py-3 text-right">Queries</th>
                        <th className="px-4 py-3 text-right">Total Paid (FET)</th>
                        <th className="px-4 py-3 text-left">Joined</th>
                        <th className="px-4 py-3 text-left">Last Query</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800">
                      {filteredSubscribers.map(sub => (
                        <tr key={sub.id} className="hover:bg-slate-800/30 transition-colors">
                          <td className="px-4 py-3 font-mono text-xs text-cyan-300">{sub.subscriber_address}</td>
                          <td className="px-4 py-3">
                            <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                              sub.tier === 'premium' ? 'bg-amber-900/60 text-amber-300' : 'bg-slate-700 text-slate-400'
                            }`}>{sub.tier}</span>
                          </td>
                          <td className="px-4 py-3">
                            <span className={`flex items-center gap-1 text-xs ${sub.status === 'active' ? 'text-emerald-400' : 'text-slate-500'}`}>
                              <div className={`w-1.5 h-1.5 rounded-full ${sub.status === 'active' ? 'bg-emerald-500' : 'bg-slate-600'}`} />
                              {sub.status}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-right font-mono">{sub.total_queries}</td>
                          <td className="px-4 py-3 text-right font-mono text-emerald-400">{parseFloat(sub.total_fet_paid?.toString() || '0').toFixed(2)}</td>
                          <td className="px-4 py-3 text-xs text-slate-500">{new Date(sub.joined_at).toLocaleDateString()}</td>
                          <td className="px-4 py-3 text-xs text-slate-500">{sub.last_query_at ? new Date(sub.last_query_at).toLocaleString() : '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {/* REVENUE */}
        {activeTab === 'revenue' && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <MetricCard icon={<Coins className="w-5 h-5" />} label="Total Revenue" value={totalRevenueFet.toFixed(2)} subtitle="FET tokens" color="emerald" />
              <MetricCard icon={<CheckCircle className="w-5 h-5" />} label="Confirmed Payments" value={revenue.filter(r => r.status === 'confirmed').length.toString()} color="cyan" />
              <MetricCard icon={<Clock className="w-5 h-5" />} label="Pending" value={revenue.filter(r => r.status === 'pending').length.toString()} color="amber" />
              <MetricCard icon={<TrendingUp className="w-5 h-5" />} label="Avg per Query" value={(totalRevenueFet / Math.max(1, revenue.length)).toFixed(3)} subtitle="FET" color="emerald" />
            </div>
            <div className="bg-slate-900 rounded-xl border border-slate-800 overflow-hidden">
              <div className="p-4 border-b border-slate-800 flex items-center justify-between">
                <h2 className="text-lg font-semibold">Payment Ledger</h2>
                <button onClick={fetchRevenue} className="text-slate-400 hover:text-white"><RefreshCcw className="w-4 h-4" /></button>
              </div>
              {revenue.length === 0 ? (
                <p className="text-sm text-slate-500 text-center py-16">
                  No payments yet. Revenue is generated when agents query premium-tier signals.
                  <br />Each premium query costs 0.5 FET, settled on the Fetch.ai chain.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-800/50 text-slate-400 text-xs uppercase">
                      <tr>
                        <th className="px-4 py-3 text-left">From Agent</th>
                        <th className="px-4 py-3 text-right">Amount (FET)</th>
                        <th className="px-4 py-3 text-left">Status</th>
                        <th className="px-4 py-3 text-left">Tx Hash</th>
                        <th className="px-4 py-3 text-left">Date</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800">
                      {revenue.map(entry => (
                        <tr key={entry.id} className="hover:bg-slate-800/30 transition-colors">
                          <td className="px-4 py-3 font-mono text-xs text-cyan-300">{entry.subscriber_address.slice(0, 20)}...</td>
                          <td className="px-4 py-3 text-right font-mono text-emerald-400 font-semibold">+{parseFloat(entry.amount_fet?.toString() || '0').toFixed(4)}</td>
                          <td className="px-4 py-3"><span className={`text-xs ${entry.status === 'confirmed' ? 'text-emerald-400' : 'text-amber-400'}`}>{entry.status}</span></td>
                          <td className="px-4 py-3 font-mono text-xs text-slate-500">{entry.tx_hash ? entry.tx_hash.slice(0, 18) + '...' : '-'}</td>
                          <td className="px-4 py-3 text-xs text-slate-500">{new Date(entry.created_at).toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {/* SIGNALS */}
        {activeTab === 'signals' && (
          <div className="space-y-6">
            <div className="bg-slate-900 rounded-xl border border-slate-800 p-4">
              <div className="flex flex-wrap items-center gap-4">
                <div className="flex items-center gap-2">
                  <Filter className="w-4 h-4 text-slate-400" />
                  <label className="text-sm text-slate-400">Type:</label>
                  <select value={signalType} onChange={e => setSignalType(e.target.value)}
                    className="bg-slate-800 text-sm rounded-lg px-3 py-1.5 border border-slate-700 focus:border-emerald-500 outline-none">
                    <option value="all">All Signals</option>
                    <option value="gas_overpayment">Gas Overpayment</option>
                    <option value="route_inefficiency">Route Inefficiency</option>
                    <option value="dex_swap">DEX Swaps</option>
                  </select>
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-sm text-slate-400">Tier:</label>
                  <select value={signalTier} onChange={e => setSignalTier(e.target.value as 'free' | 'premium')}
                    className="bg-slate-800 text-sm rounded-lg px-3 py-1.5 border border-slate-700 focus:border-emerald-500 outline-none">
                    <option value="free">Free (5-min delay)</option>
                    <option value="premium">Premium (real-time)</option>
                  </select>
                </div>
                <button onClick={fetchSignals} className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-sm font-medium flex items-center gap-2">
                  <RefreshCcw className="w-3.5 h-3.5" /> Refresh
                </button>
                <div className="ml-auto text-sm text-slate-400">
                  {signals.length} signals | {signalTier === 'premium' ? '0.5 FET/query' : 'Free'}
                </div>
              </div>
            </div>
            <div className="bg-slate-900 rounded-xl border border-slate-800 overflow-hidden">
              {signals.length === 0 ? (
                <p className="text-sm text-slate-500 text-center py-16">
                  No signals available. Start the mempool monitor to collect data.
                  {signalTier === 'free' && ' Free tier shows signals older than 5 minutes.'}
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-800/50 text-slate-400 text-xs uppercase">
                      <tr>
                        <th className="px-4 py-3 text-left">TX Hash</th>
                        <th className="px-4 py-3 text-left">DEX</th>
                        <th className="px-4 py-3 text-left">Signal Type</th>
                        <th className="px-4 py-3 text-right">Gas Price</th>
                        <th className="px-4 py-3 text-right">Gas Saved</th>
                        <th className="px-4 py-3 text-right">Confidence</th>
                        <th className="px-4 py-3 text-left">Detected</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800">
                      {signals.map((sig, i) => (
                        <tr key={`${sig.tx_hash}-${i}`}
                          onClick={() => setExpandedRow(expandedRow === `${sig.tx_hash}-${i}` ? null : `${sig.tx_hash}-${i}`)}
                          className="hover:bg-slate-800/30 transition-colors cursor-pointer">
                          <td className="px-4 py-3 font-mono text-xs text-cyan-300">{sig.tx_hash.slice(0, 18)}...</td>
                          <td className="px-4 py-3 text-xs">{sig.dex || '-'}</td>
                          <td className="px-4 py-3">
                            <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                              sig.signal_type === 'gas_reduction' ? 'bg-amber-900/60 text-amber-300' :
                              sig.signal_type === 'route_optimization' ? 'bg-cyan-900/60 text-cyan-300' :
                              'bg-slate-700 text-slate-400'
                            }`}>{sig.signal_type.replace(/_/g, ' ')}</span>
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-xs">{sig.gas_price_gwei} GWEI</td>
                          <td className="px-4 py-3 text-right font-mono text-emerald-400">{sig.gas_saved.toLocaleString()}</td>
                          <td className="px-4 py-3 text-right">
                            <span className={`font-mono text-xs ${(sig.confidence * 100) > 85 ? 'text-emerald-400' : 'text-amber-400'}`}>
                              {(sig.confidence * 100).toFixed(0)}%
                            </span>
                          </td>
                          <td className="px-4 py-3 text-xs text-slate-500">{sig.detected_at ? new Date(sig.detected_at).toLocaleTimeString() : '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {/* AGENT SETUP */}
        {activeTab === 'agent' && (
          <div className="space-y-6">
            <div className="bg-slate-900 rounded-xl border border-slate-800 p-6">
              <h2 className="text-lg font-semibold mb-2 flex items-center gap-2">
                <Cpu className="w-5 h-5 text-cyan-400" /> Fetch.ai uAgent Setup
              </h2>
              <p className="text-sm text-slate-400 mb-6">
                This agent registers on the Fetch.ai Almanac contract, making it discoverable by other autonomous agents on the network.
                Agents query it for Polygon mempool signals and pay in FET tokens. No marketing needed — discovery is automatic.
              </p>

              <div className="space-y-4">
                <StepCard step={1} title="Install the uAgents framework and cosmpy">
                  <pre className="bg-slate-950 rounded-lg p-3 text-xs font-mono text-slate-300 overflow-x-auto">pip install uagents cosmpy</pre>
                </StepCard>

                <StepCard step={2} title="Generate the agent .env file">
                  <pre className="bg-slate-950 rounded-lg p-3 text-xs font-mono text-slate-300 overflow-x-auto">python agent/generate_env.py</pre>
                  <p className="text-xs text-slate-500 mt-2">
                    This reads your project's <code className="text-slate-400">.env</code> and creates <code className="text-slate-400">agent/.env</code> automatically.
                  </p>
                </StepCard>

                <StepCard step={3} title="Run the agent">
                  <pre className="bg-slate-950 rounded-lg p-3 text-xs font-mono text-slate-300 overflow-x-auto">{`cd agent
source .env
python mempool_signal_agent.py`}</pre>
                  <p className="text-xs text-slate-500 mt-2">
                    The agent will generate a wallet, register on the Almanac, and start listening for queries.
                    On testnet, registration is free. For mainnet, fund the wallet with FET (see Wallet tab).
                  </p>
                </StepCard>

                <StepCard step={4} title="Fund the wallet with real FET (mainnet seed capital)">
                  <p className="text-sm text-slate-400 mb-2">
                    Buy FET on <a href="https://www.coinbase.com/price/fetch-ai" target="_blank" rel="noopener noreferrer" className="text-cyan-400 hover:underline">Coinbase</a> or <a href="https://www.binance.com/en/trade/FET_USDT" target="_blank" rel="noopener noreferrer" className="text-cyan-400 hover:underline">Binance</a>,
                    then withdraw to your agent's wallet address (shown in the Wallet tab).
                    Select <strong className="text-slate-300">Fetch.ai mainnet</strong> as the withdrawal network — not ERC-20.
                  </p>
                  <p className="text-xs text-slate-500">
                    The agent needs ~1 FET for Almanac registration gas. The rest accumulates as revenue from agent queries.
                    If your exchange only has ERC-20 FET, use the <a href="https://token-bridge.fetch.ai/" target="_blank" rel="noopener noreferrer" className="text-cyan-400 hover:underline">Fetch.ai Token Bridge</a>.
                  </p>
                </StepCard>

                <StepCard step={5} title="Agents discover you automatically">
                  <p className="text-sm text-slate-400">
                    Other agents on the Fetch.ai network search the Almanac by capability. Your agent is registered with
                    capabilities: <span className="text-cyan-300 font-mono text-xs">gas_overpayment, route_inefficiency, dex_swap</span>.
                    When an agent needs Polygon mempool data, it finds your agent and sends a query.
                  </p>
                </StepCard>

                <StepCard step={6} title="Revenue flows automatically">
                  <p className="text-sm text-slate-400">
                    Free-tier queries (5-min delayed signals) cost nothing and attract agents to try the service.
                    Premium queries (real-time signals) cost 0.5 FET each, settled on the Fetch.ai chain.
                    Revenue appears in the Revenue tab. Withdraw anytime from the Wallet tab.
                  </p>
                </StepCard>
              </div>
            </div>

            {/* API Reference */}
            <div className="bg-slate-900 rounded-xl border border-slate-800 p-6">
              <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                <Database className="w-5 h-5 text-emerald-400" /> Signal API Endpoints
              </h3>
              <p className="text-sm text-slate-400 mb-4">
                The edge function provides an HTTP bridge for agents that prefer REST over the uAgents messaging protocol.
              </p>
              <div className="space-y-2">
                {[
                  { method: 'GET', path: '/status', desc: 'Agent service status, wallet, and capabilities' },
                  { method: 'GET', path: '/wallet', desc: 'Wallet details, transactions, and withdrawals' },
                  { method: 'GET', path: '/signals?signal_type=all&tier=free', desc: 'Fetch signals (free or premium tier)' },
                  { method: 'GET', path: '/subscribers', desc: 'List all agent subscribers' },
                  { method: 'GET', path: '/revenue', desc: 'Revenue ledger' },
                  { method: 'GET', path: '/requests', desc: 'Recent signal requests' },
                  { method: 'POST', path: '/', desc: 'Query signals (body: signal_type, tier, subscriber_address, payment_ref)' },
                  { method: 'POST', path: '/withdraw', desc: 'Create withdrawal request (body: destination_address, amount_fet)' },
                ].map(ep => (
                  <div key={ep.path} className="flex items-center gap-3 bg-slate-800/50 rounded-lg px-3 py-2">
                    <span className={`px-2 py-0.5 rounded text-xs font-mono font-bold ${
                      ep.method === 'GET' ? 'bg-emerald-900/60 text-emerald-300' : 'bg-cyan-900/60 text-cyan-300'
                    }`}>{ep.method}</span>
                    <code className="text-xs text-slate-300 font-mono flex-1">{ep.path}</code>
                    <span className="text-xs text-slate-500 hidden md:block">{ep.desc}</span>
                  </div>
                ))}
              </div>
              <div className="mt-4 flex items-center gap-2">
                <code className="text-xs text-slate-400 font-mono flex-1 truncate">{SIGNAL_API}</code>
                <button onClick={() => copyToClipboard(SIGNAL_API, 'API URL')} className="text-slate-400 hover:text-white"><Copy className="w-4 h-4" /></button>
                <a href={SIGNAL_API} target="_blank" rel="noopener noreferrer" className="text-slate-400 hover:text-white"><ExternalLink className="w-4 h-4" /></a>
              </div>
            </div>
          </div>
        )}

        {/* SETTINGS */}
        {activeTab === 'settings' && (
          <div className="space-y-6">
            <div className="bg-slate-900 rounded-xl border border-slate-800 p-6">
              <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
                <Settings className="w-5 h-5 text-slate-400" /> Service Configuration
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <ConfigItem label="Agent Name" value="Polygon Mempool Signal Agent" />
                <ConfigItem label="Network" value={wallet?.network || 'mainnet'} />
                <ConfigItem label="Free Tier Delay" value="5 minutes" />
                <ConfigItem label="Free Tier Max Results" value="10 per query" />
                <ConfigItem label="Premium Price" value="0.5 FET per query" />
                <ConfigItem label="Premium Max Results" value="100 per query" />
                <ConfigItem label="Signal Source" value="Polygon mempool (live)" />
                <ConfigItem label="Discovery" value="Almanac auto-registration" />
              </div>
            </div>

            <div className="bg-slate-900 rounded-xl border border-slate-800 p-6">
              <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                <Radio className="w-5 h-5 text-cyan-400" /> Mempool Feed Status
              </h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <ConfigItem label="Primary Feed" value={feedStatus.primary} />
                <ConfigItem label="Secondary Feed" value={feedStatus.secondary} />
                <ConfigItem label="TX/min" value={feedStatus.txPerMin.toString()} />
                <ConfigItem label="Active RPC" value={feedStatus.activeRpc} />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Withdraw Modal */}
      {showWithdrawModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowWithdrawModal(false)}>
          <div className="bg-slate-900 rounded-xl border border-slate-700 p-6 max-w-md w-full" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <ArrowUpFromLine className="w-5 h-5 text-amber-400" /> Withdraw FET
            </h3>
            <div className="space-y-4">
              <div>
                <label className="text-sm text-slate-400 mb-1 block">Destination Address</label>
                <input
                  value={withdrawAddr}
                  onChange={e => setWithdrawAddr(e.target.value)}
                  placeholder="fetch1..."
                  className="w-full bg-slate-800 rounded-lg px-3 py-2 text-sm font-mono border border-slate-700 focus:border-amber-500 outline-none"
                />
                <p className="text-xs text-slate-500 mt-1">Must be a Fetch.ai mainnet address (starts with fetch1)</p>
              </div>
              <div>
                <label className="text-sm text-slate-400 mb-1 block">Amount (FET)</label>
                <input
                  type="number"
                  value={withdrawAmount}
                  onChange={e => setWithdrawAmount(e.target.value)}
                  placeholder="0.0"
                  max={walletBalance}
                  step="0.0001"
                  className="w-full bg-slate-800 rounded-lg px-3 py-2 text-sm font-mono border border-slate-700 focus:border-amber-500 outline-none"
                />
                <p className="text-xs text-slate-500 mt-1">Available: {walletBalance.toFixed(4)} FET</p>
              </div>
              <div className="flex gap-3">
                <button onClick={() => setShowWithdrawModal(false)}
                  className="flex-1 px-4 py-2 bg-slate-800 hover:bg-slate-700 rounded-lg text-sm font-medium">
                  Cancel
                </button>
                <button onClick={handleWithdraw} disabled={withdrawLoading}
                  className="flex-1 px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:bg-slate-700 rounded-lg text-sm font-medium flex items-center justify-center gap-2">
                  {withdrawLoading ? <RefreshCcw className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                  {withdrawLoading ? 'Processing...' : 'Withdraw'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function MetricCard({ icon, label, value, subtitle, color }: {
  icon: React.ReactNode; label: string; value: string; subtitle?: string; color: string;
}) {
  const colorMap: Record<string, string> = {
    emerald: 'text-emerald-400 bg-emerald-900/30',
    cyan: 'text-cyan-400 bg-cyan-900/30',
    amber: 'text-amber-400 bg-amber-900/30',
  };
  return (
    <div className="bg-slate-900 rounded-xl border border-slate-800 p-5">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs text-slate-400 uppercase tracking-wide">{label}</span>
        <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${colorMap[color] || colorMap.emerald}`}>{icon}</div>
      </div>
      <p className="text-2xl font-bold">{value}</p>
      {subtitle && <p className="text-xs text-slate-500 mt-1">{subtitle}</p>}
    </div>
  );
}

function StepCard({ step, title, children }: { step: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-4">
      <div className="w-8 h-8 rounded-full bg-emerald-600 flex items-center justify-center text-sm font-bold shrink-0">{step}</div>
      <div className="flex-1 min-w-0">
        <h4 className="text-sm font-semibold text-slate-200 mb-2">{title}</h4>
        {children}
      </div>
    </div>
  );
}

function ConfigItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-slate-800/50 rounded-lg p-3">
      <p className="text-xs text-slate-400 mb-1">{label}</p>
      <p className="text-sm font-mono text-slate-200 truncate">{value}</p>
    </div>
  );
}

export default App;
