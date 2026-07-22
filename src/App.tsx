import { useState, useEffect, useRef, useCallback } from 'react';
import { createClient } from '@supabase/supabase-js';
import {
  Play, Pause, RefreshCcw, Wallet, Cpu, Activity, TrendingUp,
  Shield, CheckCircle, AlertTriangle, Clock,
  Settings, DollarSign, Fuel, Lock, Eye, EyeOff, Sparkles, Rocket, Zap,
} from 'lucide-react';
import { CHAINS, CHAIN_KEYS, SCAN_INTERVAL_MS } from './lib/chains';
import { scanAllChains, ArbitrageOpportunity, ScanResult } from './lib/scanner';
import { deployExecutorGasless, executeArbitrageGasless, DeploymentResult, ExecutionResult } from './lib/executor';
import { generateWallet, importWallet, unlockWallet, loadWallet, updateDeployedContracts, WalletState } from './lib/wallet';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';
const supabase = supabaseUrl ? createClient(supabaseUrl, supabaseKey) : null;

type Tab = 'dashboard' | 'wallet' | 'opportunities' | 'settings';
interface AlertItem { id: string; type: 'success' | 'error' | 'warning' | 'info'; message: string; timestamp: number; }

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('dashboard');
  const [wallet, setWallet] = useState<WalletState | null>(null);
  const [walletLoaded, setWalletLoaded] = useState(false);
  const [password, setPassword] = useState('');
  const [importKey, setImportKey] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const [engineRunning, setEngineRunning] = useState(false);
  const [autoExecute, setAutoExecute] = useState(true);
  const [minProfit, setMinProfit] = useState('0.10');

  const [scanResults, setScanResults] = useState<ScanResult[]>([]);
  const [allOpportunities, setAllOpportunities] = useState<ArbitrageOpportunity[]>([]);
  const [executing, setExecuting] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [deployedContracts, setDeployedContracts] = useState<Record<string, string>>({});

  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [scanCount, setScanCount] = useState(0);
  const [totalProfit, setTotalProfit] = useState(0);
  const [executedCount, setExecutedCount] = useState(0);
  const [relayerMode, setRelayerMode] = useState<string | null>(null);

  const scanIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const pushAlert = useCallback((type: AlertItem['type'], message: string) => {
    setAlerts(prev => [{ id: Date.now().toString(), type, message, timestamp: Date.now() }, ...prev].slice(0, 20));
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const loaded = await loadWallet();
        setWalletLoaded(true);
        if (loaded) setWallet({
          address: loaded.address, encryptedKey: loaded.encryptedKey, salt: loaded.salt,
          isUnlocked: false, signer: null, settlementAddress: loaded.settlementAddress,
        });
      } catch { setWalletLoaded(true); }

      if (supabase) {
        try {
          const { data: treasuryData } = await supabase.from('arb_treasury').select('*').order('created_at', { ascending: false }).limit(50);
          if (treasuryData) {
            const profit = (treasuryData as any[]).filter(t => t.type === 'profit' || t.type === 'simulated_profit').reduce((s, t) => s + parseFloat(String(t.amount_usd || '0')), 0);
            setTotalProfit(profit);
          }
        } catch { /* non-fatal */ }
      }

      try {
        const resp = await fetch(`${supabaseUrl}/functions/v1/relayer`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${supabaseKey}` },
          body: JSON.stringify({ action: 'health' }),
        });
        if (resp.ok) {
          const health = await resp.json();
          setRelayerMode(health.mode);
        } else { setRelayerMode('simulation'); }
      } catch { setRelayerMode('simulation'); }
    })();
  }, []);

  const handleGenerateWallet = async () => {
    if (!password || password.length < 8) { pushAlert('error', 'Password must be at least 8 characters'); return; }
    try {
      const ws = await generateWallet(password);
      setWallet(ws);
      pushAlert('success', `Wallet created: ${ws.address.slice(0, 10)}...`);
      if (ws.settlementAddress) pushAlert('info', `Settlement wallet: ${ws.settlementAddress.slice(0, 10)}...`);
      setActiveTab('dashboard');
    } catch (err: any) { pushAlert('error', err.message); }
  };

  const handleImportWallet = async () => {
    if (!importKey || !password || password.length < 8) { pushAlert('error', 'Enter private key and password (min 8 chars)'); return; }
    try {
      const ws = await importWallet(importKey, password);
      setWallet(ws);
      pushAlert('success', `Wallet imported: ${ws.address.slice(0, 10)}...`);
      setShowImport(false); setImportKey('');
      setActiveTab('dashboard');
    } catch (err: any) { pushAlert('error', err.message); }
  };

  const handleUnlock = async () => {
    if (!wallet || !password) return;
    try {
      const ws = await unlockWallet(wallet.encryptedKey, wallet.salt, password);
      setWallet(ws);
      pushAlert('success', 'Wallet unlocked');
    } catch { pushAlert('error', 'Invalid password'); }
  };

  const handleOneClickStart = async () => {
    if (!wallet?.signer) { pushAlert('error', 'Unlock your wallet first'); setActiveTab('wallet'); return; }
    setDeploying(true);
    pushAlert('info', 'Computing executor addresses (zero gas)...');

    for (const chainKey of CHAIN_KEYS) {
      if (!deployedContracts[chainKey]) {
        const result: DeploymentResult = await deployExecutorGasless(wallet.signer!, chainKey);
        if (result.success && result.contractAddress) {
          const updated = { ...deployedContracts, [chainKey]: result.contractAddress };
          setDeployedContracts(updated);
          await updateDeployedContracts(wallet.address, updated);
          pushAlert('success', `Executor ready on ${CHAINS[chainKey].name}`);
        } else {
          pushAlert('warning', `Deploy on ${CHAINS[chainKey].name}: ${result.error?.slice(0, 80)}`);
        }
      }
    }

    setDeploying(false);
    setEngineRunning(true);
    pushAlert('success', `Engine started — scanning every ${SCAN_INTERVAL_MS / 1000}s`);
    runScan();
    scanIntervalRef.current = setInterval(() => runScan(), SCAN_INTERVAL_MS);
  };

  const stopEngine = () => {
    setEngineRunning(false);
    if (scanIntervalRef.current) { clearInterval(scanIntervalRef.current); scanIntervalRef.current = null; }
    pushAlert('info', 'Engine stopped');
  };

  const runScan = async () => {
    setScanCount(prev => prev + 1);
    try {
      const results = await scanAllChains();
      setScanResults(results);
      const opps = results.flatMap(r => r.opportunities).sort((a, b) => b.netProfit - a.netProfit);
      setAllOpportunities(opps);

      if (opps.length > 0) {
        try {
          await fetch(`${supabaseUrl}/functions/v1/relayer`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${supabaseKey}` },
            body: JSON.stringify({
              action: 'db_insert', table: 'arb_opportunities',
              data: opps.map(opp => ({
                chain: opp.chain, opportunity_type: opp.opportunityType, token_path: opp.tokenPath, dex_path: opp.dexPath,
                flash_loan_asset: opp.flashLoanAsset, flash_loan_amount: opp.flashLoanAmount,
                estimated_profit: opp.estimatedProfit, estimated_gas_cost: opp.estimatedGasCost,
                net_profit: opp.netProfit, profit_margin_pct: opp.profitMarginPct,
                confidence_score: opp.confidenceScore, block_number: opp.blockNumber, executed: false,
              })),
            }),
          });
        } catch { /* non-fatal */ }
      }

      if (autoExecute && wallet?.signer) {
        const min = parseFloat(minProfit) || 0.10;
        for (const opp of opps.filter(o => o.netProfit >= min).slice(0, 3)) { await executeOpportunity(opp); }
      }
    } catch (err: any) { pushAlert('error', `Scan failed: ${err.message?.slice(0, 100)}`); }
  };

  const executeOpportunity = async (opp: ArbitrageOpportunity) => {
    if (!wallet?.signer) { pushAlert('error', 'Unlock wallet to execute'); return; }
    const executorAddress = deployedContracts[opp.chain];
    if (!executorAddress) { pushAlert('error', `No executor contract on ${opp.chain}`); return; }
    setExecuting(true);
    pushAlert('info', `Executing arb on ${opp.chain} (${opp.opportunityType})...`);
    const result: ExecutionResult = await executeArbitrageGasless(wallet.signer!, opp.chain, opp, executorAddress);
    if (result.success) {
      setExecutedCount(prev => prev + 1);
      setTotalProfit(prev => prev + (result.profitUsd || 0));
      pushAlert('success', `Arb executed on ${opp.chain}: +$${result.profitUsd?.toFixed(2)}`);
    } else {
      pushAlert('error', `Execution failed on ${opp.chain}: ${result.error?.slice(0, 100)}`);
    }
    setExecuting(false);
  };

  const formatTime = (ts: number) => new Date(ts).toLocaleTimeString();

  return (
    <div className="min-h-screen bg-[#0a0e17] text-slate-200">
      <header className="border-b border-slate-800/50 bg-[#0d1320] sticky top-0 z-50 backdrop-blur-sm">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-emerald-500 to-cyan-600 flex items-center justify-center">
              <Rocket className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-base font-bold text-white">Flash Arb Engine</h1>
              <p className="text-xs text-slate-500 flex items-center gap-1">
                <Zap className="w-3 h-3 text-emerald-400" /> Zero Capital · SyncFee · {SCAN_INTERVAL_MS / 1000}s Scan
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {relayerMode && (
              <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-950/50 border border-emerald-800/50">
                <div className={`w-1.5 h-1.5 rounded-full ${relayerMode === 'syncfee' ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'} `} />
                <span className="text-xs text-emerald-300">{relayerMode === 'syncfee' ? 'SyncFee Live' : 'Simulation'}</span>
              </div>
            )}
            {wallet && (
              <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-800/50 border border-slate-700/50">
                <Wallet className="w-3.5 h-3.5 text-slate-400" />
                <span className="text-xs font-mono text-slate-300">{wallet.address.slice(0, 6)}...{wallet.address.slice(-4)}</span>
                {wallet.isUnlocked ? <CheckCircle className="w-3 h-3 text-emerald-400" /> : <Lock className="w-3 h-3 text-amber-400" />}
              </div>
            )}
            {engineRunning ? (
              <button onClick={stopEngine} className="px-4 py-2 bg-red-600 hover:bg-red-500 rounded-lg flex items-center gap-2 text-sm font-medium transition-colors">
                <Pause className="w-4 h-4" /> Stop
              </button>
            ) : (
              <button onClick={handleOneClickStart} disabled={deploying}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 rounded-lg flex items-center gap-2 text-sm font-medium transition-colors">
                {deploying ? <RefreshCcw className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                {deploying ? 'Deploying...' : 'Start Engine'}
              </button>
            )}
          </div>
        </div>
        <div className="max-w-7xl mx-auto px-4 flex gap-1">
          {(['dashboard', 'wallet', 'opportunities', 'settings'] as Tab[]).map(tab => (
            <button key={tab} onClick={() => setActiveTab(tab)}
              className={`px-4 py-2 text-sm font-medium capitalize border-b-2 transition-colors ${activeTab === tab ? 'border-emerald-500 text-emerald-400' : 'border-transparent text-slate-500 hover:text-slate-300'}`}>{tab}</button>
          ))}
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6">
        {alerts.length > 0 && (
          <div className="mb-4 space-y-1.5 max-h-32 overflow-y-auto">
            {alerts.slice(0, 5).map(alert => (
              <div key={alert.id} className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm ${alert.type === 'success' ? 'bg-emerald-950/50 border border-emerald-800/50 text-emerald-300' : alert.type === 'error' ? 'bg-red-950/50 border border-red-800/50 text-red-300' : alert.type === 'warning' ? 'bg-amber-950/50 border border-amber-800/50 text-amber-300' : 'bg-blue-950/50 border border-blue-800/50 text-blue-300'}`}>
                {alert.type === 'success' && <CheckCircle className="w-4 h-4 flex-shrink-0" />}
                {alert.type === 'error' && <AlertTriangle className="w-4 h-4 flex-shrink-0" />}
                {alert.type === 'warning' && <AlertTriangle className="w-4 h-4 flex-shrink-0" />}
                {alert.type === 'info' && <Activity className="w-4 h-4 flex-shrink-0" />}
                <span className="flex-1">{alert.message}</span>
                <span className="text-xs opacity-50">{formatTime(alert.timestamp)}</span>
              </div>
            ))}
          </div>
        )}

        {activeTab === 'dashboard' && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <StatCard icon={<DollarSign className="w-5 h-5" />} label="Total Profit" value={`$${totalProfit.toFixed(2)}`} color="emerald" />
              <StatCard icon={<TrendingUp className="w-5 h-5" />} label="Opportunities" value={String(allOpportunities.length)} color="cyan" />
              <StatCard icon={<CheckCircle className="w-5 h-5" />} label="Executed" value={String(executedCount)} color="emerald" />
              <StatCard icon={<Activity className="w-5 h-5" />} label="Scans" value={String(scanCount)} color="blue" />
            </div>

            <div className="bg-gradient-to-r from-emerald-950/50 to-cyan-950/50 rounded-xl border border-emerald-800/30 p-4">
              <div className="flex items-center gap-3">
                <Zap className="w-5 h-5 text-emerald-400 flex-shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-emerald-300">100% Zero-Capital Architecture · SyncFee Mode</p>
                  <p className="text-xs text-slate-400">Balancer 0% flash loans + Gelato callWithSyncFee (fee paid from profit, no deposit). Scans every {SCAN_INTERVAL_MS}ms. Zero upfront gas, zero seed capital.</p>
                </div>
              </div>
            </div>

            <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-6">
              <h3 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2"><Cpu className="w-4 h-4 text-cyan-400" /> Engine Status</h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <StatusItem label="Engine" value={engineRunning ? 'RUNNING' : 'STOPPED'} color={engineRunning ? 'emerald' : 'slate'} />
                <StatusItem label="Auto-Execute" value={autoExecute ? 'ON' : 'OFF'} color={autoExecute ? 'emerald' : 'slate'} />
                <StatusItem label="Gas Mode" value={relayerMode === 'syncfee' ? 'SYNCFEE' : 'SIMULATION'} color={relayerMode === 'syncfee' ? 'emerald' : 'amber'} />
                <StatusItem label="Scan Rate" value={`${SCAN_INTERVAL_MS / 1000}s`} color="cyan" />
              </div>
            </div>

            <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-6">
              <h3 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2"><Activity className="w-4 h-4 text-cyan-400" /> Chain Scanner Status</h3>
              <div className="space-y-2">
                {CHAIN_KEYS.map(chainKey => {
                  const chain = CHAINS[chainKey];
                  const result = scanResults.find(r => r.chain === chainKey);
                  const oppCount = result?.opportunities.length || 0;
                  const hasContract = !!deployedContracts[chainKey];
                  return (
                    <div key={chainKey} className="flex items-center gap-4 bg-slate-800/30 rounded-lg px-4 py-3">
                      <div className={`w-2 h-2 rounded-full ${engineRunning ? 'bg-emerald-400 animate-pulse' : 'bg-slate-600'}`} />
                      <span className="text-sm font-medium w-28">{chain.name}</span>
                      <span className="text-xs text-slate-500">~{chain.blockTimeMs / 1000}s/block</span>
                      <span className="text-xs text-slate-400">{oppCount} opps</span>
                      {result?.scanTimeMs !== undefined && <span className="text-xs text-slate-500">{result.scanTimeMs}ms</span>}
                      <div className="flex-1" />
                      {hasContract ? <span className="text-xs text-emerald-400 flex items-center gap-1"><CheckCircle className="w-3 h-3" /> Ready</span> : <span className="text-xs text-slate-500 flex items-center gap-1"><Clock className="w-3 h-3" /> Auto-deploys</span>}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-6">
              <h3 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2"><TrendingUp className="w-4 h-4 text-emerald-400" /> Live Opportunities</h3>
              {allOpportunities.length === 0 ? (
                <p className="text-sm text-slate-500 text-center py-8">{engineRunning ? 'Scanning every 3s...' : 'Start the engine to scan for arbitrage opportunities'}</p>
              ) : (
                <div className="space-y-2">
                  {allOpportunities.slice(0, 10).map((opp, i) => (
                    <div key={i} className="flex items-center gap-3 bg-slate-800/30 rounded-lg px-4 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded ${opp.opportunityType === 'triangular' ? 'bg-purple-950/50 text-purple-300' : 'bg-blue-950/50 text-blue-300'}`}>{opp.opportunityType}</span>
                      <span className="text-xs text-slate-400">{opp.chain}</span>
                      <span className="text-xs font-mono text-slate-300 flex-1 truncate">{opp.tokenPath.join(' -> ')}</span>
                      <span className="text-xs text-slate-500">{opp.dexPath.join(' / ')}</span>
                      <span className="text-xs font-semibold text-emerald-400">+${opp.netProfit.toFixed(2)}</span>
                      <span className="text-xs text-slate-500">{opp.profitMarginPct.toFixed(2)}%</span>
                      {wallet?.isUnlocked && deployedContracts[opp.chain] && (
                        <button onClick={() => executeOpportunity(opp)} disabled={executing} className="px-2 py-1 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 rounded text-xs font-medium">Execute</button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'wallet' && (
          <div className="max-w-lg space-y-4">
            <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-6">
              <h3 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2"><Wallet className="w-4 h-4 text-cyan-400" /> Wallet Management</h3>
              {!walletLoaded ? <p className="text-sm text-slate-500">Loading...</p> : !wallet ? (
                <div className="space-y-4">
                  <p className="text-sm text-slate-400">Create a new wallet or import an existing one. Your private key is encrypted with AES-256-GCM. A system-generated settlement wallet is created automatically — profits flow there, transferable later.</p>
                  <div className="space-y-3">
                    <div className="relative">
                      <input type={showPassword ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} placeholder="Password (min 8 chars)" className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white pr-10" />
                      <button onClick={() => setShowPassword(!showPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500">{showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}</button>
                    </div>
                    <button onClick={handleGenerateWallet} className="w-full px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-sm font-medium">Generate New Wallet</button>
                    {showImport && (
                      <div className="space-y-2 pt-2 border-t border-slate-800">
                        <input type="text" value={importKey} onChange={e => setImportKey(e.target.value)} placeholder="Private key (0x...)" className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white font-mono" />
                        <button onClick={handleImportWallet} className="w-full px-4 py-2 bg-cyan-600 hover:bg-cyan-500 rounded-lg text-sm font-medium">Import Wallet</button>
                      </div>
                    )}
                    {!showImport && <button onClick={() => setShowImport(true)} className="w-full text-sm text-slate-400 hover:text-slate-300">Import existing wallet{' >'}</button>}
                  </div>
                </div>
              ) : !wallet.isUnlocked ? (
                <div className="space-y-4">
                  <p className="text-sm text-slate-400">Wallet found: <span className="font-mono text-slate-300">{wallet.address}</span></p>
                  <div className="relative">
                    <input type={showPassword ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} placeholder="Enter password to unlock" onKeyDown={e => e.key === 'Enter' && handleUnlock()} className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white pr-10" />
                    <button onClick={() => setShowPassword(!showPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500">{showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}</button>
                  </div>
                  <button onClick={handleUnlock} className="w-full px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-sm font-medium">Unlock Wallet</button>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="bg-slate-800/50 rounded-lg p-4">
                    <p className="text-xs text-slate-500 mb-1">Wallet Address</p>
                    <p className="text-sm font-mono text-emerald-300">{wallet.address}</p>
                  </div>
                  {wallet.settlementAddress && (
                    <div className="bg-slate-800/50 rounded-lg p-4">
                      <p className="text-xs text-slate-500 mb-1">Settlement Address (auto-generated)</p>
                      <p className="text-sm font-mono text-cyan-300">{wallet.settlementAddress}</p>
                      <p className="text-xs text-slate-500 mt-2">Profits accumulate here. Transfer to your MetaMask or any wallet at your convenience.</p>
                    </div>
                  )}
                  <div className="bg-emerald-950/30 rounded-lg p-3 border border-emerald-800/30">
                    <p className="text-xs text-emerald-300 flex items-center gap-1.5"><Zap className="w-3 h-3" /> Zero-capital mode active. No gas tokens needed — SyncFee pays from profit.</p>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'opportunities' && (
          <div className="space-y-4">
            <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-6">
              <h3 className="text-sm font-semibold text-slate-300 mb-4">All Opportunities ({allOpportunities.length})</h3>
              {allOpportunities.length === 0 ? <p className="text-sm text-slate-500 text-center py-8">No opportunities found. Start the engine to scan.</p> : (
                <div className="space-y-2">
                  {allOpportunities.map((opp, i) => (
                    <div key={i} className="flex items-center gap-3 bg-slate-800/30 rounded-lg px-4 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded ${opp.opportunityType === 'triangular' ? 'bg-purple-950/50 text-purple-300' : 'bg-blue-950/50 text-blue-300'}`}>{opp.opportunityType}</span>
                      <span className="text-xs text-slate-400">{opp.chain}</span>
                      <span className="text-xs font-mono text-slate-300 flex-1 truncate">{opp.tokenPath.join(' -> ')}</span>
                      <span className="text-xs text-slate-500">{opp.dexPath.join(' / ')}</span>
                      <span className="text-xs font-semibold text-emerald-400">+${opp.netProfit.toFixed(2)}</span>
                      <span className="text-xs text-slate-500">{opp.profitMarginPct.toFixed(2)}%</span>
                      <span className="text-xs text-slate-400">{(opp.confidenceScore * 100).toFixed(0)}%</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'settings' && (
          <div className="max-w-lg space-y-4">
            <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-6">
              <h3 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2"><Settings className="w-4 h-4 text-cyan-400" /> Engine Settings</h3>
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div><p className="text-sm font-medium text-slate-300">Auto-Execute</p><p className="text-xs text-slate-500">Automatically execute profitable opportunities</p></div>
                  <button onClick={() => setAutoExecute(!autoExecute)} className={`w-12 h-6 rounded-full transition-colors ${autoExecute ? 'bg-emerald-600' : 'bg-slate-700'}`}>
                    <div className={`w-5 h-5 rounded-full bg-white transition-transform ${autoExecute ? 'translate-x-6' : 'translate-x-0.5'}`} />
                  </button>
                </div>
                <div>
                  <label className="text-sm font-medium text-slate-300">Min Profit (USD)</label>
                  <input type="text" value={minProfit} onChange={e => setMinProfit(e.target.value)} className="w-full px-3 py-2 mt-1 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white" />
                </div>
                <div>
                  <label className="text-sm font-medium text-slate-300">Scan Interval</label>
                  <p className="text-xs text-slate-500 mt-1">{SCAN_INTERVAL_MS / 1000} seconds — matches Polygon/Optimism block times (~2s), captures Arbitrum sub-second blocks</p>
                </div>
              </div>
            </div>

            <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-6">
              <h3 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2"><Zap className="w-4 h-4 text-emerald-400" /> Zero-Capital Launch Path</h3>
              <div className="space-y-3 text-sm text-slate-400">
                <div className="flex items-start gap-2"><CheckCircle className="w-4 h-4 text-emerald-400 flex-shrink-0 mt-0.5" /><div><p className="font-medium text-slate-300">Step 1: Create Gelato Account (Free)</p><p className="text-xs">Go to app.gelato.network, sign up. No credit card, no deposit.</p></div></div>
                <div className="flex items-start gap-2"><CheckCircle className="w-4 h-4 text-emerald-400 flex-shrink-0 mt-0.5" /><div><p className="font-medium text-slate-300">Step 2: Get Your API Key (Free)</p><p className="text-xs">Navigate to Relay, create an app, copy your sponsor API key. No payment needed for callWithSyncFee mode.</p></div></div>
                <div className="flex items-start gap-2"><CheckCircle className="w-4 h-4 text-emerald-400 flex-shrink-0 mt-0.5" /><div><p className="font-medium text-slate-300">Step 3: Add API Key to Supabase</p><p className="text-xs">Set GELATO_API_KEY as an edge function secret. App switches from simulation to live SyncFee execution.</p></div></div>
                <div className="flex items-start gap-2"><CheckCircle className="w-4 h-4 text-emerald-400 flex-shrink-0 mt-0.5" /><div><p className="font-medium text-slate-300">Step 4: Start Engine</p><p className="text-xs">Scanner finds arb, Gelato relays it, fee is deducted from the profit itself. Zero upfront capital.</p></div></div>
                <div className="mt-3 p-3 bg-slate-800/50 rounded-lg">
                  <p className="text-xs text-slate-500">Current Status: {relayerMode === 'syncfee' ? <span className="text-emerald-400">SyncFee Live — fee paid from profit, zero deposit</span> : <span className="text-amber-400">Simulation Mode — add GELATO_API_KEY to go live (free, no deposit)</span>}</p>
                </div>
              </div>
            </div>

            <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-6">
              <h3 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2"><Fuel className="w-4 h-4 text-amber-400" /> How callWithSyncFee Works (Zero Deposit)</h3>
              <div className="space-y-2 text-sm text-slate-400">
                <div className="flex items-center gap-2 text-xs"><span className="w-5 h-5 rounded-full bg-emerald-600 flex items-center justify-center text-white">1</span><span>Scanner finds profitable arbitrage opportunity</span></div>
                <div className="flex items-center gap-2 text-xs"><span className="w-5 h-5 rounded-full bg-emerald-600 flex items-center justify-center text-white">2</span><span>Gelato relays the transaction to the executor contract</span></div>
                <div className="flex items-center gap-2 text-xs"><span className="w-5 h-5 rounded-full bg-emerald-600 flex items-center justify-center text-white">3</span><span>Contract takes Balancer 0% flash loan (no collateral)</span></div>
                <div className="flex items-center gap-2 text-xs"><span className="w-5 h-5 rounded-full bg-emerald-600 flex items-center justify-center text-white">4</span><span>Arb executes, profit is generated in USDC</span></div>
                <div className="flex items-center gap-2 text-xs"><span className="w-5 h-5 rounded-full bg-emerald-600 flex items-center justify-center text-white">5</span><span>Contract pays Gelato's fee from the profit (callWithSyncFee)</span></div>
                <div className="flex items-center gap-2 text-xs"><span className="w-5 h-5 rounded-full bg-emerald-600 flex items-center justify-center text-white">6</span><span>Remaining profit goes to your settlement wallet</span></div>
                <p className="text-xs text-emerald-300 mt-2 pl-7">No 1Balance deposit. No upfront gas. Fee comes from the arb profit itself.</p>
              </div>
            </div>

            <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-6">
              <h3 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2"><Shield className="w-4 h-4 text-cyan-400" /> MEV Protection</h3>
              <div className="space-y-2 text-sm text-slate-400">
                <p>Transactions routed through Gelato's private mempool to protect against:</p>
                <ul className="space-y-1 ml-4">
                  <li className="flex items-center gap-2"><CheckCircle className="w-3 h-3 text-emerald-400" /> Front-running attacks</li>
                  <li className="flex items-center gap-2"><CheckCircle className="w-3 h-3 text-emerald-400" /> Sandwich attacks</li>
                  <li className="flex items-center gap-2"><CheckCircle className="w-3 h-3 text-emerald-400" /> MEV extraction bots</li>
                </ul>
              </div>
            </div>

            <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-6">
              <h3 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2"><Cpu className="w-4 h-4 text-cyan-400" /> Executor Contracts</h3>
              <div className="space-y-2">
                {CHAIN_KEYS.map(chainKey => {
                  const chain = CHAINS[chainKey];
                  const addr = deployedContracts[chainKey];
                  return (
                    <div key={chainKey} className="flex items-center gap-3 bg-slate-800/50 rounded-lg px-3 py-2">
                      <span className="text-sm font-medium w-24">{chain.name}</span>
                      {addr ? (<><code className="text-xs font-mono text-emerald-300 flex-1 truncate">{addr}</code><CheckCircle className="w-4 h-4 text-emerald-400" /></>) : (<><span className="text-xs text-slate-500 flex-1">Auto-computed on Start (zero gas)</span><Clock className="w-4 h-4 text-slate-500" /></>)}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function StatCard({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: string; color: string }) {
  const colorMap: Record<string, string> = { emerald: 'text-emerald-400 bg-emerald-950/30', cyan: 'text-cyan-400 bg-cyan-950/30', blue: 'text-blue-400 bg-blue-950/30' };
  return (
    <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-4">
      <div className={`w-8 h-8 rounded-lg flex items-center justify-center mb-2 ${colorMap[color] || colorMap.emerald}`}>{icon}</div>
      <p className="text-xs text-slate-500">{label}</p>
      <p className="text-lg font-bold text-white">{value}</p>
    </div>
  );
}

function StatusItem({ label, value, color }: { label: string; value: string; color: string }) {
  const colorMap: Record<string, string> = { emerald: 'text-emerald-400', cyan: 'text-cyan-400', slate: 'text-slate-500', amber: 'text-amber-400' };
  return (<div><p className="text-xs text-slate-500">{label}</p><p className={`text-sm font-semibold ${colorMap[color] || colorMap.slate}`}>{value}</p></div>);
}
