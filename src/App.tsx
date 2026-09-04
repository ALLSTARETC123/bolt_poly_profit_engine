import { useState, useEffect, useRef, useCallback } from 'react';
import type { Session } from '@supabase/supabase-js';
import {
  Play, Pause, RefreshCcw, Wallet, Activity, TrendingUp,
  CheckCircle, AlertTriangle, Rocket, Zap,
  ExternalLink, Copy, ArrowRight, CheckCircle2, LogOut, Mail, Lock,
  Coins, DollarSign, Cpu, Eye, EyeOff, Sparkles, Droplet, Fuel,
  BarChart3, Target, Settings, Bug, KeyRound, Shield,
} from 'lucide-react';
import { supabase } from './lib/supabase';
import { CHAINS, CHAIN_KEYS, SCAN_INTERVAL_MS } from './lib/chains';
import { scanAllChains, type ArbitrageOpportunity, type ScanResult } from './lib/scanner';
import {
  generateWallet, importWallet, unlockWallet, loadWallet,
  updateDeployedContracts, getDeployedContracts, type WalletState,
} from './lib/wallet';
import {
  deployExecutor, executeArbitrage, checkAlchemyHealth, setAlchemyConfig,
  getAlchemyConfig, type ExecutionResult,
} from './lib/executor';
import {
  fetchTreasuryRecords, fetchExecutionRecords, fetchOpportunityRecords,
  fetchEngineStatus, insertOpportunity, insertExecution, updateExecutionStatus,
  insertTreasuryEntry, updateEngineStatus, incrementEngineTrades,
  fetchTreasurySummary, ensureEngineStatusRows, ensureConfigRows,
  fetchOperatorConfig,
  type TreasuryRecord, type ExecutionRecord, type OpportunityRecord,
  type EngineStatusRecord,
} from './lib/operator';
import { getModelStats, type ZScoreSignal } from './lib/statArb';

interface AlertItem { id: string; type: 'success' | 'error' | 'warning' | 'info'; message: string; timestamp: number; }

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authMode, setAuthMode] = useState<'signin' | 'signup'>('signup');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [authSubmitting, setAuthSubmitting] = useState(false);

  const [wallet, setWallet] = useState<WalletState | null>(null);
  const [walletLoaded, setWalletLoaded] = useState(false);
  const [password, setPassword] = useState('');
  const [importKeyInput, setImportKeyInput] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const [engineRunning, setEngineRunning] = useState(false);
  const [autoExecute, setAutoExecute] = useState(true);
  const [minProfit, setMinProfit] = useState('0.10');
  const [alchemyApiKey, setAlchemyApiKey] = useState('');
  const [alchemyPolicyId, setAlchemyPolicyId] = useState('');
  const [alchemyStatus, setAlchemyStatus] = useState<{ configured: boolean; mode: string; paymasterPolicyId?: string } | null>(null);

  const [scanResults, setScanResults] = useState<ScanResult[]>([]);
  const [allOpportunities, setAllOpportunities] = useState<ArbitrageOpportunity[]>([]);
  const [executing, setExecuting] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [deployedContracts, setDeployedContracts] = useState<Record<string, string>>({});
  const [setupComplete, setSetupComplete] = useState(false);

  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [scanCount, setScanCount] = useState(0);
  const [totalProfit, setTotalProfit] = useState(0);
  const [executedCount, setExecutedCount] = useState(0);

  const [treasuryRecords, setTreasuryRecords] = useState<TreasuryRecord[]>([]);
  const [executionRecords, setExecutionRecords] = useState<ExecutionRecord[]>([]);
  const [opportunityRecords, setOpportunityRecords] = useState<OpportunityRecord[]>([]);
  const [engineStatusRecords, setEngineStatusRecords] = useState<EngineStatusRecord[]>([]);
  const [treasurySummary, setTreasurySummary] = useState({ totalProfit: 0, totalGas: 0, totalFlashFee: 0, totalDeploy: 0 });
  const [statArbStats, setStatArbStats] = useState<{ pair: string; chain: string; samples: number; mean: number; stdDev: number; currentZ: number }[]>([]);

  const scanIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const pushAlert = useCallback((type: AlertItem['type'], message: string) => {
    setAlerts(prev => [{ id: Date.now().toString(), type, message, timestamp: Date.now() }, ...prev].slice(0, 20));
  }, []);

  const refreshDbData = useCallback(async () => {
    const [treas, execs, opps, status, summary] = await Promise.all([
      fetchTreasuryRecords(), fetchExecutionRecords(), fetchOpportunityRecords(),
      fetchEngineStatus(), fetchTreasurySummary(),
    ]);
    setTreasuryRecords(treas);
    setExecutionRecords(execs);
    setOpportunityRecords(opps);
    setEngineStatusRecords(status);
    setTreasurySummary(summary);
    setTotalProfit(summary.totalProfit);
    setStatArbStats(getModelStats());
  }, []);

  useEffect(() => {
    if (!supabase) { setAuthLoading(false); return; }
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      setSession(s);
      setAuthLoading(false);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
    });
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) return;
    (async () => {
      await ensureEngineStatusRows();
      await ensureConfigRows();
      try {
        const loaded = await loadWallet();
        setWalletLoaded(true);
        if (loaded) {
          setWallet(loaded);
          const contracts = await getDeployedContracts(loaded.address);
          if (contracts && Object.keys(contracts).length > 0) {
            setDeployedContracts(contracts);
            setSetupComplete(true);
          }
        }
      } catch { setWalletLoaded(true); }
      await refreshDbData();
      const health = await checkAlchemyHealth();
      setAlchemyStatus(health);
      const config = await getAlchemyConfig();
      if (config?.apiKey) setAlchemyApiKey(config.apiKey);
      if (config?.paymasterPolicyId) setAlchemyPolicyId(config.paymasterPolicyId);
    })();
  }, [refreshDbData, session]);

  const handleAuth = async () => {
    if (!supabase || !authEmail || !authPassword) { setAuthError('Enter email and password'); return; }
    setAuthSubmitting(true);
    setAuthError('');
    try {
      if (authMode === 'signup') {
        const { error } = await supabase.auth.signUp({ email: authEmail, password: authPassword });
        if (error) throw error;
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email: authEmail, password: authPassword });
        if (error) throw error;
      }
      setAuthEmail(''); setAuthPassword('');
    } catch (err: unknown) {
      setAuthError(err instanceof Error ? err.message : String(err));
    } finally {
      setAuthSubmitting(false);
    }
  };

  const handleSignOut = async () => {
    if (!supabase) return;
    await supabase.auth.signOut();
    setSession(null);
    setWallet(null);
    setWalletLoaded(false);
    setEngineRunning(false);
    setSetupComplete(false);
    if (scanIntervalRef.current) { clearInterval(scanIntervalRef.current); scanIntervalRef.current = null; }
  };

  const handleGenerateWallet = async () => {
    if (!password || password.length < 8) { pushAlert('error', 'Password must be at least 8 characters'); return; }
    try {
      const ws = await generateWallet(password);
      setWallet(ws); setPassword('');
      pushAlert('success', `Wallet created: ${ws.address.slice(0, 10)}...`);
    } catch (err: unknown) { pushAlert('error', String(err)); }
  };

  const handleImportWallet = async () => {
    if (!importKeyInput || !password || password.length < 8) { pushAlert('error', 'Enter private key and password (min 8 chars)'); return; }
    try {
      const ws = await importWallet(importKeyInput, password);
      setWallet(ws); setPassword(''); setImportKeyInput(''); setShowImport(false);
      pushAlert('success', `Wallet imported: ${ws.address.slice(0, 10)}...`);
    } catch (err: unknown) { pushAlert('error', String(err)); }
  };

  const handleUnlock = async () => {
    if (!wallet || !password) return;
    try {
      const ws = await unlockWallet(wallet.encryptedKey, wallet.salt, password);
      setWallet(ws); setPassword('');
      pushAlert('success', 'Wallet unlocked');
    } catch { pushAlert('error', 'Invalid password'); }
  };

  const handleSaveAlchemyKey = async () => {
    if (!alchemyApiKey.trim()) { pushAlert('error', 'Enter your Alchemy API key'); return; }
    try {
      await setAlchemyConfig(alchemyApiKey.trim(), alchemyPolicyId.trim() || undefined);
      const health = await checkAlchemyHealth();
      setAlchemyStatus(health);
      pushAlert('success', 'Alchemy API key saved');
    } catch (err: unknown) { pushAlert('error', String(err)); }
  };

  const handleOneTapLaunch = async () => {
    if (!wallet?.signer) { pushAlert('error', 'Unlock your wallet first'); return; }
    setDeploying(true);
    pushAlert('info', 'Launching: deploying contracts + starting scanner...');

    const bytecodeResp = await fetch('/src/lib/FlashArbExecutor.bin.txt').then(r => r.text()).catch(() => '');
    if (!bytecodeResp) { pushAlert('error', 'Cannot load contract bytecode'); setDeploying(false); return; }
    const bytecode = bytecodeResp.trim();

    for (const chainKey of CHAIN_KEYS) {
      if (deployedContracts[chainKey]) continue;
      const chain = CHAINS[chainKey];
      const constructorArgs = '0x' + 
        chain.balancerVault.slice(2).padStart(64, '0') +
        chain.uniswapV3Router.slice(2).padStart(64, '0') +
        chain.usdcAddress.slice(2).padStart(64, '0') +
        chain.alchemyPaymasterAddress.slice(2).padStart(64, '0');
      const result = await deployExecutor(wallet.signer as never, chainKey, bytecode, constructorArgs);
      if (result.success && result.txHash) {
        const provider = new (await import('ethers')).JsonRpcProvider(chain.rpcUrl, { chainId: chain.chainId, name: chain.name }, { staticNetwork: true });
        const receipt = await provider.getTransactionReceipt(result.txHash);
        const addr = receipt?.contractAddress;
        if (addr) {
          const updated = { ...deployedContracts, [chainKey]: addr };
          setDeployedContracts(updated);
          await updateDeployedContracts(wallet.address, updated);
          pushAlert('success', `Executor deployed on ${chain.name}`);
          await insertTreasuryEntry({ execution_id: null, amount_usd: 0, type: 'deployment', chain: chainKey });
        }
      } else {
        pushAlert('warning', `Deploy on ${chain.name} skipped: ${result.error?.slice(0, 80) || 'no gas'}`);
      }
    }

    setDeploying(false);
    setEngineRunning(true);
    setSetupComplete(true);
    pushAlert('success', `Engine live — scanning real DEX prices every ${SCAN_INTERVAL_MS / 1000}s`);
    runScan();
    scanIntervalRef.current = setInterval(() => runScan(), SCAN_INTERVAL_MS);
  };

  const stopEngine = async () => {
    setEngineRunning(false);
    if (scanIntervalRef.current) { clearInterval(scanIntervalRef.current); scanIntervalRef.current = null; }
    for (const chainKey of CHAIN_KEYS) {
      await updateEngineStatus(chainKey, 'idle', 0, 0, 0);
    }
    pushAlert('info', 'Engine stopped');
    await refreshDbData();
  };

  const runScan = async () => {
    setScanCount(prev => prev + 1);
    try {
      const results = await scanAllChains();
      setScanResults(results);
      const opps = results.flatMap(r => r.opportunities).sort((a, b) => b.netProfit - a.netProfit);
      setAllOpportunities(opps);

      for (const result of results) {
        if (result.error) {
          await updateEngineStatus(result.chain, 'error', result.blockNumber, 0, result.scanTimeMs, result.error);
        } else {
          await updateEngineStatus(result.chain, 'scanning', result.blockNumber, result.opportunities.length, result.scanTimeMs);
        }
        for (const opp of result.opportunities.slice(0, 5)) {
          await insertOpportunity({
            chain: opp.chain, opportunity_type: opp.strategy,
            token_path: opp.tokenPath, dex_path: opp.dexPath,
            pool_addresses: [], flash_loan_provider: 'balancer',
            flash_loan_asset: opp.flashLoanAsset, flash_loan_amount: opp.flashLoanAmount,
            estimated_profit: opp.estimatedProfit, estimated_gas_cost: opp.estimatedGasCost,
            net_profit: opp.netProfit, profit_margin_pct: opp.profitMarginPct,
            pool_reserves: {}, price_impact: opp.priceImpact,
            confidence_score: opp.confidenceScore, status: 'detected',
            block_number: opp.blockNumber, expires_at: new Date(Date.now() + 30000).toISOString(),
          });
        }
      }

      if (autoExecute && wallet?.signer) {
        const min = parseFloat(minProfit) || 0.10;
        for (const opp of opps.filter(o => o.netProfit >= min).slice(0, 3)) {
          await executeOpportunity(opp);
        }
      }
      await refreshDbData();
    } catch (err: unknown) { pushAlert('error', `Scan failed: ${String(err).slice(0, 100)}`); }
  };

  const executeOpportunity = async (opp: ArbitrageOpportunity) => {
    if (!wallet?.signer) { pushAlert('error', 'Unlock wallet to execute'); return; }
    const executorAddress = deployedContracts[opp.chain];
    if (!executorAddress) { pushAlert('error', `No executor contract on ${opp.chain}`); return; }
    setExecuting(true);
    pushAlert('info', `Executing ${opp.strategy} arb on ${opp.chain}: ${opp.tokenPath.join(' -> ')}`);

    const execId = await insertExecution({
      opportunity_id: null, chain: opp.chain, tx_hash: null,
      flash_loan_amount: opp.flashLoanAmount, flash_loan_fee: 0,
      gas_used: 0, gas_cost_usd: opp.estimatedGasCost,
      revenue_gross: opp.estimatedProfit, revenue_net: opp.netProfit,
      status: 'pending', error_message: null, block_number: opp.blockNumber,
      executor_contract: executorAddress,
    });

    const result: ExecutionResult = await executeArbitrage(
      wallet.signer as never, opp.chain, opp.tokenPath, opp.dexPath,
      opp.flashLoanAmount, opp.flashLoanAsset, executorAddress
    );

    if (result.success) {
      setExecutedCount(prev => prev + 1);
      if (execId) await updateExecutionStatus(execId, 'executed', result.txHash || undefined);
      await incrementEngineTrades(opp.chain);
      await insertTreasuryEntry({ execution_id: execId, amount_usd: opp.netProfit, type: 'profit', chain: opp.chain });
      await insertTreasuryEntry({ execution_id: execId, amount_usd: opp.estimatedGasCost, type: 'gas_cost', chain: opp.chain });
      pushAlert('success', `Arb submitted on ${opp.chain}: tx ${result.txHash?.slice(0, 16) || 'pending'}...`);
    } else {
      if (execId) await updateExecutionStatus(execId, 'failed', undefined, result.error);
      pushAlert('error', `Execution failed on ${opp.chain}: ${result.error?.slice(0, 100)}`);
    }
    setExecuting(false);
  };

  const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString();
  const fmtDate = (iso: string) => new Date(iso).toLocaleString();
  const copyToClipboard = (text: string) => { navigator.clipboard.writeText(text); pushAlert('info', 'Copied'); };

  const netRevenue = treasurySummary.totalProfit - treasurySummary.totalGas - treasurySummary.totalFlashFee - treasurySummary.totalDeploy;
  const contractsDeployed = Object.keys(deployedContracts).length;

  if (authLoading) {
    return (
      <div className="min-h-screen bg-[#0a0e17] flex items-center justify-center">
        <div className="flex items-center gap-3 text-slate-400">
          <RefreshCcw className="w-5 h-5 animate-spin" />
          <span>Loading...</span>
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="min-h-screen bg-[#0a0e17] flex items-center justify-center px-4">
        <div className="w-full max-w-md">
          <div className="flex items-center gap-3 mb-8 justify-center">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-emerald-500 to-cyan-600 flex items-center justify-center shadow-lg shadow-emerald-500/20">
              <Rocket className="w-7 h-7 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-white">Flash Arb Engine</h1>
              <p className="text-xs text-slate-500">Zero Capital · Alchemy Sponsored · Flashbots Protected</p>
            </div>
          </div>
          <div className="bg-slate-900/50 rounded-2xl border border-slate-800 p-6 shadow-xl">
            <h2 className="text-sm font-semibold text-slate-300 mb-4">
              {authMode === 'signin' ? 'Sign In' : 'Create Free Account'}
            </h2>
            {authError && (
              <div className="mb-3 px-3 py-2 rounded-lg bg-red-950/50 border border-red-800/50 text-red-300 text-xs flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 flex-shrink-0" /> {authError}
              </div>
            )}
            <div className="space-y-3">
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                <input type="email" value={authEmail} onChange={e => setAuthEmail(e.target.value)}
                  placeholder="Email address"
                  className="w-full pl-10 pr-3 py-2.5 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white focus:border-emerald-600 focus:outline-none transition-colors" />
              </div>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                <input type="password" value={authPassword} onChange={e => setAuthPassword(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleAuth()}
                  placeholder="Password (min 6 chars)"
                  className="w-full pl-10 pr-3 py-2.5 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white focus:border-emerald-600 focus:outline-none transition-colors" />
              </div>
              <button onClick={handleAuth} disabled={authSubmitting}
                className="w-full px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 rounded-lg text-sm font-medium flex items-center justify-center gap-2 transition-colors">
                {authSubmitting ? <RefreshCcw className="w-4 h-4 animate-spin" /> : null}
                {authMode === 'signin' ? 'Sign In' : 'Create Account'}
              </button>
              <button onClick={() => { setAuthMode(authMode === 'signin' ? 'signup' : 'signin'); setAuthError(''); }}
                className="w-full text-xs text-slate-400 hover:text-slate-300">
                {authMode === 'signin' ? "Don't have an account? Sign up free" : 'Already have an account? Sign in'}
              </button>
            </div>
          </div>
          <p className="text-xs text-slate-600 text-center mt-4">
            Free forever. Your account secures your wallet and earnings.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0e17] text-slate-200">
      <header className="border-b border-slate-800/50 bg-[#0d1320] sticky top-0 z-50 backdrop-blur-sm">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-emerald-500 to-cyan-600 flex items-center justify-center">
              <Rocket className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-base font-bold text-white">Flash Arb Engine</h1>
              <p className="text-xs text-slate-500 flex items-center gap-1">
                <Zap className="w-3 h-3 text-emerald-400" /> Zero Capital · {SCAN_INTERVAL_MS / 1000}s Scan · {contractsDeployed}/4 Chains
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            {alchemyStatus && (
              <div className={`hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-full border ${alchemyStatus.configured ? 'bg-emerald-950/50 border-emerald-800/50' : 'bg-amber-950/50 border-amber-800/50'}`}>
                <div className={`w-1.5 h-1.5 rounded-full ${alchemyStatus.configured ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'}`} />
                <span className={`text-xs ${alchemyStatus.configured ? 'text-emerald-300' : 'text-amber-300'}`}>
                  {alchemyStatus.configured ? 'Alchemy Live' : 'Add Alchemy Key'}
                </span>
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
              setupComplete && (
                <button onClick={handleOneTapLaunch} disabled={deploying} className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 rounded-lg flex items-center gap-2 text-sm font-medium transition-colors">
                  {deploying ? <RefreshCcw className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                  {deploying ? 'Starting...' : 'Start'}
                </button>
              )
            )}
            <button onClick={handleSignOut} className="px-3 py-2 bg-slate-800 hover:bg-slate-700 rounded-lg flex items-center gap-1.5 text-sm font-medium text-slate-300 transition-colors">
              <LogOut className="w-4 h-4" /> <span className="hidden sm:inline">Sign Out</span>
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6">
        {alerts.length > 0 && (
          <div className="mb-4 space-y-1.5 max-h-32 overflow-y-auto">
            {alerts.slice(0, 5).map(a => (
              <div key={a.id} className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm ${
                a.type === 'success' ? 'bg-emerald-950/50 border border-emerald-800/50 text-emerald-300'
                : a.type === 'error' ? 'bg-red-950/50 border border-red-800/50 text-red-300'
                : a.type === 'warning' ? 'bg-amber-950/50 border border-amber-800/50 text-amber-300'
                : 'bg-blue-950/50 border border-blue-800/50 text-blue-300'
              }`}>
                {a.type === 'success' && <CheckCircle className="w-4 h-4 flex-shrink-0" />}
                {a.type === 'error' && <AlertTriangle className="w-4 h-4 flex-shrink-0" />}
                {a.type === 'warning' && <AlertTriangle className="w-4 h-4 flex-shrink-0" />}
                {a.type === 'info' && <Activity className="w-4 h-4 flex-shrink-0" />}
                <span className="flex-1">{a.message}</span>
                <span className="text-xs opacity-50">{fmtTime(a.timestamp)}</span>
              </div>
            ))}
          </div>
        )}

        {!setupComplete ? (
          <SetupView
            wallet={wallet}
            walletLoaded={walletLoaded}
            password={password}
            setPassword={setPassword}
            showPassword={showPassword}
            setShowPassword={setShowPassword}
            showImport={showImport}
            setShowImport={setShowImport}
            importKeyInput={importKeyInput}
            setImportKeyInput={setImportKeyInput}
            handleGenerateWallet={handleGenerateWallet}
            handleImportWallet={handleImportWallet}
            handleUnlock={handleUnlock}
            alchemyStatus={alchemyStatus}
            alchemyApiKey={alchemyApiKey}
            setAlchemyApiKey={setAlchemyApiKey}
            alchemyPolicyId={alchemyPolicyId}
            setAlchemyPolicyId={setAlchemyPolicyId}
            handleSaveAlchemyKey={handleSaveAlchemyKey}
            deployedContracts={deployedContracts}
            deploying={deploying}
            handleOneTapLaunch={handleOneTapLaunch}
            copyToClipboard={copyToClipboard}
          />
        ) : (
          <Dashboard
            engineRunning={engineRunning}
            scanCount={scanCount}
            totalProfit={totalProfit}
            executedCount={executedCount}
            netRevenue={netRevenue}
            treasurySummary={treasurySummary}
            allOpportunities={allOpportunities}
            scanResults={scanResults}
            engineStatusRecords={engineStatusRecords}
            treasuryRecords={treasuryRecords}
            executionRecords={executionRecords}
            opportunityRecords={opportunityRecords}
            deployedContracts={deployedContracts}
            wallet={wallet}
            autoExecute={autoExecute}
            setAutoExecute={setAutoExecute}
            minProfit={minProfit}
            setMinProfit={setMinProfit}
            executing={executing}
            executeOpportunity={executeOpportunity}
            fmtDate={fmtDate}
            statArbStats={statArbStats}
            alchemyStatus={alchemyStatus}
          />
        )}
      </main>
    </div>
  );
}

function SetupView(props: {
  wallet: WalletState | null; walletLoaded: boolean;
  password: string; setPassword: (s: string) => void;
  showPassword: boolean; setShowPassword: (b: boolean) => void;
  showImport: boolean; setShowImport: (b: boolean) => void;
  importKeyInput: string; setImportKeyInput: (s: string) => void;
  handleGenerateWallet: () => void; handleImportWallet: () => void; handleUnlock: () => void;
  alchemyStatus: { configured: boolean; mode: string; paymasterPolicyId?: string } | null;
  alchemyApiKey: string; setAlchemyApiKey: (s: string) => void;
  alchemyPolicyId: string; setAlchemyPolicyId: (s: string) => void;
  handleSaveAlchemyKey: () => void;
  deployedContracts: Record<string, string>;
  deploying: boolean; handleOneTapLaunch: () => void;
  copyToClipboard: (s: string) => void;
}) {
  const walletReady = props.wallet?.isUnlocked;
  const alchemyReady = props.alchemyStatus?.configured;

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="text-center mb-6">
        <div className="flex items-center gap-2 justify-center mb-2">
          <Sparkles className="w-5 h-5 text-emerald-400" />
          <h2 className="text-lg font-bold text-white">1-Tap Launch</h2>
        </div>
        <p className="text-sm text-slate-500">Set up wallet + Alchemy key, then tap Launch. The engine handles everything else.</p>
      </div>

      <div className="bg-slate-900/50 rounded-2xl border border-slate-800 p-6">
        <h3 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2">
          <Wallet className="w-4 h-4 text-cyan-400" /> Step 1: Wallet
        </h3>
        {!props.walletLoaded ? (
          <p className="text-sm text-slate-500">Loading...</p>
        ) : !props.wallet ? (
          <div className="space-y-3">
            <p className="text-sm text-slate-400">Create a new wallet to receive arbitrage profits. The private key is encrypted with AES-256.</p>
            <div className="relative">
              <input type={props.showPassword ? 'text' : 'password'} value={props.password} onChange={e => props.setPassword(e.target.value)}
                placeholder="Password (min 8 chars)"
                className="w-full px-3 py-2.5 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white pr-10 focus:border-emerald-600 focus:outline-none" />
              <button onClick={() => props.setShowPassword(!props.showPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500">
                {props.showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <button onClick={props.handleGenerateWallet} className="w-full px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-sm font-medium flex items-center justify-center gap-2 transition-colors">
              <Wallet className="w-4 h-4" /> Generate New Wallet
            </button>
            {props.showImport && (
              <div className="space-y-2 pt-2 border-t border-slate-800">
                <input type="text" value={props.importKeyInput} onChange={e => props.setImportKeyInput(e.target.value)}
                  placeholder="Private key (0x...)"
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white font-mono focus:border-emerald-600 focus:outline-none" />
                <button onClick={props.handleImportWallet} className="w-full px-4 py-2 bg-cyan-600 hover:bg-cyan-500 rounded-lg text-sm font-medium transition-colors">
                  Import Wallet
                </button>
              </div>
            )}
            {!props.showImport && (
              <button onClick={() => props.setShowImport(true)} className="w-full text-sm text-slate-400 hover:text-slate-300">
                Import existing wallet &gt;
              </button>
            )}
          </div>
        ) : !props.wallet.isUnlocked ? (
          <div className="space-y-3">
            <p className="text-sm text-slate-400">Wallet: <span className="font-mono text-slate-300">{props.wallet.address}</span></p>
            <div className="relative">
              <input type={props.showPassword ? 'text' : 'password'} value={props.password} onChange={e => props.setPassword(e.target.value)}
                placeholder="Enter password to unlock" onKeyDown={e => e.key === 'Enter' && props.handleUnlock()}
                className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white pr-10 focus:border-emerald-600 focus:outline-none" />
              <button onClick={() => props.setShowPassword(!props.showPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500">
                {props.showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <button onClick={props.handleUnlock} className="w-full px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-sm font-medium transition-colors">
              Unlock Wallet
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="bg-slate-800/50 rounded-lg p-4">
              <p className="text-xs text-slate-500 mb-1">Wallet Address</p>
              <p className="text-sm font-mono text-emerald-300">{props.wallet.address}</p>
            </div>
            <div className="bg-emerald-950/30 rounded-lg p-3 border border-emerald-800/30">
              <p className="text-xs text-emerald-300 flex items-center gap-1.5">
                <CheckCircle className="w-3 h-3" /> Wallet ready! Profits will be sent here.
              </p>
            </div>
          </div>
        )}
      </div>

      <div className="bg-slate-900/50 rounded-2xl border border-slate-800 p-6">
        <h3 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2">
          <KeyRound className="w-4 h-4 text-amber-400" /> Step 2: Alchemy API Key
        </h3>
        <p className="text-sm text-slate-400 mb-4">
          Alchemy provides free RPC access and gas sponsorship via their Gas Manager. Get a free API key at{' '}
          <a href="https://www.alchemy.com" target="_blank" rel="noopener noreferrer" className="text-cyan-400 hover:text-cyan-300 inline-flex items-center gap-0.5">
            alchemy.com <ExternalLink className="w-3 h-3" />
          </a>. The free tier includes $50/month in sponsored gas.
        </p>
        <div className={`mb-4 p-3 rounded-lg border ${props.alchemyStatus?.configured ? 'bg-emerald-950/30 border-emerald-800/40' : 'bg-amber-950/30 border-amber-800/40'}`}>
          <p className={`text-sm flex items-center gap-2 ${props.alchemyStatus?.configured ? 'text-emerald-300' : 'text-amber-300'}`}>
            {props.alchemyStatus?.configured ? <CheckCircle className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
            {props.alchemyStatus?.configured ? 'Alchemy API key configured!' : 'Alchemy API key needed for gas sponsorship.'}
          </p>
        </div>
        <div className="space-y-3">
          <input type="text" value={props.alchemyApiKey} onChange={e => props.setAlchemyApiKey(e.target.value)}
            placeholder="Alchemy API key (e.g. a1b2c3d4...)"
            className="w-full px-3 py-2.5 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white font-mono focus:border-emerald-600 focus:outline-none" />
          <input type="text" value={props.alchemyPolicyId} onChange={e => props.setAlchemyPolicyId(e.target.value)}
            placeholder="Paymaster Policy ID (optional, for gas sponsorship)"
            className="w-full px-3 py-2.5 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white font-mono focus:border-emerald-600 focus:outline-none" />
          <button onClick={props.handleSaveAlchemyKey} className="w-full px-4 py-2.5 bg-cyan-600 hover:bg-cyan-500 rounded-lg text-sm font-medium transition-colors">
            Save Alchemy Key
          </button>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3 text-xs">
          <div className="bg-blue-950/30 rounded-lg p-3 border border-blue-800/30">
            <p className="text-blue-300 flex items-start gap-2">
              <Fuel className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>Free $50/mo sponsored gas via Alchemy Gas Manager (ERC-4337 paymaster)</span>
            </p>
          </div>
          <div className="bg-cyan-950/30 rounded-lg p-3 border border-cyan-800/30">
            <p className="text-cyan-300 flex items-start gap-2">
              <Shield className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>Flashbots Protect RPC for MEV-resistant transaction submission</span>
            </p>
          </div>
        </div>
      </div>

      <div className="bg-slate-900/50 rounded-2xl border border-emerald-800/40 p-6">
        <h3 className="text-sm font-semibold text-emerald-300 mb-4 flex items-center gap-2">
          <Rocket className="w-4 h-4 text-emerald-400" /> Step 3: Launch
        </h3>
        <p className="text-sm text-slate-400 mb-4">One tap deploys executor contracts to all chains and starts scanning. The engine will:</p>
        <div className="space-y-2 mb-6">
          {[
            'Deploy executor contracts via CREATE2 deterministic addresses',
            'Scan real DEX prices across Polygon, Arbitrum, Optimism, and Base',
            'Detect cross-DEX, statistical arbitrage (Z-score), and long-tail token opportunities',
            'Auto-execute via Balancer 0% flash loans with Flashbots MEV protection',
            'Collect profit to your wallet — 90% to you, 10% gas reserve',
          ].map((step, i) => (
            <div key={i} className="flex items-center gap-3 bg-slate-800/30 rounded-lg px-4 py-3">
              <div className="w-6 h-6 rounded-full bg-emerald-600 flex items-center justify-center text-white text-xs flex-shrink-0">{i + 1}</div>
              <span className="text-sm text-slate-400">{step}</span>
            </div>
          ))}
        </div>
        <div className="bg-emerald-950/30 rounded-lg p-4 border border-emerald-800/30 mb-4">
          <div className="grid grid-cols-3 gap-3 text-xs">
            <div><p className="text-slate-500">Wallet</p><p className={walletReady ? 'text-emerald-300' : 'text-amber-300'}>{walletReady ? 'Ready' : 'Pending'}</p></div>
            <div><p className="text-slate-500">Alchemy</p><p className={alchemyReady ? 'text-emerald-300' : 'text-amber-300'}>{alchemyReady ? 'Connected' : 'Pending'}</p></div>
            <div><p className="text-slate-500">Contracts</p><p className="text-emerald-300">{Object.keys(props.deployedContracts).length}/4</p></div>
          </div>
        </div>
        <button onClick={props.handleOneTapLaunch} disabled={props.deploying || !walletReady}
          className="w-full px-4 py-3 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 rounded-lg text-sm font-bold flex items-center justify-center gap-2 transition-colors">
          {props.deploying ? <RefreshCcw className="w-5 h-5 animate-spin" /> : <Rocket className="w-5 h-5" />}
          {props.deploying ? 'Deploying & Starting...' : 'Launch Engine'}
        </button>
      </div>
    </div>
  );
}

function Dashboard(props: {
  engineRunning: boolean; scanCount: number; totalProfit: number; executedCount: number;
  netRevenue: number; treasurySummary: { totalProfit: number; totalGas: number; totalFlashFee: number; totalDeploy: number };
  allOpportunities: ArbitrageOpportunity[]; scanResults: ScanResult[];
  engineStatusRecords: EngineStatusRecord[];
  treasuryRecords: TreasuryRecord[]; executionRecords: ExecutionRecord[]; opportunityRecords: OpportunityRecord[];
  deployedContracts: Record<string, string>; wallet: WalletState | null;
  autoExecute: boolean; setAutoExecute: (b: boolean) => void;
  minProfit: string; setMinProfit: (s: string) => void;
  executing: boolean; executeOpportunity: (o: ArbitrageOpportunity) => void;
  fmtDate: (s: string) => string;
  statArbStats: { pair: string; chain: string; samples: number; mean: number; stdDev: number; currentZ: number }[];
  alchemyStatus: { configured: boolean; mode: string; paymasterPolicyId?: string } | null;
}) {
  const [view, setView] = useState<'overview' | 'opportunities' | 'revenue' | 'starvarb' | 'settings'>('overview');
  const navItems = [
    { key: 'overview' as const, label: 'Overview', icon: Cpu },
    { key: 'opportunities' as const, label: 'Opportunities', icon: TrendingUp },
    { key: 'starvarb' as const, label: 'Stat Arb', icon: BarChart3 },
    { key: 'revenue' as const, label: 'Revenue', icon: DollarSign },
    { key: 'settings' as const, label: 'Settings', icon: Settings },
  ];

  return (
    <div>
      <div className="flex gap-1 mb-6 bg-slate-900/30 rounded-xl p-1 border border-slate-800 overflow-x-auto">
        {navItems.map(item => {
          const Icon = item.icon;
          return (
            <button key={item.key} onClick={() => setView(item.key)}
              className={`flex-1 min-w-fit flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
                view === item.key ? 'bg-emerald-600 text-white' : 'text-slate-400 hover:text-slate-300'
              }`}>
              <Icon className="w-4 h-4" /> <span className="hidden sm:inline">{item.label}</span>
            </button>
          );
        })}
      </div>

      {view === 'overview' && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <StatCard icon={<DollarSign className="w-5 h-5" />} label="Total Profit" value={`$${props.totalProfit.toFixed(4)}`} color="emerald" />
            <StatCard icon={<TrendingUp className="w-5 h-5" />} label="Live Opportunities" value={String(props.allOpportunities.length)} color="cyan" />
            <StatCard icon={<CheckCircle className="w-5 h-5" />} label="Executed" value={String(props.executedCount)} color="emerald" />
            <StatCard icon={<Activity className="w-5 h-5" />} label="Scans" value={String(props.scanCount)} color="blue" />
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <StatCard icon={<Coins className="w-5 h-5" />} label="Gas Costs" value={`$${props.treasurySummary.totalGas.toFixed(4)}`} color="amber" />
            <StatCard icon={<Zap className="w-5 h-5" />} label="Flash Fees" value={`$${props.treasurySummary.totalFlashFee.toFixed(4)}`} color="cyan" />
            <StatCard icon={<DollarSign className="w-5 h-5" />} label="Net Revenue" value={`$${props.netRevenue.toFixed(4)}`} color="emerald" />
            <StatCard icon={<Cpu className="w-5 h-5" />} label="Contracts" value={`${Object.keys(props.deployedContracts).length}/4`} color="blue" />
          </div>

          <div className="bg-gradient-to-r from-emerald-950/50 to-cyan-950/50 rounded-xl border border-emerald-800/30 p-4">
            <div className="flex items-center gap-3">
              <Zap className="w-5 h-5 text-emerald-400 flex-shrink-0" />
              <div>
                <p className="text-sm font-semibold text-emerald-300">Zero-Capital · 3 Arbitrage Strategies · MEV Protected</p>
                <p className="text-xs text-slate-400">
                  Cross-DEX + Statistical (Z-score) + Long-tail tokens. Balancer 0% flash loans. Flashbots Protect RPC. Alchemy Gas Manager sponsorship. Scans every {SCAN_INTERVAL_MS / 1000}s across {CHAIN_KEYS.length} chains.
                </p>
              </div>
            </div>
          </div>

          <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-6">
            <h3 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2">
              <Cpu className="w-4 h-4 text-cyan-400" /> Chain Scanner Status
            </h3>
            <div className="space-y-2">
              {CHAIN_KEYS.map(chainKey => {
                const chain = CHAINS[chainKey];
                const result = props.scanResults.find(r => r.chain === chainKey);
                const dbStatus = props.engineStatusRecords.find(s => s.chain === chainKey);
                const oppCount = result?.opportunities.length || 0;
                const priceCount = result?.poolPrices.length || 0;
                const hasContract = !!props.deployedContracts[chainKey];
                const statusValue = dbStatus?.status || 'idle';
                const blockNum = dbStatus?.current_block || result?.blockNumber || 0;
                return (
                  <div key={chainKey} className="flex items-center gap-3 bg-slate-800/30 rounded-lg px-4 py-3">
                    <div className={`w-2 h-2 rounded-full ${statusValue === 'scanning' ? 'bg-emerald-400 animate-pulse' : statusValue === 'error' ? 'bg-red-400' : 'bg-slate-600'}`} />
                    <span className="text-sm font-medium w-24">{chain.name}</span>
                    <span className="text-xs text-slate-500">block {blockNum > 0 ? blockNum.toLocaleString() : '--'}</span>
                    <span className="text-xs text-cyan-400">{priceCount} pools</span>
                    <span className="text-xs text-emerald-400">{oppCount} opps</span>
                    {dbStatus && <span className="text-xs text-slate-500">{dbStatus.rpc_latency_ms}ms</span>}
                    <div className="flex-1" />
                    {hasContract ? (
                      <span className="text-xs text-emerald-400 flex items-center gap-1"><CheckCircle className="w-3 h-3" /> Deployed</span>
                    ) : (
                      <span className="text-xs text-slate-500">Pending</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-6">
            <h3 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-emerald-400" /> Live Arbitrage Opportunities
            </h3>
            {props.allOpportunities.length === 0 ? (
              <p className="text-sm text-slate-500 text-center py-8">
                {props.engineRunning ? 'Scanning DEX prices...' : 'Engine is stopped. Start it to scan for opportunities.'}
              </p>
            ) : (
              <div className="space-y-2">
                {props.allOpportunities.slice(0, 10).map((opp) => (
                  <div key={opp.id} className="flex items-center gap-3 bg-slate-800/30 rounded-lg px-4 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded ${
                      opp.strategy === 'statistical' ? 'bg-cyan-950/50 text-cyan-300'
                      : opp.strategy === 'long_tail' ? 'bg-amber-950/50 text-amber-300'
                      : 'bg-emerald-950/50 text-emerald-300'
                    }`}>{opp.strategy}</span>
                    <span className="text-xs text-slate-400 w-16">{opp.chain}</span>
                    <span className="text-xs font-mono text-slate-300 flex-1 truncate">{opp.tokenPath.join(' -> ')}</span>
                    <span className="text-xs text-slate-500">{opp.buyDex} {'->'} {opp.sellDex}</span>
                    <span className="text-xs text-cyan-400">{opp.spreadPct.toFixed(2)}%</span>
                    {opp.zScore && <span className="text-xs text-cyan-300">z={opp.zScore.toFixed(2)}</span>}
                    <span className="text-xs font-semibold text-emerald-400">+${opp.netProfit.toFixed(4)}</span>
                    {props.wallet?.isUnlocked && props.deployedContracts[opp.chain] && (
                      <button onClick={() => props.executeOpportunity(opp)} disabled={props.executing}
                        className="px-2 py-1 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 rounded text-xs font-medium">
                        Execute
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {view === 'opportunities' && (
        <div className="space-y-4">
          <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-6">
            <h3 className="text-sm font-semibold text-slate-300 mb-4">Live Opportunities ({props.allOpportunities.length})</h3>
            {props.allOpportunities.length === 0 ? (
              <p className="text-sm text-slate-500 text-center py-8">No opportunities found. Start the engine to scan.</p>
            ) : (
              <div className="space-y-2">
                {props.allOpportunities.map((opp) => (
                  <div key={opp.id} className="flex items-center gap-3 bg-slate-800/30 rounded-lg px-4 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded ${
                      opp.strategy === 'statistical' ? 'bg-cyan-950/50 text-cyan-300'
                      : opp.strategy === 'long_tail' ? 'bg-amber-950/50 text-amber-300'
                      : 'bg-emerald-950/50 text-emerald-300'
                    }`}>{opp.strategy}</span>
                    <span className="text-xs text-slate-400 w-16">{opp.chain}</span>
                    <span className="text-xs font-mono text-slate-300 flex-1 truncate">{opp.tokenPath.join(' -> ')}</span>
                    <span className="text-xs text-slate-500">{opp.buyDex} {'->'} {opp.sellDex}</span>
                    <span className="text-xs text-cyan-400">{opp.spreadPct.toFixed(2)}%</span>
                    {opp.zScore && <span className="text-xs text-cyan-300">z={opp.zScore.toFixed(2)}</span>}
                    <span className="text-xs font-semibold text-emerald-400">+${opp.netProfit.toFixed(4)}</span>
                    <span className="text-xs text-slate-400">{(opp.confidenceScore * 100).toFixed(0)}%</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-6">
            <h3 className="text-sm font-semibold text-slate-300 mb-4">Saved Opportunities ({props.opportunityRecords.length})</h3>
            {props.opportunityRecords.length === 0 ? (
              <p className="text-sm text-slate-500 text-center py-4">No opportunities saved yet.</p>
            ) : (
              <div className="space-y-2 max-h-96 overflow-y-auto">
                {props.opportunityRecords.slice(0, 50).map(o => (
                  <div key={o.id} className="flex items-center gap-3 bg-slate-800/30 rounded-lg px-4 py-2 text-xs">
                    <span className={`px-2 py-0.5 rounded ${o.status === 'executed' ? 'bg-emerald-950/50 text-emerald-300' : o.status === 'expired' ? 'bg-slate-700/50 text-slate-400' : 'bg-blue-950/50 text-blue-300'}`}>{o.status}</span>
                    <span className="text-slate-400">{o.chain}</span>
                    <span className="font-mono text-slate-300 flex-1 truncate">{(Array.isArray(o.token_path) ? o.token_path : []).join(' -> ')}</span>
                    <span className="font-semibold text-emerald-400">+${parseFloat(o.net_profit).toFixed(4)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {props.scanResults.some(r => r.poolPrices.length > 0) && (
            <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-6">
              <h3 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2">
                <Activity className="w-4 h-4 text-cyan-400" /> Live DEX Pool Prices
              </h3>
              <div className="space-y-2 max-h-96 overflow-y-auto">
                {props.scanResults.flatMap((r, ri) => r.poolPrices.map((p, pi) => (
                  <div key={`${ri}-${pi}`} className="flex items-center gap-3 bg-slate-800/30 rounded-lg px-4 py-2 text-xs">
                    <span className="font-mono text-slate-300 w-24">{p.tokenIn}/{p.tokenOut}</span>
                    <span className="text-cyan-400 w-32">{p.dex} {p.fee > 0 ? `(${p.fee / 10000}%)` : ''}</span>
                    <span className="text-emerald-400 font-semibold">{p.price.toFixed(6)}</span>
                    <span className="text-slate-500">liq: {p.liquidity.toFixed(2)}</span>
                  </div>
                )))}
              </div>
            </div>
          )}
        </div>
      )}

      {view === 'starvarb' && (
        <div className="space-y-4">
          <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-6">
            <h3 className="text-sm font-semibold text-slate-300 mb-2 flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-cyan-400" /> Statistical Arbitrage Model
            </h3>
            <p className="text-xs text-slate-500 mb-4">
              Non-latency-dependent strategy: tracks spread history between DEX pairs, computes Z-scores, and signals when spreads deviate beyond 2 standard deviations. Bets on mean reversion rather than racing bots for speed.
            </p>
            <div className="grid grid-cols-3 gap-4 mb-4">
              <div className="bg-slate-800/30 rounded-lg p-3 text-center">
                <p className="text-xs text-slate-500">Tracked Pairs</p>
                <p className="text-lg font-bold text-cyan-400">{props.statArbStats.length}</p>
              </div>
              <div className="bg-slate-800/30 rounded-lg p-3 text-center">
                <p className="text-xs text-slate-500">Active Signals</p>
                <p className="text-lg font-bold text-emerald-400">{props.statArbStats.filter(s => Math.abs(s.currentZ) >= 2).length}</p>
              </div>
              <div className="bg-slate-800/30 rounded-lg p-3 text-center">
                <p className="text-xs text-slate-500">Max |Z|</p>
                <p className="text-lg font-bold text-amber-400">{props.statArbStats.length > 0 ? Math.max(...props.statArbStats.map(s => Math.abs(s.currentZ))).toFixed(2) : '0.00'}</p>
              </div>
            </div>
          </div>

          <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-6">
            <h3 className="text-sm font-semibold text-slate-300 mb-4">Z-Score Monitor</h3>
            {props.statArbStats.length === 0 ? (
              <p className="text-sm text-slate-500 text-center py-8">No data yet. Run scans to build spread history.</p>
            ) : (
              <div className="space-y-2">
                {props.statArbStats.map((s, i) => {
                  const z = s.currentZ;
                  const absZ = Math.abs(z);
                  const signal = absZ >= 2.0;
                  return (
                    <div key={i} className="flex items-center gap-3 bg-slate-800/30 rounded-lg px-4 py-3">
                      <span className="text-xs text-slate-400 w-16">{s.chain}</span>
                      <span className="text-xs font-mono text-slate-300 w-24">{s.pair}</span>
                      <span className="text-xs text-slate-500">n={s.samples}</span>
                      <span className="text-xs text-slate-400">mean={s.mean.toFixed(3)}</span>
                      <span className="text-xs text-slate-400">sd={s.stdDev.toFixed(3)}</span>
                      <div className="flex-1" />
                      <div className="flex items-center gap-2">
                        <div className="w-24 h-2 bg-slate-700 rounded-full overflow-hidden">
                          <div className={`h-full rounded-full ${absZ > 3 ? 'bg-red-500' : absZ > 2 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                            style={{ width: `${Math.min(absZ / 5 * 100, 100)}%` }} />
                        </div>
                        <span className={`text-xs font-bold w-12 text-right ${signal ? 'text-amber-400' : 'text-slate-400'}`}>
                          z={z.toFixed(2)}
                        </span>
                        {signal && <span className="text-xs px-2 py-0.5 rounded bg-amber-950/50 text-amber-300">SIGNAL</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-6">
            <h3 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2">
              <Target className="w-4 h-4 text-emerald-400" /> How It Works
            </h3>
            <div className="space-y-3 text-sm text-slate-400">
              <p><span className="text-cyan-400 font-medium">1. Spread Tracking:</span> Every scan records the price spread between DEX pairs (e.g., WETH-USDC on Uniswap vs SushiSwap).</p>
              <p><span className="text-cyan-400 font-medium">2. Z-Score Calculation:</span> After 20+ samples, the model computes a rolling mean and standard deviation. The Z-score measures how far the current spread deviates from the historical mean.</p>
              <p><span className="text-cyan-400 font-medium">3. Signal Generation:</span> When {'|Z|'} {'>='} 2.0, the spread is statistically unusual. A CONVERGENCE signal (Z {'>'} 0) means the spread is too wide and should narrow. A DIVERGENCE signal (Z {'<'} 0) means it's too tight and should widen.</p>
              <p><span className="text-cyan-400 font-medium">4. Execution:</span> The engine executes a flash loan trade betting on the reversion to the mean. This doesn't require low latency — it requires the spread to eventually revert, which it statistically does.</p>
              <p><span className="text-emerald-400 font-medium">5. Long-Tail Advantage:</span> By including lower-cap tokens (LDO, GMX, ARB, DEGEN, etc.), the model finds wider spreads with less bot competition. Corporate bots focus on high-liquidity pairs; we exploit the long tail.</p>
            </div>
          </div>
        </div>
      )}

      {view === 'revenue' && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <StatCard icon={<DollarSign className="w-5 h-5" />} label="Total Profit" value={`$${props.treasurySummary.totalProfit.toFixed(4)}`} color="emerald" />
            <StatCard icon={<Coins className="w-5 h-5" />} label="Gas Costs" value={`$${props.treasurySummary.totalGas.toFixed(4)}`} color="amber" />
            <StatCard icon={<Activity className="w-5 h-5" />} label="Executions" value={String(props.executionRecords.length)} color="cyan" />
            <StatCard icon={<TrendingUp className="w-5 h-5" />} label="Net Revenue" value={`$${props.netRevenue.toFixed(4)}`} color="emerald" />
          </div>

          <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-6">
            <h3 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2">
              <DollarSign className="w-4 h-4 text-cyan-400" /> Treasury Ledger ({props.treasuryRecords.length})
            </h3>
            {props.treasuryRecords.length === 0 ? (
              <p className="text-sm text-slate-500 text-center py-4">No treasury records yet. Start the engine to generate revenue.</p>
            ) : (
              <div className="space-y-2 max-h-96 overflow-y-auto">
                {props.treasuryRecords.slice(0, 50).map(t => (
                  <div key={t.id} className="flex items-center gap-3 bg-slate-800/30 rounded-lg px-4 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded ${
                      t.type === 'profit' ? 'bg-emerald-950/50 text-emerald-300'
                      : t.type === 'gas_cost' ? 'bg-amber-950/50 text-amber-300'
                      : 'bg-blue-950/50 text-blue-300'
                    }`}>{t.type}</span>
                    <span className="text-xs text-slate-400">{t.chain}</span>
                    <span className={`text-xs font-semibold flex-1 text-right ${t.type === 'profit' ? 'text-emerald-400' : 'text-amber-400'}`}>
                      {t.type === 'profit' ? '+' : '-'}${parseFloat(t.amount_usd).toFixed(4)}
                    </span>
                    <span className="text-xs text-slate-500">{props.fmtDate(t.created_at)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-6">
            <h3 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2">
              <Activity className="w-4 h-4 text-emerald-400" /> Execution Records ({props.executionRecords.length})
            </h3>
            {props.executionRecords.length === 0 ? (
              <p className="text-sm text-slate-500 text-center py-4">No executions yet.</p>
            ) : (
              <div className="space-y-2 max-h-96 overflow-y-auto">
                {props.executionRecords.slice(0, 50).map(e => (
                  <div key={e.id} className="flex items-center gap-3 bg-slate-800/30 rounded-lg px-4 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded ${
                      e.status === 'confirmed' ? 'bg-emerald-950/50 text-emerald-300'
                      : e.status === 'executed' ? 'bg-cyan-950/50 text-cyan-300'
                      : e.status === 'pending' ? 'bg-amber-950/50 text-amber-300'
                      : 'bg-red-950/50 text-red-300'
                    }`}>{e.status}</span>
                    <span className="text-xs text-slate-400">{e.chain}</span>
                    <span className="text-xs font-semibold text-emerald-400 flex-1 text-right">+${parseFloat(e.revenue_net).toFixed(4)}</span>
                    <span className="text-xs text-slate-500">gas: ${parseFloat(e.gas_cost_usd).toFixed(4)}</span>
                    {e.tx_hash && <span className="text-xs font-mono text-cyan-400">{e.tx_hash.slice(0, 12)}...</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {view === 'settings' && (
        <div className="max-w-2xl space-y-4">
          <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-6">
            <h3 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2">
              <Settings className="w-4 h-4 text-cyan-400" /> Engine Settings
            </h3>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-slate-300">Auto-Execute</p>
                  <p className="text-xs text-slate-500">Automatically execute profitable opportunities</p>
                </div>
                <button onClick={() => props.setAutoExecute(!props.autoExecute)} className={`w-12 h-6 rounded-full transition-colors ${props.autoExecute ? 'bg-emerald-600' : 'bg-slate-700'}`}>
                  <div className={`w-5 h-5 rounded-full bg-white transition-transform ${props.autoExecute ? 'translate-x-6' : 'translate-x-0.5'}`} />
                </button>
              </div>
              <div>
                <label className="text-sm font-medium text-slate-300">Min Profit (USD)</label>
                <input type="text" value={props.minProfit} onChange={e => props.setMinProfit(e.target.value)}
                  className="w-full px-3 py-2 mt-1 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white focus:border-emerald-600 focus:outline-none" />
                <p className="text-xs text-slate-500 mt-1">Only execute opportunities with at least this much net profit</p>
              </div>
              <div>
                <label className="text-sm font-medium text-slate-300">Scan Interval</label>
                <p className="text-xs text-slate-500 mt-1">{SCAN_INTERVAL_MS / 1000} seconds</p>
              </div>
            </div>
          </div>

          <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-6">
            <h3 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2">
              <Cpu className="w-4 h-4 text-cyan-400" /> Executor Contracts (CREATE2)
            </h3>
            <div className="space-y-2">
              {CHAIN_KEYS.map(chainKey => {
                const chain = CHAINS[chainKey];
                const addr = props.deployedContracts[chainKey];
                return (
                  <div key={chainKey} className="flex items-center gap-3 bg-slate-800/50 rounded-lg px-3 py-2">
                    <span className="text-sm font-medium w-24">{chain.name}</span>
                    {addr ? (
                      <><code className="text-xs font-mono text-emerald-300 flex-1 truncate">{addr}</code><CheckCircle className="w-4 h-4 text-emerald-400" /></>
                    ) : (
                      <><span className="text-xs text-slate-500 flex-1">Auto-deploys on launch</span></>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-6">
            <h3 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2">
              <Shield className="w-4 h-4 text-cyan-400" /> Infrastructure
            </h3>
            <div className="space-y-3 text-sm">
              <div className="flex items-center justify-between bg-slate-800/30 rounded-lg px-4 py-3">
                <div>
                  <p className="font-medium text-slate-300">Alchemy Gas Manager</p>
                  <p className="text-xs text-slate-500">ERC-4337 paymaster for gas sponsorship</p>
                </div>
                <span className={`text-xs ${props.alchemyStatus?.configured ? 'text-emerald-400' : 'text-amber-400'}`}>
                  {props.alchemyStatus?.configured ? 'Connected' : 'Not configured'}
                </span>
              </div>
              <div className="flex items-center justify-between bg-slate-800/30 rounded-lg px-4 py-3">
                <div>
                  <p className="font-medium text-slate-300">Flashbots Protect</p>
                  <p className="text-xs text-slate-500">MEV-resistant private mempool submission</p>
                </div>
                <span className="text-xs text-emerald-400">Active</span>
              </div>
              <div className="flex items-center justify-between bg-slate-800/30 rounded-lg px-4 py-3">
                <div>
                  <p className="font-medium text-slate-300">Statistical Arbitrage</p>
                  <p className="text-xs text-slate-500">Z-score mean reversion model (non-latency)</p>
                </div>
                <span className="text-xs text-emerald-400">Enabled</span>
              </div>
              <div className="flex items-center justify-between bg-slate-800/30 rounded-lg px-4 py-3">
                <div>
                  <p className="font-medium text-slate-300">Long-Tail Token Scanner</p>
                  <p className="text-xs text-slate-500">Low-cap tokens with wider spreads, less bot competition</p>
                </div>
                <span className="text-xs text-emerald-400">Enabled</span>
              </div>
            </div>
          </div>

          <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-6">
            <h3 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2">
              <Bug className="w-4 h-4 text-amber-400" /> Debug & Diagnostics
            </h3>
            <div className="space-y-3 text-sm">
              {props.engineStatusRecords.map(s => (
                <div key={s.id} className="flex items-center gap-3 bg-slate-800/30 rounded-lg px-4 py-3">
                  <div className={`w-2 h-2 rounded-full ${s.status === 'scanning' ? 'bg-emerald-400 animate-pulse' : s.status === 'error' ? 'bg-red-400' : 'bg-slate-600'}`} />
                  <span className="font-medium w-20">{s.chain}</span>
                  <span className="text-xs text-slate-400">status: {s.status}</span>
                  <span className="text-xs text-slate-400">block: {s.current_block || 0}</span>
                  <span className="text-xs text-slate-400">latency: {s.rpc_latency_ms || 0}ms</span>
                  <span className="text-xs text-slate-400">opps: {s.opportunities_found || 0}</span>
                  <span className="text-xs text-slate-400">trades: {s.trades_executed || 0}</span>
                  {s.error_message && <span className="text-xs text-red-400 truncate max-w-48">{s.error_message}</span>}
                </div>
              ))}
            </div>
          </div>

          <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-6">
            <h3 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2">
              <Wallet className="w-4 h-4 text-cyan-400" /> Wallet
            </h3>
            {props.wallet && (
              <div className="bg-slate-800/50 rounded-lg p-4">
                <p className="text-xs text-slate-500 mb-1">Wallet Address</p>
                <p className="text-sm font-mono text-emerald-300">{props.wallet.address}</p>
                <p className="text-xs text-slate-500 mt-2">Status: {props.wallet.isUnlocked ? 'Unlocked' : 'Locked'}</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: string; color: string }) {
  const cm: Record<string, string> = {
    emerald: 'text-emerald-400 bg-emerald-950/30',
    cyan: 'text-cyan-400 bg-cyan-950/30',
    blue: 'text-blue-400 bg-blue-950/30',
    amber: 'text-amber-400 bg-amber-950/30',
  };
  return (
    <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-4">
      <div className={`w-8 h-8 rounded-lg flex items-center justify-center mb-2 ${cm[color] || cm.emerald}`}>{icon}</div>
      <p className="text-xs text-slate-500">{label}</p>
      <p className="text-lg font-bold text-white">{value}</p>
    </div>
  );
}
