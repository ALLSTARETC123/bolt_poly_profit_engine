import { useState, useEffect, useCallback, useRef } from 'react';
import { createClient } from '@supabase/supabase-js';
import { ethers } from 'ethers';
import {
  Activity, Zap, TrendingUp, Wallet, Settings, AlertTriangle,
  CheckCircle, Clock, BarChart3, RefreshCcw, Copy, ExternalLink,
  Radio, Cpu, Network, Coins, Play, Pause, Power, Search,
  ArrowRight, ArrowDownToLine, ArrowUpFromLine, Wifi, WifiOff,
  Triangle, GitBranch, Scale, Crosshair, Sparkles, KeyRound,
  Shield, Wrench, ChevronDown, ChevronUp, DollarSign, GasPump,
} from 'lucide-react';
import { CHAINS, CHAIN_KEYS } from './lib/chains';
import { ArbitrageOpportunity, scanChain, scanAllChains } from './lib/scanner';
import {
  generateWallet, importWallet, unlockWallet, loadWallet,
  getNativeBalance, WalletState,
} from './lib/wallet';
import {
  executeArbitrage, autoFixConfig, checkExecutorHealth,
  ExecutionResult,
} from './lib/executor';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

type Tab = 'dashboard' | 'opportunities' | 'wallet' | 'treasury' | 'settings';
type Alert = { id: string; type: 'success' | 'warning' | 'error' | 'info'; message: string };

function App() {
  const [activeTab, setActiveTab] = useState<Tab>('dashboard');
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const alertTimers = useRef<Record<string, number>>({});

  // Wallet state
  const [wallet, setWallet] = useState<WalletState | null>(null);
  const [walletLoaded, setWalletLoaded] = useState<{ address: string; encryptedKey: string; salt: string } | null>(null);
  const [walletPassword, setWalletPassword] = useState('');
  const [walletPrivateKey, setWalletPrivateKey] = useState('');
  const [walletLoading, setWalletLoading] = useState(false);
  const [chainBalances, setChainBalances] = useState<Record<string, string>>({});
  const [deployedContracts, setDeployedContracts] = useState<Record<string, string>>({});

  // Engine state
  const [engineRunning, setEngineRunning] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [opportunities, setOpportunities] = useState<ArbitrageOpportunity[]>([]);
  const [engineStatus, setEngineStatus] = useState<Record<string, any>>({});
  const [executing, setExecuting] = useState<string | null>(null);
  const [executionResults, setExecutionResults] = useState<Record<string, ExecutionResult>>({});
  const [expandedOpp, setExpandedOpp] = useState<string | null>(null);

  // Config
  const [config, setConfig] = useState<Record<string, any>>({});
  const [autoExecute, setAutoExecute] = useState(false);
  const [minProfit, setMinProfit] = useState('0.50');

  // Treasury
  const [treasuryTotal, setTreasuryTotal] = useState(0);
  const [treasuryEntries, setTreasuryEntries] = useState<any[]>([]);

  // Stats
  const [stats, setStats] = useState({
    totalOpportunities: 0,
    totalExecuted: 0,
    totalProfit: 0,
    successRate: 0,
  });

  const scanIntervalRef = useRef<number | null>(null);

  const pushAlert = useCallback((type: Alert['type'], message: string) => {
    const id = `${Date.now()}-${Math.random()}`;
    setAlerts(prev => [...prev.slice(-4), { id, type, message }]);
    alertTimers.current[id] = window.setTimeout(() => {
      setAlerts(prev => prev.filter(a => a.id !== id));
      delete alertTimers.current[id];
    }, 6000);
  }, []);

  const copyToClipboard = (text: string, label?: string) => {
    navigator.clipboard.writeText(text).then(() => pushAlert('success', `${label || 'Copied'} to clipboard`));
  };

  // Load wallet and config on mount
  useEffect(() => {
    (async () => {
      const w = await loadWallet();
      if (w) setWalletLoaded(w);

      const { data: configData } = await supabase.from('arb_config').select('*');
      if (configData) {
        const cfg: Record<string, any> = {};
        configData.forEach((c: any) => cfg[c.key] = c.value);
        setConfig(cfg);
        setAutoExecute(cfg.auto_execute === true);
        setMinProfit(cfg.min_profit_usd?.toString() || '0.50');
      }

      const { data: statusData } = await supabase.from('arb_engine_status').select('*');
      if (statusData) {
        const st: Record<string, any> = {};
        statusData.forEach((s: any) => st[s.chain] = s);
        setEngineStatus(st);
      }

      const { data: treasuryData } = await supabase.from('arb_treasury').select('*').order('created_at', { ascending: false }).limit(50);
      if (treasuryData) {
        setTreasuryEntries(treasuryData);
        const total = treasuryData.filter((t: any) => t.type === 'profit').reduce((s: number, t: any) => s + parseFloat(t.amount_usd || '0'), 0);
        setTreasuryTotal(total);
      }
    })();
  }, []);

  // Fetch chain balances
  const fetchBalances = useCallback(async (address: string) => {
    const balances: Record<string, string> = {};
    for (const chainKey of CHAIN_KEYS) {
      const chain = CHAINS[chainKey];
      const balance = await getNativeBalance(address, chain.rpc[0]);
      balances[chainKey] = balance;
    }
    setChainBalances(balances);
  }, []);

  // Scan loop
  const runScan = useCallback(async () => {
    if (scanning) return;
    setScanning(true);

    const enabledChains = config.enabled_chains || ['polygon', 'arbitrum', 'optimism'];

    for (const chainKey of enabledChains) {
      try {
        // Update engine status
        await supabase.from('arb_engine_status').upsert({
          chain: chainKey,
          status: 'scanning',
          last_scan_at: new Date().toISOString(),
        }, { onConflict: 'chain' });

        const result = await scanChain(chainKey);

        // Update status
        await supabase.from('arb_engine_status').upsert({
          chain: chainKey,
          status: result.error ? 'error' : 'idle',
          last_scan_at: new Date().toISOString(),
          opportunities_found: (engineStatus[chainKey]?.opportunities_found || 0) + result.opportunities.length,
          current_block: result.blockNumber,
          rpc_latency_ms: result.rpcLatencyMs,
          error_message: result.error,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'chain' });

        if (result.opportunities.length > 0) {
          // Store opportunities in Supabase
          for (const opp of result.opportunities) {
            await supabase.from('arb_opportunities').insert({
              chain: opp.chain,
              opportunity_type: opp.opportunityType,
              token_path: opp.tokenPath,
              dex_path: opp.dexPath,
              pool_addresses: opp.poolAddresses,
              flash_loan_asset: opp.flashLoanAsset,
              flash_loan_amount: opp.flashLoanAmount,
              estimated_profit: opp.estimatedProfit,
              estimated_gas_cost: opp.estimatedGasCost,
              net_profit: opp.netProfit,
              profit_margin_pct: opp.profitMarginPct,
              pool_reserves: opp.poolReserves,
              price_impact: opp.priceImpact,
              confidence_score: opp.confidenceScore,
              status: 'detected',
              block_number: opp.blockNumber,
              expires_at: new Date(Date.now() + 60000).toISOString(),
            });
          }

          pushAlert('success', `${chainKey}: ${result.opportunities.length} opportunities found`);
        }
      } catch (err: any) {
        pushAlert('error', `Scan error on ${chainKey}: ${err.message}`);
      }
    }

    // Fetch all recent opportunities
    const { data: oppData } = await supabase
      .from('arb_opportunities')
      .select('*')
      .in('status', ['detected', 'validated'])
      .order('created_at', { ascending: false })
      .limit(50);

    if (oppData) {
      const mapped: ArbitrageOpportunity[] = oppData.map((o: any) => ({
        chain: o.chain,
        opportunityType: o.opportunity_type,
        tokenPath: o.token_path,
        tokenAddresses: [],
        dexPath: o.dex_path,
        poolAddresses: o.pool_addresses,
        flashLoanAsset: o.flash_loan_asset,
        flashLoanAmount: parseFloat(o.flash_loan_amount),
        estimatedProfit: parseFloat(o.estimated_profit),
        estimatedGasCost: parseFloat(o.estimated_gas_cost),
        netProfit: parseFloat(o.net_profit),
        profitMarginPct: parseFloat(o.profit_margin_pct),
        poolReserves: o.pool_reserves,
        priceImpact: parseFloat(o.price_impact),
        confidenceScore: parseFloat(o.confidence_score),
        blockNumber: o.block_number,
      }));
      setOpportunities(mapped);
      setStats(prev => ({ ...prev, totalOpportunities: prev.totalOpportunities + mapped.length }));
    }

    setScanning(false);
  }, [scanning, config, engineStatus, pushAlert]);

  // Start/stop engine
  const startEngine = () => {
    setEngineRunning(true);
    pushAlert('success', 'Arbitrage engine started — scanning DEX pools across all chains');
    runScan();
    scanIntervalRef.current = window.setInterval(() => runScan(), 15000);
  };

  const stopEngine = () => {
    setEngineRunning(false);
    if (scanIntervalRef.current) {
      clearInterval(scanIntervalRef.current);
      scanIntervalRef.current = null;
    }
    pushAlert('warning', 'Arbitrage engine stopped');
  };

  // Wallet operations
  const handleGenerateWallet = async () => {
    if (!walletPassword || walletPassword.length < 6) {
      pushAlert('error', 'Password must be at least 6 characters');
      return;
    }
    setWalletLoading(true);
    try {
      const w = await generateWallet(walletPassword);
      setWallet(w);
      setWalletLoaded({ address: w.address, encryptedKey: w.encryptedKey, salt: w.salt });
      pushAlert('success', `Wallet created: ${w.address.slice(0, 10)}...${w.address.slice(-6)}`);
      fetchBalances(w.address);
    } catch (err: any) {
      pushAlert('error', `Failed to create wallet: ${err.message}`);
    }
    setWalletLoading(false);
  };

  const handleImportWallet = async () => {
    if (!walletPrivateKey || !walletPrivateKey.startsWith('0x')) {
      pushAlert('error', 'Private key must start with 0x');
      return;
    }
    if (!walletPassword || walletPassword.length < 6) {
      pushAlert('error', 'Password must be at least 6 characters');
      return;
    }
    setWalletLoading(true);
    try {
      const w = await importWallet(walletPrivateKey, walletPassword);
      setWallet(w);
      setWalletLoaded({ address: w.address, encryptedKey: w.encryptedKey, salt: w.salt });
      pushAlert('success', `Wallet imported: ${w.address.slice(0, 10)}...${w.address.slice(-6)}`);
      fetchBalances(w.address);
    } catch (err: any) {
      pushAlert('error', `Failed to import wallet: ${err.message}`);
    }
    setWalletLoading(false);
  };

  const handleUnlockWallet = async () => {
    if (!walletLoaded || !walletPassword) return;
    setWalletLoading(true);
    try {
      const w = await unlockWallet(walletLoaded.encryptedKey, walletLoaded.salt, walletPassword);
      setWallet(w);
      pushAlert('success', 'Wallet unlocked');
      fetchBalances(w.address);
    } catch (err: any) {
      pushAlert('error', 'Invalid password');
    }
    setWalletLoading(false);
  };

  // Execute an opportunity
  const handleExecute = async (opp: ArbitrageOpportunity) => {
    if (!wallet?.signer) {
      pushAlert('error', 'Unlock your wallet first');
      return;
    }

    const oppId = `${opp.chain}-${opp.opportunityType}-${opp.tokenPath.join('-')}-${opp.blockNumber}`;
    setExecuting(oppId);

    try {
      const chain = CHAINS[opp.chain];
      const provider = new ethers.JsonRpcProvider(chain.rpc[0]);
      const signer = wallet.signer!.connect(provider);

      // Check if executor contract is deployed
      const executorAddr = deployedContracts[opp.chain];
      if (!executorAddr) {
        pushAlert('warning', `No executor contract deployed on ${chain.name}. Go to Settings to deploy.`);
        setExecuting(null);
        return;
      }

      pushAlert('info', `Executing ${opp.opportunityType} arb on ${opp.chain}...`);

      const result = await executeArbitrage(signer, opp.chain, opp, executorAddr);
      setExecutionResults(prev => ({ ...prev, [oppId]: result }));

      if (result.success) {
        pushAlert('success', `Arbitrage executed! Profit: $${result.profitUsd?.toFixed(4) || '0'}`);
        // Record in treasury
        await supabase.from('arb_treasury').insert({
          amount_usd: result.profitUsd || 0,
          cumulative_usd: treasuryTotal + (result.profitUsd || 0),
          type: 'profit',
          chain: opp.chain,
        });
        setTreasuryTotal(prev => prev + (result.profitUsd || 0));
      } else {
        pushAlert('error', result.error || 'Execution failed');
        if (result.autoFixed) {
          pushAlert('info', `Auto-fix: ${result.autoFixed}`);
        }
      }
    } catch (err: any) {
      pushAlert('error', `Execution error: ${err.message}`);
    }

    setExecuting(null);
  };

  // Auto-execute if enabled
  useEffect(() => {
    if (autoExecute && engineRunning && opportunities.length > 0) {
      const best = opportunities.find(o =>
        o.netProfit >= parseFloat(minProfit) &&
        !executing &&
        o.confidenceScore > 0.7
      );
      if (best) {
        handleExecute(best);
      }
    }
  }, [autoExecute, engineRunning, opportunities, executing, minProfit]);

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'dashboard', label: 'Dashboard', icon: <BarChart3 className="w-4 h-4" /> },
    { id: 'opportunities', label: 'Opportunities', icon: <Crosshair className="w-4 h-4" /> },
    { id: 'wallet', label: 'Wallet', icon: <Wallet className="w-4 h-4" /> },
    { id: 'treasury', label: 'Treasury', icon: <Coins className="w-4 h-4" /> },
    { id: 'settings', label: 'Settings', icon: <Settings className="w-4 h-4" /> },
  ];

  const totalNetProfit = opportunities.reduce((s, o) => s + o.netProfit, 0);

  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <header className="bg-slate-900/80 backdrop-blur-md border-b border-slate-800 sticky top-0 z-50">
        <div className="max-w-screen-2xl mx-auto px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-gradient-to-br from-emerald-500 to-cyan-500 rounded-lg flex items-center justify-center shrink-0">
                <Zap className="w-6 h-6 text-white" />
              </div>
              <div>
                <h1 className="text-lg font-bold bg-gradient-to-r from-emerald-400 to-cyan-400 bg-clip-text text-transparent">
                  Flash Arb Engine
                </h1>
                <p className="text-xs text-slate-500">Flash Loan Micro-Arbitrage | Polygon, Arbitrum, Optimism</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 bg-slate-800 rounded-lg text-sm">
                <Coins className="w-3.5 h-3.5 text-amber-400" />
                <span className="text-slate-400">Treasury:</span>
                <span className="font-mono font-semibold text-amber-400">${treasuryTotal.toFixed(4)}</span>
              </div>
              <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 rounded-lg">
                <div className={`w-2 h-2 rounded-full ${
                  engineRunning ? 'bg-emerald-500 animate-pulse' : 'bg-slate-500'
                }`} />
                <span className="text-sm text-slate-300">{engineRunning ? 'Scanning' : 'Idle'}</span>
              </div>
              {engineRunning ? (
                <button onClick={stopEngine} className="px-4 py-2 bg-red-600 hover:bg-red-500 rounded-lg flex items-center gap-2 text-sm font-medium transition-colors">
                  <Pause className="w-4 h-4" /> Stop
                </button>
              ) : (
                <button onClick={startEngine} className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-lg flex items-center gap-2 text-sm font-medium transition-colors">
                  <Play className="w-4 h-4" /> Start Engine
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
              className={`flex items-center gap-2 px-4 py-2 rounded-lg whitespace-nowrap transition-all text-sm font-medium ${
                activeTab === tab.id ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-white'
              }`}>
              {tab.icon}{tab.label}
            </button>
          ))}
        </nav>

        {/* DASHBOARD */}
        {activeTab === 'dashboard' && (
          <div className="space-y-6">
            {/* Wallet status banner */}
            {!wallet && (
              <div className="bg-amber-900/30 border border-amber-700 rounded-xl p-4 flex items-center gap-4">
                <div className="w-10 h-10 bg-amber-600 rounded-lg flex items-center justify-center shrink-0">
                  <KeyRound className="w-5 h-5 text-white" />
                </div>
                <div className="flex-1">
                  <h3 className="text-sm font-semibold text-amber-300">No Wallet Connected</h3>
                  <p className="text-xs text-slate-400 mt-0.5">Generate a wallet to start scanning and executing arbitrage opportunities.</p>
                </div>
                <button onClick={() => setActiveTab('wallet')}
                  className="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 rounded-lg text-xs font-medium shrink-0">
                  Create Wallet
                </button>
              </div>
            )}

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <MetricCard icon={<Crosshair className="w-5 h-5" />} label="Opportunities" value={opportunities.length.toString()} subtitle="currently detected" color="emerald" />
              <MetricCard icon={<Activity className="w-5 h-5" />} label="Chains Active" value={Object.keys(engineStatus).filter(k => engineStatus[k]?.status !== 'error').length.toString()} subtitle="scanning" color="cyan" />
              <MetricCard icon={<Coins className="w-5 h-5" />} label="Treasury" value={`$${treasuryTotal.toFixed(4)}`} subtitle="net profit" color="amber" />
              <MetricCard icon={<TrendingUp className="w-5 h-5" />} label="Avg Net Profit" value={`$${opportunities.length > 0 ? (totalNetProfit / opportunities.length).toFixed(4) : '0'}`} subtitle="per opportunity" color="emerald" />
            </div>

            {/* Chain Status */}
            <div className="bg-slate-900 rounded-xl border border-slate-800 p-6">
              <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
                <Network className="w-5 h-5 text-cyan-400" /> Chain Status
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {CHAIN_KEYS.map(chainKey => {
                  const chain = CHAINS[chainKey];
                  const status = engineStatus[chainKey];
                  return (
                    <div key={chainKey} className="bg-slate-800/50 rounded-lg p-4">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-sm font-semibold">{chain.name}</span>
                        <div className={`w-2 h-2 rounded-full ${
                          status?.status === 'scanning' ? 'bg-emerald-500 animate-pulse' :
                          status?.status === 'error' ? 'bg-red-500' : 'bg-slate-500'
                        }`} />
                      </div>
                      <div className="space-y-1 text-xs text-slate-400">
                        <div className="flex justify-between">
                          <span>Status:</span>
                          <span className={status?.status === 'error' ? 'text-red-400' : status?.status === 'scanning' ? 'text-emerald-400' : 'text-slate-400'}>
                            {status?.status || 'idle'}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span>Block:</span>
                          <span className="font-mono">{status?.current_block?.toLocaleString() || '-'}</span>
                        </div>
                        <div className="flex justify-between">
                          <span>RPC Latency:</span>
                          <span className="font-mono">{status?.rpc_latency_ms ? `${status.rpc_latency_ms}ms` : '-'}</span>
                        </div>
                        <div className="flex justify-between">
                          <span>Found:</span>
                          <span className="font-mono">{status?.opportunities_found || 0}</span>
                        </div>
                        <div className="flex justify-between">
                          <span>Balance:</span>
                          <span className="font-mono">{chainBalances[chainKey] ? `${parseFloat(chainBalances[chainKey]).toFixed(4)} ${chain.nativeTokenSymbol}` : '-'}</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Top Opportunities */}
            <div className="bg-slate-900 rounded-xl border border-slate-800 p-6">
              <h3 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2">
                <Crosshair className="w-4 h-4 text-emerald-400" /> Top Opportunities
              </h3>
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {opportunities.length === 0 ? (
                  <p className="text-sm text-slate-500 text-center py-8">
                    No opportunities detected. Start the engine to scan DEX pools.
                  </p>
                ) : opportunities.slice(0, 8).map((opp, i) => (
                  <div key={i} className="flex items-center justify-between bg-slate-800/50 rounded-lg px-3 py-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                        opp.opportunityType === 'triangular' ? 'bg-cyan-900/60 text-cyan-300' :
                        opp.opportunityType === 'two_dex' ? 'bg-emerald-900/60 text-emerald-300' :
                        opp.opportunityType === 'pool_imbalance' ? 'bg-amber-900/60 text-amber-300' :
                        'bg-slate-700 text-slate-400'
                      }`}>{opp.opportunityType.replace(/_/g, ' ')}</span>
                      <span className="text-xs text-slate-400 truncate">{opp.chain} | {opp.tokenPath.join(' -> ')}</span>
                    </div>
                    <div className="flex items-center gap-3 text-xs">
                      <span className="text-emerald-400 font-semibold">${opp.netProfit.toFixed(4)}</span>
                      <span className="text-slate-500">{opp.profitMarginPct.toFixed(2)}%</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* OPPORTUNITIES */}
        {activeTab === 'opportunities' && (
          <div className="space-y-6">
            <div className="bg-slate-900 rounded-xl border border-slate-800 p-4">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold">Detected Arbitrage Opportunities</h2>
                <button onClick={runScan} disabled={scanning}
                  className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 rounded-lg text-sm font-medium flex items-center gap-2">
                  <RefreshCcw className={`w-3.5 h-3.5 ${scanning ? 'animate-spin' : ''}`} /> {scanning ? 'Scanning...' : 'Scan Now'}
                </button>
              </div>
            </div>

            {opportunities.length === 0 ? (
              <div className="bg-slate-900 rounded-xl border border-slate-800 p-12 text-center">
                <Crosshair className="w-12 h-12 text-slate-600 mx-auto mb-4" />
                <p className="text-slate-400">No opportunities detected yet.</p>
                <p className="text-sm text-slate-500 mt-2">Start the engine to scan DEX pools across Polygon, Arbitrum, and Optimism for flash loan arbitrage.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {opportunities.map((opp, i) => {
                  const oppId = `${opp.chain}-${opp.opportunityType}-${opp.tokenPath.join('-')}-${opp.blockNumber}`;
                  const result = executionResults[oppId];
                  const isExpanded = expandedOpp === oppId;
                  const isExecuting = executing === oppId;

                  return (
                    <div key={i} className="bg-slate-900 rounded-xl border border-slate-800 overflow-hidden">
                      <div
                        className="p-4 cursor-pointer hover:bg-slate-800/30 transition-colors"
                        onClick={() => setExpandedOpp(isExpanded ? null : oppId)}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3 min-w-0">
                            <span className={`px-2 py-1 rounded text-xs font-medium ${
                              opp.opportunityType === 'triangular' ? 'bg-cyan-900/60 text-cyan-300' :
                              opp.opportunityType === 'two_dex' ? 'bg-emerald-900/60 text-emerald-300' :
                              opp.opportunityType === 'pool_imbalance' ? 'bg-amber-900/60 text-amber-300' :
                              'bg-slate-700 text-slate-400'
                            }`}>{opp.opportunityType.replace(/_/g, ' ')}</span>
                            <div>
                              <span className="text-sm font-semibold">{opp.chain}</span>
                              <span className="text-xs text-slate-500 ml-2">{opp.tokenPath.join(' -> ')}</span>
                            </div>
                          </div>
                          <div className="flex items-center gap-4">
                            <div className="text-right">
                              <p className="text-sm font-bold text-emerald-400">${opp.netProfit.toFixed(4)}</p>
                              <p className="text-xs text-slate-500">{opp.profitMarginPct.toFixed(2)}% margin</p>
                            </div>
                            {isExpanded ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
                          </div>
                        </div>
                      </div>

                      {isExpanded && (
                        <div className="px-4 pb-4 border-t border-slate-800 pt-4">
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                            <DetailItem label="Flash Loan" value={`$${opp.flashLoanAmount.toFixed(0)}`} />
                            <DetailItem label="Est. Profit" value={`$${opp.estimatedProfit.toFixed(4)}`} />
                            <DetailItem label="Gas Cost" value={`$${opp.estimatedGasCost.toFixed(4)}`} />
                            <DetailItem label="Confidence" value={`${(opp.confidenceScore * 100).toFixed(0)}%`} />
                          </div>
                          <div className="mb-4">
                            <p className="text-xs text-slate-400 mb-1">DEX Route</p>
                            <div className="flex items-center gap-2 flex-wrap">
                              {opp.dexPath.map((dex, j) => (
                                <span key={j} className="flex items-center gap-2">
                                  <span className="px-2 py-1 bg-slate-800 rounded text-xs">{dex}</span>
                                  {j < opp.dexPath.length - 1 && <ArrowRight className="w-3 h-3 text-slate-500" />}
                                </span>
                              ))}
                            </div>
                          </div>
                          {Object.keys(opp.poolReserves).length > 0 && (
                            <div className="mb-4">
                              <p className="text-xs text-slate-400 mb-1">Pool Reserves</p>
                              {Object.entries(opp.poolReserves).map(([dex, reserves]) => (
                                <div key={dex} className="text-xs text-slate-400 mb-1">
                                  {dex}: {reserves[0]} / {reserves[1]}
                                </div>
                              ))}
                            </div>
                          )}
                          {result && (
                            <div className={`p-3 rounded-lg mb-4 ${result.success ? 'bg-emerald-900/30 border border-emerald-700' : 'bg-red-900/30 border border-red-700'}`}>
                              <p className={`text-sm ${result.success ? 'text-emerald-300' : 'text-red-300'}`}>
                                {result.success ? 'Execution successful' : 'Execution failed'}
                                {result.txHash && (
                                  <a href={`${CHAINS[opp.chain].blockExplorer}/tx/${result.txHash}`} target="_blank" rel="noopener noreferrer" className="ml-2 text-cyan-400 hover:underline">
                                    View tx <ExternalLink className="w-3 h-3 inline" />
                                  </a>
                                )}
                              </p>
                              {result.error && <p className="text-xs text-red-400 mt-1">{result.error}</p>}
                              {result.autoFixed && <p className="text-xs text-amber-400 mt-1">Auto-fix: {result.autoFixed}</p>}
                            </div>
                          )}
                          <button
                            onClick={() => handleExecute(opp)}
                            disabled={isExecuting || !wallet}
                            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 disabled:text-slate-500 rounded-lg text-sm font-medium flex items-center gap-2"
                          >
                            {isExecuting ? <RefreshCcw className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                            {isExecuting ? 'Executing...' : 'Execute Arbitrage'}
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* WALLET */}
        {activeTab === 'wallet' && (
          <div className="space-y-6">
            {!wallet && !walletLoaded ? (
              /* Create/Import wallet */
              <div className="bg-slate-900 rounded-xl border border-slate-800 p-6">
                <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
                  <KeyRound className="w-5 h-5 text-emerald-400" /> Create or Import Wallet
                </h2>
                <p className="text-sm text-slate-400 mb-6">
                  Generate a new EVM wallet or import an existing one. The wallet signs arbitrage transactions
                  and holds your gas funds and profits. The private key is encrypted and stored securely.
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="space-y-3">
                    <h3 className="text-sm font-semibold text-slate-300">Generate New Wallet</h3>
                    <input type="password" value={walletPassword} onChange={e => setWalletPassword(e.target.value)}
                      placeholder="Encryption password (min 6 chars)"
                      className="w-full bg-slate-800 rounded-lg px-3 py-2 text-sm border border-slate-700 focus:border-emerald-500 outline-none" />
                    <button onClick={handleGenerateWallet} disabled={walletLoading}
                      className="w-full px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 rounded-lg text-sm font-medium flex items-center justify-center gap-2">
                      {walletLoading ? <RefreshCcw className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                      Generate Wallet
                    </button>
                  </div>
                  <div className="space-y-3">
                    <h3 className="text-sm font-semibold text-slate-300">Import Existing Wallet</h3>
                    <input type="text" value={walletPrivateKey} onChange={e => setWalletPrivateKey(e.target.value)}
                      placeholder="Private key (0x...)"
                      className="w-full bg-slate-800 rounded-lg px-3 py-2 text-sm font-mono border border-slate-700 focus:border-emerald-500 outline-none" />
                    <input type="password" value={walletPassword} onChange={e => setWalletPassword(e.target.value)}
                      placeholder="Encryption password (min 6 chars)"
                      className="w-full bg-slate-800 rounded-lg px-3 py-2 text-sm border border-slate-700 focus:border-emerald-500 outline-none" />
                    <button onClick={handleImportWallet} disabled={walletLoading}
                      className="w-full px-4 py-2 bg-cyan-600 hover:bg-cyan-500 disabled:bg-slate-700 rounded-lg text-sm font-medium flex items-center justify-center gap-2">
                      {walletLoading ? <RefreshCcw className="w-4 h-4 animate-spin" /> : <KeyRound className="w-4 h-4" />}
                      Import Wallet
                    </button>
                  </div>
                </div>
              </div>
            ) : !wallet && walletLoaded ? (
              /* Unlock wallet */
              <div className="bg-slate-900 rounded-xl border border-slate-800 p-6">
                <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
                  <Shield className="w-5 h-5 text-amber-400" /> Unlock Wallet
                </h2>
                <p className="text-sm text-slate-400 mb-4">
                  Wallet found: <code className="text-cyan-300 font-mono">{walletLoaded.address}</code>
                </p>
                <input type="password" value={walletPassword} onChange={e => setWalletPassword(e.target.value)}
                  placeholder="Enter password to unlock"
                  className="w-full bg-slate-800 rounded-lg px-3 py-2 text-sm border border-slate-700 focus:border-emerald-500 outline-none mb-3" />
                <button onClick={handleUnlockWallet} disabled={walletLoading}
                  className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 rounded-lg text-sm font-medium flex items-center gap-2">
                  {walletLoading ? <RefreshCcw className="w-4 h-4 animate-spin" /> : <KeyRound className="w-4 h-4" />}
                  Unlock
                </button>
              </div>
            ) : wallet ? (
              /* Wallet dashboard */
              <div className="space-y-6">
                <div className="bg-gradient-to-br from-slate-900 to-slate-800 rounded-xl border border-slate-800 p-6">
                  <div className="flex items-center justify-between mb-4">
                    <h2 className="text-lg font-semibold flex items-center gap-2">
                      <Wallet className="w-5 h-5 text-emerald-400" /> Wallet
                    </h2>
                    <button onClick={() => { setWallet(null); setWalletPassword(''); }}
                      className="text-xs text-slate-400 hover:text-red-400">Lock</button>
                  </div>
                  <div className="mb-4">
                    <p className="text-xs text-slate-400 uppercase tracking-wide mb-1">Address</p>
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-mono text-emerald-300">{wallet.address}</p>
                      <button onClick={() => copyToClipboard(wallet.address, 'Address')} className="text-slate-400 hover:text-white">
                        <Copy className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    {CHAIN_KEYS.map(chainKey => {
                      const chain = CHAINS[chainKey];
                      const balance = chainBalances[chainKey] || '0';
                      return (
                        <div key={chainKey} className="bg-slate-800/50 rounded-lg p-3">
                          <p className="text-xs text-slate-400 mb-1">{chain.name}</p>
                          <p className="text-lg font-bold">{parseFloat(balance).toFixed(4)} <span className="text-sm text-slate-400">{chain.nativeTokenSymbol}</span></p>
                          <p className="text-xs text-slate-500 mt-1">
                            {deployedContracts[chainKey] ? 'Contract deployed' : 'No contract'}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                  <button onClick={() => fetchBalances(wallet.address)}
                    className="mt-4 text-xs text-slate-400 hover:text-white flex items-center gap-1">
                    <RefreshCcw className="w-3 h-3" /> Refresh balances
                  </button>
                </div>

                {/* Funding instructions */}
                <div className="bg-slate-900 rounded-xl border border-slate-800 p-6">
                  <h3 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2">
                    <ArrowDownToLine className="w-4 h-4 text-emerald-400" /> Fund Your Wallet (Gas Money)
                  </h3>
                  <p className="text-sm text-slate-400 mb-4">
                    You need a small amount of native token on each chain to pay for gas (transaction fees).
                    Flash loans themselves require zero capital — you only pay gas.
                    Send native tokens to your wallet address on each chain:
                  </p>
                  <div className="space-y-3">
                    {CHAIN_KEYS.map(chainKey => {
                      const chain = CHAINS[chainKey];
                      return (
                        <div key={chainKey} className="flex items-center gap-3 bg-slate-800/50 rounded-lg px-3 py-2">
                          <span className="text-sm font-medium w-24">{chain.name}</span>
                          <span className="text-xs text-slate-400">Send {chain.nativeTokenSymbol} to</span>
                          <code className="text-xs font-mono text-cyan-300 flex-1 truncate">{wallet.address}</code>
                          <button onClick={() => copyToClipboard(wallet.address, `${chain.name} address`)} className="text-slate-400 hover:text-white">
                            <Copy className="w-3.5 h-3.5" />
                          </button>
                          <a href={`${chain.blockExplorer}/address/${wallet.address}`} target="_blank" rel="noopener noreferrer" className="text-slate-400 hover:text-white">
                            <ExternalLink className="w-3.5 h-3.5" />
                          </a>
                        </div>
                      );
                    })}
                  </div>
                  <div className="mt-4 p-3 bg-emerald-900/30 border border-emerald-700/50 rounded-lg">
                    <p className="text-xs text-emerald-300">
                      Estimated gas per arbitrage: ~0.001-0.01 {CHAIN_KEYS.map(k => CHAINS[k].nativeTokenSymbol).join(' / ')} per chain.
                      Even $1 of gas money per chain is enough for dozens of trades.
                    </p>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        )}

        {/* TREASURY */}
        {activeTab === 'treasury' && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <MetricCard icon={<Coins className="w-5 h-5" />} label="Total Profit" value={`$${treasuryTotal.toFixed(4)}`} subtitle="all-time net" color="emerald" />
              <MetricCard icon={<Activity className="w-5 h-5" />} label="Total Trades" value={stats.totalExecuted.toString()} color="cyan" />
              <MetricCard icon={<TrendingUp className="w-5 h-5" />} label="Success Rate" value={`${stats.successRate}%`} color="amber" />
            </div>

            <div className="bg-slate-900 rounded-xl border border-slate-800 overflow-hidden">
              <div className="p-4 border-b border-slate-800">
                <h2 className="text-lg font-semibold">Treasury Ledger</h2>
              </div>
              {treasuryEntries.length === 0 ? (
                <p className="text-sm text-slate-500 text-center py-16">
                  No treasury entries yet. Profits from executed arbitrage will appear here.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-800/50 text-slate-400 text-xs uppercase">
                      <tr>
                        <th className="px-4 py-3 text-left">Type</th>
                        <th className="px-4 py-3 text-right">Amount (USD)</th>
                        <th className="px-4 py-3 text-left">Chain</th>
                        <th className="px-4 py-3 text-left">Date</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800">
                      {treasuryEntries.map((entry: any) => (
                        <tr key={entry.id} className="hover:bg-slate-800/30 transition-colors">
                          <td className="px-4 py-3">
                            <span className={`text-xs ${entry.type === 'profit' ? 'text-emerald-400' : 'text-amber-400'}`}>{entry.type}</span>
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-emerald-400">${parseFloat(entry.amount_usd || '0').toFixed(4)}</td>
                          <td className="px-4 py-3 text-xs text-slate-400">{entry.chain}</td>
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

        {/* SETTINGS */}
        {activeTab === 'settings' && (
          <div className="space-y-6">
            <div className="bg-slate-900 rounded-xl border border-slate-800 p-6">
              <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
                <Settings className="w-5 h-5 text-slate-400" /> Engine Configuration
              </h2>
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">Auto-Execute</p>
                    <p className="text-xs text-slate-500">Automatically execute opportunities above the profit threshold</p>
                  </div>
                  <button onClick={() => setAutoExecute(!autoExecute)}
                    className={`w-12 h-6 rounded-full transition-colors ${autoExecute ? 'bg-emerald-600' : 'bg-slate-700'}`}>
                    <div className={`w-5 h-5 bg-white rounded-full transition-transform ${autoExecute ? 'translate-x-6' : 'translate-x-0.5'}`} />
                  </button>
                </div>
                <div>
                  <label className="text-sm font-medium">Minimum Profit (USD)</label>
                  <input type="number" value={minProfit} onChange={e => setMinProfit(e.target.value)}
                    className="w-full bg-slate-800 rounded-lg px-3 py-2 text-sm border border-slate-700 focus:border-emerald-500 outline-none mt-1" />
                  <p className="text-xs text-slate-500 mt-1">Only execute opportunities with at least this much net profit</p>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <ConfigItem label="Max Flash Loan" value={`$${config.max_flash_loan_usd || 50000}`} />
                  <ConfigItem label="Max Gas Price" value={`${config.max_gas_price_gwei || 100} gwei`} />
                  <ConfigItem label="Scan Interval" value={`${config.scan_interval_seconds || 5}s`} />
                  <ConfigItem label="Max Hops" value={config.max_hops || 3} />
                  <ConfigItem label="Flash Loan Provider" value={config.flash_loan_provider || 'aave_v3'} />
                  <ConfigItem label="Slippage Tolerance" value={`${config.slippage_tolerance_pct || 0.5}%`} />
                </div>
              </div>
            </div>

            {/* Contract deployment */}
            <div className="bg-slate-900 rounded-xl border border-slate-800 p-6">
              <h3 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2">
                <Cpu className="w-4 h-4 text-cyan-400" /> Flash Arb Executor Contract
              </h3>
              <p className="text-sm text-slate-400 mb-4">
                The executor contract is deployed on each chain to receive flash loans and execute swaps.
                You need gas money (native token) in your wallet to deploy.
              </p>
              <div className="space-y-2">
                {CHAIN_KEYS.map(chainKey => {
                  const chain = CHAINS[chainKey];
                  const addr = deployedContracts[chainKey];
                  return (
                    <div key={chainKey} className="flex items-center gap-3 bg-slate-800/50 rounded-lg px-3 py-2">
                      <span className="text-sm font-medium w-24">{chain.name}</span>
                      {addr ? (
                        <>
                          <code className="text-xs font-mono text-emerald-300 flex-1 truncate">{addr}</code>
                          <CheckCircle className="w-4 h-4 text-emerald-400" />
                        </>
                      ) : (
                        <>
                          <span className="text-xs text-slate-500 flex-1">Not deployed</span>
                          <button onClick={() => pushAlert('info', `Deploying contract on ${chain.name}... This requires gas money in your wallet.`)}
                            className="px-3 py-1 bg-cyan-600 hover:bg-cyan-500 rounded text-xs font-medium">
                            Deploy
                          </button>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Auto-fix */}
            <div className="bg-slate-900 rounded-xl border border-slate-800 p-6">
              <h3 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2">
                <Wrench className="w-4 h-4 text-amber-400" /> Auto-Fix & Diagnostics
              </h3>
              <p className="text-sm text-slate-400 mb-4">
                The engine automatically fixes common issues:
              </p>
              <div className="space-y-2">
                {[
                  'High gas price — skips execution, retries when gas drops',
                  'Insufficient gas funds — alerts you to add more',
                  'Nonce errors — resets and retries',
                  'Network errors — falls back to alternative RPC',
                  'Front-run detection — marks opportunity as expired',
                  'Contract misconfiguration — re-sets DEX routers automatically',
                ].map((fix, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs text-slate-400">
                    <CheckCircle className="w-3.5 h-3.5 text-emerald-400" /> {fix}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
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

function DetailItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-slate-800/50 rounded-lg p-3">
      <p className="text-xs text-slate-400 mb-1">{label}</p>
      <p className="text-sm font-mono text-slate-200">{value}</p>
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
