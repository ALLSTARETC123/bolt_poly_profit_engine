import { useState, useEffect, useRef, useCallback } from 'react';
import { ethers } from 'ethers';
import { createClient } from '@supabase/supabase-js';
import {
  Play, Pause, RefreshCcw, Wallet, Cpu, Activity, TrendingUp,
  Shield, CheckCircle, AlertTriangle, Clock,
  Settings, DollarSign, Fuel, Lock, Eye, EyeOff, Sparkles, Rocket,
} from 'lucide-react';
import { CHAINS, CHAIN_KEYS } from './lib/chains';
import { scanAllChains, ArbitrageOpportunity, ScanResult } from './lib/scanner';
import { deployExecutorGasless, executeArbitrageGasless, DeploymentResult, ExecutionResult } from './lib/executor';
import { generateWallet, importWallet, unlockWallet, loadWallet, updateDeployedContracts, WalletState } from './lib/wallet';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';
const supabase = createClient(supabaseUrl, supabaseKey);

type Tab = 'dashboard' | 'wallet' | 'opportunities' | 'settings';
interface Alert { id: string; type: 'success' | 'error' | 'warning' | 'info'; message: string; timestamp: number; }

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

  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [scanCount, setScanCount] = useState(0);
  const [totalProfit, setTotalProfit] = useState(0);
  const [executedCount, setExecutedCount] = useState(0);
  const [failedCount, setFailedCount] = useState(0);
  const [relayerMode, setRelayerMode] = useState<string | null>(null);
  const [gasTankBalance, setGasTankBalance] = useState<string | null>(null);

  const scanIntervalRef = useRef<number | null>(null);

  const pushAlert = useCallback((type: Alert['type'], message: string) => {
    setAlerts(prev => [{ id: Date.now().toString(), type, message, timestamp: Date.now() }, ...prev].slice(0, 20));
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const loaded = await loadWallet();
        setWalletLoaded(true);
        if (loaded) setWallet({ address: loaded.address, encryptedKey: loaded.encryptedKey, salt: loaded.salt, isUnlocked: false, signer: null });

        const { data: treasuryData } = await supabase.from('arb_treasury').select('*').order('created_at', { ascending: false }).limit(50);
        if (treasuryData) {
          const profit = (treasuryData as any[]).filter(t => t.type === 'profit').reduce((s, t) => s + parseFloat(String(t.amount_usd || '0')), 0);
          setTotalProfit(profit);
        }

        const { data: walletData } = await supabase.from('arb_wallet').select('deployed_contracts').order('created_at', { ascending: false }).limit(1).maybeSingle();
        if (walletData?.deployed_contracts) setDeployedContracts(walletData.deployed_contracts);

        try {
          const resp = await fetch(`${supabaseUrl}/functions/v1/relayer`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${supabaseKey}` },
            body: JSON.stringify({ action: 'health' }),
          });
          if (resp.ok) {
            const health = await resp.json();
            setRelayerMode(health.mode);
            if (health.balances) {
              const total = Object.values(health.balances).reduce((s: number, b: unknown) => s + parseFloat(String(b)), 0);
              if (total > 0) setGasTankBalance(total.toFixed(4));
            }
          } else { setRelayerMode('unconfigured'); }
        } catch { setRelayerMode('unconfigured'); }
      } catch (err) {
        setWalletLoaded(true);
        setRelayerMode('unconfigured');
      }
    })();
  }, []);

  const handleGenerateWallet = async () => {
    if (!password || password.length < 8) { pushAlert('error', 'Password must be at least 8 characters'); return; }
    try { const ws = await generateWallet(password); setWallet(ws); pushAlert('success', `Wallet created: ${ws.address.slice(0, 10)}...`); setActiveTab('dashboard'); }
    catch (err: any) { pushAlert('error', err.message); }
  };

  const handleImportWallet = async () => {
    if (!importKey || !password || password.length < 8) { pushAlert('error', 'Enter private key and password (min 8 chars)'); return; }
    try { const ws = await importWallet(importKey, password); setWallet(ws); pushAlert('success', `Wallet imported: ${ws.address.slice(0, 10)}...`); setShowImport(false); setImportKey(''); setActiveTab('dashboard'); }
    catch (err: any) { pushAlert('error', err.message); }
  };

  const handleUnlock = async () => {
    if (!wallet || !password) return;
    try { const ws = await unlockWallet(wallet.encryptedKey, wallet.salt, password); setWallet(ws); pushAlert('success', 'Wallet unlocked'); }
    catch { pushAlert('error', 'Invalid password'); }
  };

  const handleOneClickStart = async () => {
    if (!wallet?.signer) { pushAlert('error', 'Unlock your wallet first'); setActiveTab('wallet'); return; }
    setDeploying(true);
    pushAlert('info', 'Deploying contracts via gasless relayer...');

    for (const chainKey of CHAIN_KEYS) {
      if (!deployedContracts[chainKey]) {
        const result: DeploymentResult = await deployExecutorGasless(wallet.signer!, chainKey);
        if (result.success && result.contractAddress) {
          const updated = { ...deployedContracts, [chainKey]: result.contractAddress };
          setDeployedContracts(updated);
          await updateDeployedContracts(wallet.address, updated);
          pushAlert('success', `Contract deployed on ${CHAINS[chainKey].name} (${result.gasless ? 'zero gas' : 'relayer'})`);
        } else {
          pushAlert('warning', `Deploy on ${CHAINS[chainKey].name}: ${result.error?.slice(0, 80)}`);
        }
      }
    }

    setDeploying(false);
    setEngineRunning(true);
    setAutoExecute(true);
    pushAlert('success', 'Engine started — zero native tokens needed');
    runScan();
    scanIntervalRef.current = window.setInterval(() => runScan(), 15000);
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
              action: 'db_insert',
              table: 'arb_opportunities',
              data: opps.map(opp => ({
                chain: opp.chain, opportunity_type: opp.opportunityType, token_path: opp.tokenPath, dex_path: opp.dexPath,
                flash_loan_asset: opp.flashLoanAsset, flash_loan_amount: opp.flashLoanAmount,
                estimated_profit: opp.estimatedProfit, estimated_gas_cost: opp.estimatedGasCost,
                net_profit: opp.netProfit, profit_margin_pct: opp.profitMarginPct,
                confidence_score: opp.confidenceScore, flash_provider: opp.flashProvider,
                block_number: opp.blockNumber, executed: false,
              })),
            }),
          });
        } catch { /* non-fatal */ }
      }

      if (autoExecute && wallet?.signer) {
        const min = parseFloat(minProfit) || 0.10;
        for (const opp of opps.filter(o => o.netProfit >= min).slice(0, 3)) { await executeOpportunity(opp); }
      }
    } catch (err: any) {
      pushAlert('error', `Scan failed: ${err.message?.slice(0, 100)}`);
    }
  };

  const executeOpportunity = async (opp: ArbitrageOpportunity) => {
    if (!wallet?.signer) { pushAlert('error', 'Unlock wallet to execute'); return; }
    const executorAddress = deployedContracts[opp.chain];
    if (!executorAddress) { pushAlert('error', `No executor contract on ${opp.chain}`); return; }
    setExecuting(true);
    pushAlert('info', `Executing arb on ${opp.chain} via gasless relay...`);
    const result: ExecutionResult = await executeArbitrageGasless(wallet.signer!, opp.chain, opp, executorAddress, null);
    if (result.success) {
      setExecutedCount(prev => prev + 1);
      setTotalProfit(prev => prev + (result.profitUsd || 0));
      pushAlert('success', `Arb executed on ${opp.chain}: +$${result.profitUsd?.toFixed(2)} (zero gas!)`);
      await fetch(`${supabaseUrl}/functions/v1/relayer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${supabaseKey}` },
        body: JSON.stringify({
          action: 'db_insert',
          table: 'arb_treasury',
          data: { type: 'profit', amount_usd: result.profitUsd || 0, chain: opp.chain, tx_hash: result.txHash, opportunity_type: opp.opportunityType },
        }),
      });
    } else {
      setFailedCount(prev => prev + 1);
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
                <Sparkles className="w-3 h-3 text-emerald-400" /> Zero Gas · Gelato Relay · Balancer V2 + DODO V2
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {relayerMode && relayerMode !== 'unconfigured' && (
              <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-950/50 border border-emerald-800/50">
                <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                <span className="text-xs text-emerald-300">{relayerMode === 'gelato' ? 'Gelato Gas Tank' : 'Direct Relay'}</span>
              </div>
            )}
            {wallet && (
              <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-800/50 border border-slate-700/50">
                <Wallet className="w-3.5 h-3.5 text-slate-400" />
                <span className="text-xs font-mono text-slate-300">{wallet.address.slice(0, 6)}...{wallet.address.slice(-4)}</span>
                {wallet.isUnlocked ? <Lock className="w-3 h-3 text-emerald-400" /> : <Lock className="w-3 h-3 text-amber-400" />}
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
              className={`px-4 py-2 text-sm font-medium capitalize border-b-2 transition-colors ${
                activeTab === tab ? 'border-emerald-500 text-emerald-400' : 'border-transparent text-slate-500 hover:text-slate-300'
              }`}>{tab}</button>
          ))}
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6">
        {alerts.length > 0 && (
          <div className="mb-4 space-y-1.5 max-h-32 overflow-y-auto">
            {alerts.slice(0, 5).map(alert => (
              <div key={alert.id} className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm ${
                alert.type === 'success' ? 'bg-emerald-950/50 border border-emerald-800/50 text-emerald-300' :
                alert.type === 'error' ? 'bg-red-950/50 border border-red-800/50 text-red-300' :
                alert.type === 'warning' ? 'bg-amber-950/50 border border-amber-800/50 text-amber-300' :
                'bg-blue-950/50 border border-blue-800/50 text-blue-300'
              }`}>
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
              <StatCard icon={<DollarSign />} label="Total Profit" value={`$${totalProfit.toFixed(2)}`} color="emerald" />
              <StatCard icon={<TrendingUp />} label="Opportunities" value={String(allOpportunities.length)} color="cyan" />
              <StatCard icon={<CheckCircle />} label="Executed" value={String(executedCount)} color="emerald" />
              <StatCard icon={<Activity />} label="Scans" value={String(scanCount)} color="blue" />
            </div>

            <div className="bg-gradient-to-r from-emerald-950/50 to-cyan-950/50 rounded-xl border border-emerald-800/30 p-4">
              <div className="flex items-center gap-3">
                <Sparkles className="w-5 h-5 text-emerald-400 flex-shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-emerald-300">Zero-Gas Launch Active</p>
                  <p className="text-xs text-slate-400">
                    No native tokens needed. Gelato Gas Tank pays gas from USDC.
                    The first arbitrage profit funds all subsequent gas — zero upfront capital.
                    {gasTankBalance && ` Gas Tank: ${gasTankBalance} ETH equivalent`}
                  </p>
                </div>
              </div>
            </div>

            <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-6">
              <h3 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2">
                <Cpu className="w-4 h-4 text-cyan-400" /> Engine Status
              </h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <StatusItem label="Engine" value={engineRunning ? 'RUNNING' : 'STOPPED'} color={engineRunning ? 'emerald' : 'slate'} />
                <StatusItem label="Auto-Execute" value={autoExecute ? 'ON' : 'OFF'} color={autoExecute ? 'emerald' : 'slate'} />
                <StatusItem label="Gas Mode" value={relayerMode === 'gelato' ? 'GELATO' : relayerMode === 'direct' ? 'RELAYER' : 'PENDING'} color={relayerMode === 'gelato' ? 'emerald' : 'amber'} />
                <StatusItem label="Flash Provider" value="Balancer + DODO" color="emerald" />
              </div>
            </div>

            <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-6">
              <h3 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2">
                <Activity className="w-4 h-4 text-cyan-400" /> Chain Scanner Status
              </h3>
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
                      <span className="text-xs text-slate-500">ID: {chain.id}</span>
                      <span className="text-xs text-slate-400">{oppCount} opps</span>
                      {result?.scanTimeMs && <span className="text-xs text-slate-500">{result.scanTimeMs}ms</span>}
                      <div className="flex-1" />
                      {hasContract ? (
                        <span className="text-xs text-emerald-400 flex items-center gap-1"><CheckCircle className="w-3 h-3" /> Deployed</span>
                      ) : (
                        <span className="text-xs text-slate-500 flex items-center gap-1"><Clock className="w-3 h-3" /> Auto-deploys</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-6">
              <h3 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-emerald-400" /> Live Opportunities
              </h3>
              {allOpportunities.length === 0 ? (
                <p className="text-sm text-slate-500 text-center py-8">{engineRunning ? 'Scanning...' : 'Start the engine to scan for arbitrage opportunities'}</p>
              ) : (
                <div className="space-y-2">
                  {allOpportunities.slice(0, 10).map((opp, i) => (
                    <div key={i} className="flex items-center gap-3 bg-slate-800/30 rounded-lg px-4 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded ${
                        opp.opportunityType === 'triangular' ? 'bg-purple-950/50 text-purple-300' :
                        opp.opportunityType === 'two_dex' ? 'bg-blue-950/50 text-blue-300' : 'bg-cyan-950/50 text-cyan-300'
                      }`}>{opp.opportunityType}</span>
                      <span className="text-xs text-slate-400">{opp.chain}</span>
                      <span className="text-xs font-mono text-slate-300 flex-1 truncate">{opp.tokenPath.join(' \u003e ')}</span>
                      <span className="text-xs text-slate-500">{opp.dexPath.join(' / ')}</span>
                      <span className="text-xs font-semibold text-emerald-400">+${opp.netProfit.toFixed(2)}</span>
                      <span className="text-xs text-slate-500">{opp.profitMarginPct.toFixed(2)}%</span>
                      <span className={`text-xs px-2 py-0.5 rounded ${
                        opp.flashProvider === 'dodo_v2' ? 'bg-orange-950/50 text-orange-300' : 'bg-emerald-950/50 text-emerald-300'
                      }`}>{opp.flashProvider === 'dodo_v2' ? 'DODO' : 'BAL'}</span>
                      {wallet?.isUnlocked && deployedContracts[opp.chain] && (
                        <button onClick={() => executeOpportunity(opp)} disabled={executing}
                          className="px-2 py-1 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 rounded text-xs font-medium">Execute</button>
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
              <h3 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2">
                <Wallet className="w-4 h-4 text-cyan-400" /> Wallet Management
              </h3>
              {!walletLoaded ? <p className="text-sm text-slate-500">Loading...</p> : !wallet ? (
                <div className="space-y-4">
                  <p className="text-sm text-slate-400">Create a new wallet or import an existing one. Your private key is encrypted with AES-256-GCM. You never need native tokens — Gelato pays all gas.</p>
                  <div className="space-y-3">
                    <div className="relative">
                      <input type={showPassword ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} placeholder="Password (min 8 chars)"
                        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white pr-10" />
                      <button onClick={() => setShowPassword(!showPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500">
                        {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                    <button onClick={handleGenerateWallet} className="w-full px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-sm font-medium">Generate New Wallet</button>
                    {showImport && (
                      <div className="space-y-2 pt-2 border-t border-slate-800">
                        <input type="text" value={importKey} onChange={e => setImportKey(e.target.value)} placeholder="Private key (0x...)"
                          className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white font-mono" />
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
                    <input type={showPassword ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} placeholder="Enter password to unlock" onKeyDown={e => e.key === 'Enter' && handleUnlock()}
                      className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white pr-10" />
                    <button onClick={() => setShowPassword(!showPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500">
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                  <button onClick={handleUnlock} className="w-full px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-sm font-medium">Unlock Wallet</button>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="bg-slate-800/50 rounded-lg p-4">
                    <p className="text-xs text-slate-500 mb-1">Wallet Address</p>
                    <p className="text-sm font-mono text-emerald-300">{wallet.address}</p>
                  </div>
                  <div className="bg-emerald-950/30 rounded-lg p-3 border border-emerald-800/30">
                    <p className="text-xs text-emerald-300 flex items-center gap-1.5">
                      <Sparkles className="w-3 h-3" /> Zero-gas mode — no native tokens needed. Gelato Gas Tank pays all gas from USDC.
                    </p>
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
                      <span className={`text-xs px-2 py-0.5 rounded ${
                        opp.opportunityType === 'triangular' ? 'bg-purple-950/50 text-purple-300' :
                        opp.opportunityType === 'two_dex' ? 'bg-blue-950/50 text-blue-300' : 'bg-cyan-950/50 text-cyan-300'
                      }`}>{opp.opportunityType}</span>
                      <span className="text-xs text-slate-400">{opp.chain}</span>
                      <span className="text-xs font-mono text-slate-300 flex-1 truncate">{opp.tokenPath.join(' \u003e ')}</span>
                      <span className="text-xs text-slate-500">{opp.dexPath.join(' / ')}</span>
                      <span className="text-xs font-semibold text-emerald-400">+${opp.netProfit.toFixed(2)}</span>
                      <span className="text-xs text-slate-500">{opp.profitMarginPct.toFixed(2)}%</span>
                      <span className="text-xs text-slate-400">{(opp.confidenceScore * 100).toFixed(0)}%</span>
                      <span className={`text-xs px-2 py-0.5 rounded ${
                        opp.flashProvider === 'dodo_v2' ? 'bg-orange-950/50 text-orange-300' : 'bg-emerald-950/50 text-emerald-300'
                      }`}>{opp.flashProvider === 'dodo_v2' ? 'DODO' : 'BAL'}</span>
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
              <h3 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2">
                <Settings className="w-4 h-4 text-cyan-400" /> Engine Settings
              </h3>
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
              </div>
            </div>

            <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-6">
              <h3 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-emerald-400" /> Zero-Gas Architecture
              </h3>
              <div className="space-y-3 text-sm text-slate-400">
                <div className="flex items-start gap-2"><CheckCircle className="w-4 h-4 text-emerald-400 flex-shrink-0 mt-0.5" /><div><p className="font-medium text-slate-300">Gelato Gas Tank</p><p className="text-xs">Deposit USDC once (any chain). Gelato pays gas on ALL chains. No native tokens needed by anyone.</p></div></div>
                <div className="flex items-start gap-2"><CheckCircle className="w-4 h-4 text-emerald-400 flex-shrink-0 mt-0.5" /><div><p className="font-medium text-slate-300">Self-Funding from First Arb</p><p className="text-xs">The first profitable arbitrage generates USDC. 10% auto-deposits to the Gas Tank, funding all future gas. Zero upfront capital.</p></div></div>
                <div className="flex items-start gap-2"><CheckCircle className="w-4 h-4 text-emerald-400 flex-shrink-0 mt-0.5" /><div><p className="font-medium text-slate-300">Profit Distribution</p><p className="text-xs">85% to your wallet · 5% to Gelato relay fee · 10% to Gas Tank reserve. No reinvestment, no lockup.</p></div></div>
                <div className="flex items-start gap-2"><CheckCircle className="w-4 h-4 text-emerald-400 flex-shrink-0 mt-0.5" /><div><p className="font-medium text-slate-300">EIP-712 Gasless Signing</p><p className="text-xs">You sign off-chain (free). Gelato relays the transaction. Your wallet never holds native tokens.</p></div></div>
                <div className="flex items-start gap-2"><CheckCircle className="w-4 h-4 text-emerald-400 flex-shrink-0 mt-0.5" /><div><p className="font-medium text-slate-300">Private Mempool</p><p className="text-xs">Gelato routes through private mempools, protecting against front-running and sandwich attacks.</p></div></div>
                <div className="mt-3 p-3 bg-slate-800/50 rounded-lg">
                  <p className="text-xs text-slate-500">Relayer Status: {relayerMode === 'gelato' ? <span className="text-emerald-400">Gelato Gas Tank Active</span> : relayerMode === 'direct' ? <span className="text-cyan-400">Direct Relay (relayer wallet pays gas)</span> : relayerMode === 'unconfigured' ? <span className="text-amber-400">Unconfigured — set GELATO_API_KEY or RELAYER_PRIVATE_KEY</span> : <span className="text-slate-400">Checking...</span>}</p>
                </div>
              </div>
            </div>

            <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-6">
              <h3 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2">
                <Shield className="w-4 h-4 text-cyan-400" /> MEV Protection
              </h3>
              <div className="space-y-2 text-sm text-slate-400">
                <p>Transactions are routed through private mempools to protect against:</p>
                <ul className="space-y-1 ml-4">
                  <li className="flex items-center gap-2"><CheckCircle className="w-3 h-3 text-emerald-400" /> Front-running attacks</li>
                  <li className="flex items-center gap-2"><CheckCircle className="w-3 h-3 text-emerald-400" /> Sandwich attacks</li>
                  <li className="flex items-center gap-2"><CheckCircle className="w-3 h-3 text-emerald-400" /> MEV extraction bots</li>
                </ul>
              </div>
            </div>

            <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-6">
              <h3 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2">
                <Fuel className="w-4 h-4 text-amber-400" /> Self-Funding Gas Cycle
              </h3>
              <div className="space-y-2 text-sm text-slate-400">
                <div className="flex items-center gap-2 text-xs"><span className="w-5 h-5 rounded-full bg-emerald-600 flex items-center justify-center text-white">1</span><span>Scanner finds profitable arbitrage opportunity</span></div>
                <div className="flex items-center gap-2 text-xs"><span className="w-5 h-5 rounded-full bg-emerald-600 flex items-center justify-center text-white">2</span><span>User signs EIP-712 message (free, off-chain)</span></div>
                <div className="flex items-center gap-2 text-xs"><span className="w-5 h-5 rounded-full bg-emerald-600 flex items-center justify-center text-white">3</span><span>Gelato relays transaction, pays gas from Gas Tank</span></div>
                <div className="flex items-center gap-2 text-xs"><span className="w-5 h-5 rounded-full bg-emerald-600 flex items-center justify-center text-white">4</span><span>Flash loan executes, profit generated in USDC</span></div>
                <div className="flex items-center gap-2 text-xs"><span className="w-5 h-5 rounded-full bg-emerald-600 flex items-center justify-center text-white">5</span><span>85% to wallet · 5% pays Gelato fee · 10% replenishes Gas Tank</span></div>
                <div className="flex items-center gap-2 text-xs"><span className="w-5 h-5 rounded-full bg-cyan-600 flex items-center justify-center text-white">↻</span><span className="text-cyan-300">Gas Tank now has USDC — next arb is fully self-funded</span></div>
              </div>
            </div>

            <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-6">
              <h3 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2">
                <Cpu className="w-4 h-4 text-cyan-400" /> Executor Contracts
              </h3>
              <div className="space-y-2">
                {CHAIN_KEYS.map(chainKey => {
                  const chain = CHAINS[chainKey];
                  const addr = deployedContracts[chainKey];
                  return (
                    <div key={chainKey} className="flex items-center gap-3 bg-slate-800/50 rounded-lg px-3 py-2">
                      <span className="text-sm font-medium w-24">{chain.name}</span>
                      {addr ? (<><code className="text-xs font-mono text-emerald-300 flex-1 truncate">{addr}</code><CheckCircle className="w-4 h-4 text-emerald-400" /></>) :
                        (<><span className="text-xs text-slate-500 flex-1">Auto-deploys on Start (zero gas)</span><Clock className="w-4 h-4 text-slate-500" /></>)}
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
      <div className={`w-8 h-8 rounded-lg flex items-center justify-center mb-2 ${colorMap[color]}`}>{icon}</div>
      <p className="text-xs text-slate-500">{label}</p>
      <p className="text-lg font-bold text-white">{value}</p>
    </div>
  );
}

function StatusItem({ label, value, color }: { label: string; value: string; color: string }) {
  const colorMap: Record<string, string> = { emerald: 'text-emerald-400', cyan: 'text-cyan-400', slate: 'text-slate-500', amber: 'text-amber-400' };
  return (<div><p className="text-xs text-slate-500">{label}</p><p className={`text-sm font-semibold ${colorMap[color]}`}>{value}</p></div>);
}
