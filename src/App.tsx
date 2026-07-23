import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Play, Pause, RefreshCcw, Wallet, Cpu, Activity, TrendingUp,
  Shield, CheckCircle, AlertTriangle, Clock,
  Settings, DollarSign, Lock, Eye, EyeOff, Rocket, Zap,
  ExternalLink, Key, Copy, Receipt, Coins,
  ArrowRight, CheckCircle2, Link2,
} from 'lucide-react';
import { CHAINS, CHAIN_KEYS, SCAN_INTERVAL_MS } from './lib/chains';
import { scanAllChains, type ArbitrageOpportunity, type ScanResult } from './lib/scanner';
import {
  deployExecutorViaGelato, executeArbitrageGasless, getTaskStatus, checkGelatoHealth,
  type DeploymentResult, type ExecutionResult,
} from './lib/executor';
import {
  generateWallet, importWallet, unlockWallet, loadWallet,
  updateDeployedContracts, getDeployedContracts, type WalletState,
} from './lib/wallet';
import {
  fetchOperatorConfig, fetchArbConfig, fetchTreasuryRecords,
  fetchExecutionRecords, fetchOpportunityRecords, fetchEngineStatus,
  insertOpportunity, updateOpportunityStatus,
  insertExecution, updateExecutionStatus,
  insertTreasuryEntry, updateEngineStatus, incrementEngineTrades,
  fetchTreasurySummary,
  type OperatorConfig, type TreasuryRecord, type ExecutionRecord,
  type OpportunityRecord, type EngineStatusRecord,
} from './lib/operator';

type Tab = 'dashboard' | 'wallet' | 'opportunities' | 'revenue' | 'operator' | 'deploy' | 'settings';
interface AlertItem { id: string; type: 'success' | 'error' | 'warning' | 'info'; message: string; timestamp: number; }

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('dashboard');
  const [wallet, setWallet] = useState<WalletState | null>(null);
  const [walletLoaded, setWalletLoaded] = useState(false);
  const [password, setPassword] = useState('');
  const [importKeyInput, setImportKeyInput] = useState('');
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
  const [gelatoStatus, setGelatoStatus] = useState<{ configured: boolean; mode: string } | null>(null);

  const [operatorConfig, setOperatorConfig] = useState<OperatorConfig[]>([]);
  const [arbConfig, setArbConfig] = useState<{ key: string; value: unknown }[]>([]);
  const [treasuryRecords, setTreasuryRecords] = useState<TreasuryRecord[]>([]);
  const [executionRecords, setExecutionRecords] = useState<ExecutionRecord[]>([]);
  const [opportunityRecords, setOpportunityRecords] = useState<OpportunityRecord[]>([]);
  const [engineStatusRecords, setEngineStatusRecords] = useState<EngineStatusRecord[]>([]);
  const [treasurySummary, setTreasurySummary] = useState({ totalProfit: 0, totalGas: 0, totalFlashFee: 0, totalDeploy: 0 });

  const scanIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const pushAlert = useCallback((type: AlertItem['type'], message: string) => {
    setAlerts(prev => [{ id: Date.now().toString(), type, message, timestamp: Date.now() }, ...prev].slice(0, 20));
  }, []);

  const refreshDbData = useCallback(async () => {
    const [ops, acfg, treas, execs, opps, status, summary] = await Promise.all([
      fetchOperatorConfig(), fetchArbConfig(), fetchTreasuryRecords(),
      fetchExecutionRecords(), fetchOpportunityRecords(), fetchEngineStatus(),
      fetchTreasurySummary(),
    ]);
    setOperatorConfig(ops);
    setArbConfig(acfg);
    setTreasuryRecords(treas);
    setExecutionRecords(execs);
    setOpportunityRecords(opps);
    setEngineStatusRecords(status);
    setTreasurySummary(summary);
    setTotalProfit(summary.totalProfit);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const loaded = await loadWallet();
        setWalletLoaded(true);
        if (loaded) {
          setWallet(loaded);
          const contracts = await getDeployedContracts(loaded.address);
          if (contracts && Object.keys(contracts).length > 0) setDeployedContracts(contracts);
        }
      } catch { setWalletLoaded(true); }
      await refreshDbData();
      const health = await checkGelatoHealth();
      setGelatoStatus(health);
    })();
  }, [refreshDbData]);

  const handleGenerateWallet = async () => {
    if (!password || password.length < 8) { pushAlert('error', 'Password must be at least 8 characters'); return; }
    try {
      const ws = await generateWallet(password);
      setWallet(ws); setPassword('');
      pushAlert('success', `Wallet created: ${ws.address.slice(0, 10)}...`);
      setActiveTab('deploy');
    } catch (err: unknown) { pushAlert('error', String(err)); }
  };

  const handleImportWallet = async () => {
    if (!importKeyInput || !password || password.length < 8) { pushAlert('error', 'Enter private key and password (min 8 chars)'); return; }
    try {
      const ws = await importWallet(importKeyInput, password);
      setWallet(ws); setPassword(''); setImportKeyInput(''); setShowImport(false);
      pushAlert('success', `Wallet imported: ${ws.address.slice(0, 10)}...`);
      setActiveTab('deploy');
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

  const handleOneClickStart = async () => {
    if (!wallet?.signer) { pushAlert('error', 'Unlock your wallet first'); setActiveTab('wallet'); return; }
    setDeploying(true);
    pushAlert('info', 'Deploying executor contracts via Gelato SyncFee...');

    for (const chainKey of CHAIN_KEYS) {
      if (!deployedContracts[chainKey]) {
        const result: DeploymentResult = await deployExecutorViaGelato(wallet.signer!, chainKey);
        if (result.success && result.contractAddress) {
          const updated = { ...deployedContracts, [chainKey]: result.contractAddress };
          setDeployedContracts(updated);
          await updateDeployedContracts(wallet.address, updated);
          pushAlert('success', `Executor deployed on ${CHAINS[chainKey].name}: ${result.contractAddress.slice(0, 10)}...`);
          await insertTreasuryEntry({
            execution_id: null,
            amount_usd: 0,
            type: 'deployment',
            chain: chainKey,
          });
        } else {
          pushAlert('warning', `Deploy on ${CHAINS[chainKey].name} pending: ${result.error?.slice(0, 80)}`);
        }
      }
    }

    setDeploying(false);
    setEngineRunning(true);
    pushAlert('success', `Engine started — scanning real DEX prices every ${SCAN_INTERVAL_MS / 1000}s`);
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
        const chain = result.chain;
        if (result.error) {
          await updateEngineStatus(chain, 'error', result.blockNumber, 0, result.scanTimeMs, result.error);
        } else {
          await updateEngineStatus(chain, 'scanning', result.blockNumber, result.opportunities.length, result.scanTimeMs);
        }

        for (const opp of result.opportunities) {
          await insertOpportunity({
            chain: opp.chain,
            opportunity_type: opp.opportunityType,
            token_path: opp.tokenPath,
            dex_path: opp.dexPath,
            pool_addresses: opp.poolAddresses || [],
            flash_loan_provider: 'balancer',
            flash_loan_asset: opp.flashLoanAsset,
            flash_loan_amount: opp.flashLoanAmount,
            estimated_profit: opp.estimatedProfit,
            estimated_gas_cost: opp.estimatedGasCost,
            net_profit: opp.netProfit,
            profit_margin_pct: opp.profitMarginPct,
            pool_reserves: opp.poolReserves || {},
            price_impact: opp.priceImpact || 0,
            confidence_score: opp.confidenceScore,
            status: 'detected',
            block_number: opp.blockNumber,
            expires_at: new Date(Date.now() + 30000).toISOString(),
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
    pushAlert('info', `Executing ${opp.opportunityType} arb on ${opp.chain}: ${opp.tokenPath.join(' -> ')}...`);

    const execId = await insertExecution({
      opportunity_id: null,
      chain: opp.chain,
      tx_hash: null,
      flash_loan_amount: opp.flashLoanAmount,
      flash_loan_fee: 0,
      gas_used: 0,
      gas_cost_usd: opp.estimatedGasCost,
      revenue_gross: opp.estimatedProfit,
      revenue_net: opp.netProfit,
      status: 'pending',
      error_message: null,
      block_number: opp.blockNumber,
      executor_contract: executorAddress,
    });

    const result: ExecutionResult = await executeArbitrageGasless(wallet.signer!, opp.chain, opp, executorAddress);

    if (result.success) {
      setExecutedCount(prev => prev + 1);
      setTotalProfit(prev => prev + (result.profitUsd || 0));

      if (execId) {
        await updateExecutionStatus(execId, 'executed', result.txHash || undefined);
      }
      await incrementEngineTrades(opp.chain);

      await insertTreasuryEntry({
        execution_id: execId,
        amount_usd: opp.netProfit,
        type: 'profit',
        chain: opp.chain,
      });
      await insertTreasuryEntry({
        execution_id: execId,
        amount_usd: opp.estimatedGasCost,
        type: 'gas_cost',
        chain: opp.chain,
      });

      pushAlert('success', `Arb executed on ${opp.chain}: +$${result.profitUsd?.toFixed(2)} (task: ${result.taskId?.slice(0, 12) || 'pending'}...)`);

      if (result.taskId) {
        setTimeout(async () => {
          const status = await getTaskStatus(result.taskId!);
          if (status.success && status.transactionHash) {
            if (execId) await updateExecutionStatus(execId, 'confirmed', status.transactionHash);
            pushAlert('success', `Confirmed on ${opp.chain}: tx ${status.transactionHash.slice(0, 20)}...`);
            await refreshDbData();
          }
        }, 15000);
      }
    } else {
      if (execId) await updateExecutionStatus(execId, 'failed', undefined, result.error);
      pushAlert('error', `Execution failed on ${opp.chain}: ${result.error?.slice(0, 100)}`);
    }
    setExecuting(false);
  };

  const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString();
  const fmtDate = (iso: string) => new Date(iso).toLocaleString();
  const copyToClipboard = (text: string) => { navigator.clipboard.writeText(text); pushAlert('info', 'Copied to clipboard'); };

  const navTabs: { key: Tab; label: string }[] = [
    { key: 'dashboard', label: 'Dashboard' },
    { key: 'wallet', label: 'Wallet' },
    { key: 'opportunities', label: 'Opportunities' },
    { key: 'revenue', label: 'Revenue' },
    { key: 'operator', label: 'Operator' },
    { key: 'deploy', label: 'Deploy' },
    { key: 'settings', label: 'Settings' },
  ];

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
                <Zap className="w-3 h-3 text-emerald-400" /> Zero Capital · SyncFee · Real DEX Prices · {SCAN_INTERVAL_MS / 1000}s Scan
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {gelatoStatus && (
              <div className={`hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-full border ${gelatoStatus.configured ? 'bg-emerald-950/50 border-emerald-800/50' : 'bg-amber-950/50 border-amber-800/50'}`}>
                <div className={`w-1.5 h-1.5 rounded-full ${gelatoStatus.configured ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'}`} />
                <span className={`text-xs ${gelatoStatus.configured ? 'text-emerald-300' : 'text-amber-300'}`}>
                  {gelatoStatus.configured ? 'SyncFee Live' : 'Gelato Key Needed'}
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
              <button onClick={handleOneClickStart} disabled={deploying} className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 rounded-lg flex items-center gap-2 text-sm font-medium transition-colors">
                {deploying ? <RefreshCcw className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                {deploying ? 'Deploying...' : 'Start Engine'}
              </button>
            )}
          </div>
        </div>
        <div className="max-w-7xl mx-auto px-4 flex gap-1 overflow-x-auto">
          {navTabs.map(tab => (
            <button key={tab.key} onClick={() => setActiveTab(tab.key)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                activeTab === tab.key ? 'border-emerald-500 text-emerald-400' : 'border-transparent text-slate-500 hover:text-slate-300'
              }`}>
              {tab.label}
            </button>
          ))}
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6">
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

        {activeTab === 'dashboard' && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <StatCard icon={<DollarSign className="w-5 h-5" />} label="Total Profit" value={`$${totalProfit.toFixed(2)}`} color="emerald" />
              <StatCard icon={<TrendingUp className="w-5 h-5" />} label="Live Opportunities" value={String(allOpportunities.length)} color="cyan" />
              <StatCard icon={<CheckCircle className="w-5 h-5" />} label="Executed" value={String(executedCount)} color="emerald" />
              <StatCard icon={<Activity className="w-5 h-5" />} label="Scans" value={String(scanCount)} color="blue" />
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <StatCard icon={<Coins className="w-5 h-5" />} label="Gas Costs" value={`$${treasurySummary.totalGas.toFixed(2)}`} color="amber" />
              <StatCard icon={<Zap className="w-5 h-5" />} label="Flash Fees" value={`$${treasurySummary.totalFlashFee.toFixed(2)}`} color="cyan" />
              <StatCard icon={<Receipt className="w-5 h-5" />} label="Deploy Costs" value={`$${treasurySummary.totalDeploy.toFixed(2)}`} color="blue" />
              <StatCard icon={<DollarSign className="w-5 h-5" />} label="Net Revenue" value={`$${(treasurySummary.totalProfit - treasurySummary.totalGas - treasurySummary.totalFlashFee - treasurySummary.totalDeploy).toFixed(2)}`} color="emerald" />
            </div>

            <div className="bg-gradient-to-r from-emerald-950/50 to-cyan-950/50 rounded-xl border border-emerald-800/30 p-4">
              <div className="flex items-center gap-3">
                <Zap className="w-5 h-5 text-emerald-400 flex-shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-emerald-300">100% Zero-Capital Architecture · Real DEX Price Feeds</p>
                  <p className="text-xs text-slate-400">
                    Balancer 0% flash loans + Gelato callWithSyncFee (fee from profit, zero deposit). Live Uniswap V3 + SushiSwap + QuickSwap price quotes. Scans every {SCAN_INTERVAL_MS}ms across {CHAIN_KEYS.length} chains.
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
                <StatusItem label="Gas Mode" value={gelatoStatus?.configured ? 'SYNCFEE LIVE' : 'KEY NEEDED'} color={gelatoStatus?.configured ? 'emerald' : 'amber'} />
                <StatusItem label="Scan Rate" value={`${SCAN_INTERVAL_MS / 1000}s`} color="cyan" />
              </div>
            </div>

            <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-6">
              <h3 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2">
                <Activity className="w-4 h-4 text-cyan-400" /> Chain Scanner Status — Live On-Chain Data
              </h3>
              <div className="space-y-2">
                {CHAIN_KEYS.map(chainKey => {
                  const chain = CHAINS[chainKey];
                  const result = scanResults.find(r => r.chain === chainKey);
                  const dbStatus = engineStatusRecords.find(s => s.chain === chainKey);
                  const oppCount = result?.opportunities.length || 0;
                  const priceCount = result?.poolPrices.length || 0;
                  const hasContract = !!deployedContracts[chainKey];
                  const statusValue = dbStatus?.status || 'idle';
                  const blockNum = dbStatus?.current_block || result?.blockNumber || 0;
                  return (
                    <div key={chainKey} className="flex items-center gap-4 bg-slate-800/30 rounded-lg px-4 py-3">
                      <div className={`w-2 h-2 rounded-full ${statusValue === 'scanning' ? 'bg-emerald-400 animate-pulse' : statusValue === 'error' ? 'bg-red-400' : 'bg-slate-600'}`} />
                      <span className="text-sm font-medium w-28">{chain.name}</span>
                      <span className="text-xs text-slate-500">block {blockNum > 0 ? blockNum.toLocaleString() : '--'}</span>
                      <span className="text-xs text-cyan-400">{priceCount} pools</span>
                      <span className="text-xs text-emerald-400">{oppCount} opps</span>
                      {dbStatus && <span className="text-xs text-slate-500">{dbStatus.rpc_latency_ms}ms</span>}
                      <div className="flex-1" />
                      {hasContract ? (
                        <span className="text-xs text-emerald-400 flex items-center gap-1"><CheckCircle className="w-3 h-3" /> Deployed</span>
                      ) : (
                        <span className="text-xs text-slate-500 flex items-center gap-1"><Clock className="w-3 h-3" /> Pending</span>
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
              {allOpportunities.length === 0 ? (
                <p className="text-sm text-slate-500 text-center py-8">
                  {engineRunning ? 'Scanning DEX prices every 3s...' : 'Start the engine to scan real DEX prices for arbitrage opportunities'}
                </p>
              ) : (
                <div className="space-y-2">
                  {allOpportunities.slice(0, 10).map((opp) => (
                    <div key={opp.id} className="flex items-center gap-3 bg-slate-800/30 rounded-lg px-4 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded ${opp.opportunityType === 'triangular' ? 'bg-purple-950/50 text-purple-300' : 'bg-blue-950/50 text-blue-300'}`}>
                        {opp.opportunityType}
                      </span>
                      <span className="text-xs text-slate-400">{opp.chain}</span>
                      <span className="text-xs font-mono text-slate-300 flex-1 truncate">{opp.tokenPath.join(' -> ')}</span>
                      <span className="text-xs text-slate-500">{opp.dexPath.join(' / ')}</span>
                      <span className="text-xs font-semibold text-emerald-400">+${opp.netProfit.toFixed(2)}</span>
                      <span className="text-xs text-slate-500">{opp.profitMarginPct.toFixed(2)}%</span>
                      {wallet?.isUnlocked && deployedContracts[opp.chain] && (
                        <button onClick={() => executeOpportunity(opp)} disabled={executing}
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

        {activeTab === 'wallet' && (
          <div className="max-w-lg space-y-4">
            <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-6">
              <h3 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2">
                <Wallet className="w-4 h-4 text-cyan-400" /> Wallet Management
              </h3>
              {!walletLoaded ? (
                <p className="text-sm text-slate-500">Loading...</p>
              ) : !wallet ? (
                <div className="space-y-4">
                  <p className="text-sm text-slate-400">
                    Create a new wallet or import an existing one. Your private key is encrypted with AES-256-GCM and stored in Supabase.
                  </p>
                  <div className="space-y-3">
                    <div className="relative">
                      <input type={showPassword ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)}
                        placeholder="Password (min 8 chars)"
                        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white pr-10" />
                      <button onClick={() => setShowPassword(!showPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500">
                        {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                    <button onClick={handleGenerateWallet} className="w-full px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-sm font-medium">
                      Generate New Wallet
                    </button>
                    {showImport && (
                      <div className="space-y-2 pt-2 border-t border-slate-800">
                        <input type="text" value={importKeyInput} onChange={e => setImportKeyInput(e.target.value)}
                          placeholder="Private key (0x...)"
                          className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white font-mono" />
                        <button onClick={handleImportWallet} className="w-full px-4 py-2 bg-cyan-600 hover:bg-cyan-500 rounded-lg text-sm font-medium">
                          Import Wallet
                        </button>
                      </div>
                    )}
                    {!showImport && (
                      <button onClick={() => setShowImport(true)} className="w-full text-sm text-slate-400 hover:text-slate-300">
                        Import existing wallet &gt;
                      </button>
                    )}
                  </div>
                </div>
              ) : !wallet.isUnlocked ? (
                <div className="space-y-4">
                  <p className="text-sm text-slate-400">Wallet found: <span className="font-mono text-slate-300">{wallet.address}</span></p>
                  <div className="relative">
                    <input type={showPassword ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)}
                      placeholder="Enter password to unlock" onKeyDown={e => e.key === 'Enter' && handleUnlock()}
                      className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white pr-10" />
                    <button onClick={() => setShowPassword(!showPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500">
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                  <button onClick={handleUnlock} className="w-full px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-sm font-medium">
                    Unlock Wallet
                  </button>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="bg-slate-800/50 rounded-lg p-4">
                    <p className="text-xs text-slate-500 mb-1">Wallet Address</p>
                    <p className="text-sm font-mono text-emerald-300">{wallet.address}</p>
                  </div>
                  <div className="bg-emerald-950/30 rounded-lg p-3 border border-emerald-800/30">
                    <p className="text-xs text-emerald-300 flex items-center gap-1.5">
                      <Zap className="w-3 h-3" /> Zero-capital mode active. No gas tokens needed — SyncFee pays from profit.
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
              <h3 className="text-sm font-semibold text-slate-300 mb-4">Live Opportunities ({allOpportunities.length})</h3>
              {allOpportunities.length === 0 ? (
                <p className="text-sm text-slate-500 text-center py-8">No opportunities found. Start the engine to scan real DEX prices.</p>
              ) : (
                <div className="space-y-2">
                  {allOpportunities.map((opp) => (
                    <div key={opp.id} className="flex items-center gap-3 bg-slate-800/30 rounded-lg px-4 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded ${opp.opportunityType === 'triangular' ? 'bg-purple-950/50 text-purple-300' : 'bg-blue-950/50 text-blue-300'}`}>
                        {opp.opportunityType}
                      </span>
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

            <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-6">
              <h3 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2">
                <Receipt className="w-4 h-4 text-cyan-400" /> Database Opportunities ({opportunityRecords.length})
              </h3>
              {opportunityRecords.length === 0 ? (
                <p className="text-sm text-slate-500 text-center py-4">No opportunities saved to database yet.</p>
              ) : (
                <div className="space-y-2 max-h-96 overflow-y-auto">
                  {opportunityRecords.slice(0, 50).map(o => (
                    <div key={o.id} className="flex items-center gap-3 bg-slate-800/30 rounded-lg px-4 py-2 text-xs">
                      <span className={`px-2 py-0.5 rounded ${o.status === 'executed' ? 'bg-emerald-950/50 text-emerald-300' : o.status === 'expired' ? 'bg-slate-700/50 text-slate-400' : 'bg-blue-950/50 text-blue-300'}`}>{o.status}</span>
                      <span className="text-slate-400">{o.chain}</span>
                      <span className="font-mono text-slate-300 flex-1 truncate">{(Array.isArray(o.token_path) ? o.token_path : []).join(' -> ')}</span>
                      <span className="font-semibold text-emerald-400">+${parseFloat(o.net_profit).toFixed(2)}</span>
                      <span className="text-slate-500">{(parseFloat(o.confidence_score) * 100).toFixed(0)}%</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {scanResults.some(r => r.poolPrices.length > 0) && (
              <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-6">
                <h3 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2">
                  <Activity className="w-4 h-4 text-cyan-400" /> Live DEX Pool Prices
                </h3>
                <div className="space-y-2 max-h-96 overflow-y-auto">
                  {scanResults.flatMap((r, ri) => r.poolPrices.map((p, pi) => (
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

        {activeTab === 'revenue' && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <StatCard icon={<DollarSign className="w-5 h-5" />} label="Total Profit" value={`$${treasurySummary.totalProfit.toFixed(2)}`} color="emerald" />
              <StatCard icon={<Coins className="w-5 h-5" />} label="Gas Costs" value={`$${treasurySummary.totalGas.toFixed(2)}`} color="amber" />
              <StatCard icon={<Receipt className="w-5 h-5" />} label="Executions" value={String(executionRecords.length)} color="cyan" />
              <StatCard icon={<TrendingUp className="w-5 h-5" />} label="Opportunities" value={String(opportunityRecords.length)} color="blue" />
            </div>

            <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-6">
              <h3 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2">
                <Receipt className="w-4 h-4 text-cyan-400" /> Treasury Ledger ({treasuryRecords.length})
              </h3>
              {treasuryRecords.length === 0 ? (
                <p className="text-sm text-slate-500 text-center py-4">No treasury records yet. Start the engine to generate revenue.</p>
              ) : (
                <div className="space-y-2 max-h-96 overflow-y-auto">
                  {treasuryRecords.slice(0, 50).map(t => (
                    <div key={t.id} className="flex items-center gap-3 bg-slate-800/30 rounded-lg px-4 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded ${
                        t.type === 'profit' ? 'bg-emerald-950/50 text-emerald-300'
                        : t.type === 'gas_cost' ? 'bg-amber-950/50 text-amber-300'
                        : t.type === 'flash_fee' ? 'bg-cyan-950/50 text-cyan-300'
                        : 'bg-blue-950/50 text-blue-300'
                      }`}>{t.type}</span>
                      <span className="text-xs text-slate-400">{t.chain}</span>
                      <span className={`text-xs font-semibold flex-1 text-right ${t.type === 'profit' ? 'text-emerald-400' : 'text-amber-400'}`}>
                        {t.type === 'profit' ? '+' : '-'}${parseFloat(t.amount_usd).toFixed(2)}
                      </span>
                      <span className="text-xs text-slate-500">{fmtDate(t.created_at)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-6">
              <h3 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2">
                <Activity className="w-4 h-4 text-emerald-400" /> Execution Records ({executionRecords.length})
              </h3>
              {executionRecords.length === 0 ? (
                <p className="text-sm text-slate-500 text-center py-4">No executions yet. Start the engine to auto-execute arbitrage.</p>
              ) : (
                <div className="space-y-2 max-h-96 overflow-y-auto">
                  {executionRecords.slice(0, 50).map(e => (
                    <div key={e.id} className="flex items-center gap-3 bg-slate-800/30 rounded-lg px-4 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded ${
                        e.status === 'confirmed' ? 'bg-emerald-950/50 text-emerald-300'
                        : e.status === 'executed' ? 'bg-cyan-950/50 text-cyan-300'
                        : e.status === 'pending' ? 'bg-amber-950/50 text-amber-300'
                        : 'bg-red-950/50 text-red-300'
                      }`}>{e.status}</span>
                      <span className="text-xs text-slate-400">{e.chain}</span>
                      <span className="text-xs text-slate-500">flash: ${parseFloat(e.flash_loan_amount).toFixed(0)}</span>
                      <span className="text-xs font-semibold text-emerald-400 flex-1 text-right">+${parseFloat(e.revenue_net).toFixed(2)}</span>
                      <span className="text-xs text-slate-500">gas: ${parseFloat(e.gas_cost_usd).toFixed(2)}</span>
                      {e.tx_hash && <span className="text-xs font-mono text-cyan-400">{e.tx_hash.slice(0, 12)}...</span>}
                      <span className="text-xs text-slate-500">{fmtDate(e.executed_at)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-6">
              <h3 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2">
                <Cpu className="w-4 h-4 text-cyan-400" /> Engine Status by Chain
              </h3>
              <div className="space-y-2">
                {engineStatusRecords.map(s => (
                  <div key={s.id} className="flex items-center gap-3 bg-slate-800/30 rounded-lg px-4 py-3">
                    <div className={`w-2 h-2 rounded-full ${s.status === 'scanning' ? 'bg-emerald-400 animate-pulse' : s.status === 'error' ? 'bg-red-400' : 'bg-slate-600'}`} />
                    <span className="text-sm font-medium w-24">{s.chain}</span>
                    <span className={`text-xs px-2 py-0.5 rounded ${s.status === 'scanning' ? 'bg-emerald-950/50 text-emerald-300' : s.status === 'error' ? 'bg-red-950/50 text-red-300' : 'bg-slate-700/50 text-slate-400'}`}>{s.status}</span>
                    <span className="text-xs text-slate-500">block: {s.current_block?.toLocaleString() || '--'}</span>
                    <span className="text-xs text-emerald-400">{s.opportunities_found} opps</span>
                    <span className="text-xs text-cyan-400">{s.trades_executed} trades</span>
                    <span className="text-xs text-slate-500">{s.rpc_latency_ms}ms</span>
                    {s.last_scan_at && <span className="text-xs text-slate-500 ml-auto">{fmtDate(s.last_scan_at)}</span>}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {activeTab === 'operator' && (
          <div className="max-w-2xl space-y-4">
            <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-6">
              <h3 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2">
                <Settings className="w-4 h-4 text-cyan-400" /> Operator Configuration ({operatorConfig.length})
              </h3>
              {operatorConfig.length === 0 ? (
                <p className="text-sm text-slate-500">Loading config...</p>
              ) : (
                <div className="space-y-2">
                  {operatorConfig.map(cfg => (
                    <div key={cfg.key} className="flex items-start gap-3 bg-slate-800/30 rounded-lg px-4 py-3">
                      <div className="flex-1">
                        <p className="text-sm font-medium text-slate-300">{cfg.key}</p>
                        <p className="text-xs text-slate-500">{cfg.description}</p>
                      </div>
                      <p className="text-xs font-mono text-cyan-300 text-right max-w-xs break-all">
                        {typeof cfg.value === 'object' ? JSON.stringify(cfg.value) : String(cfg.value)}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-6">
              <h3 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2">
                <Cpu className="w-4 h-4 text-cyan-400" /> Arb Engine Config ({arbConfig.length})
              </h3>
              {arbConfig.length === 0 ? (
                <p className="text-sm text-slate-500">Loading config...</p>
              ) : (
                <div className="space-y-2">
                  {arbConfig.map(cfg => (
                    <div key={cfg.key} className="flex items-start gap-3 bg-slate-800/30 rounded-lg px-4 py-3">
                      <p className="text-sm font-medium text-slate-300 flex-1">{cfg.key}</p>
                      <p className="text-xs font-mono text-cyan-300 text-right max-w-xs break-all">
                        {typeof cfg.value === 'object' ? JSON.stringify(cfg.value) : String(cfg.value)}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-6">
              <h3 className="text-sm font-semibold text-slate-300 mb-4">Revenue Flow — Complete Cycle</h3>
              <div className="space-y-3 text-sm text-slate-400">
                {[
                  'Scanner reads real DEX prices from Uniswap V3, SushiSwap, QuickSwap via on-chain quotes',
                  'Price discrepancies detected across DEXs for same token pair (cross-DEX or triangular)',
                  'Opportunity saved to arb_opportunities table with full route details',
                  'Gelato relays executeArb() call to executor contract via callWithSyncFee (zero upfront gas)',
                  'Contract takes Balancer 0% flash loan (no fee, no collateral)',
                  'Swaps execute across DEXs following optimal route',
                  'Flash loan repaid, profit remains in contract',
                  'Gelato fee deducted from profit (SyncFee — zero deposit)',
                  'Execution record saved to arb_executions with tx hash, profit, gas data',
                  'Treasury entries saved to arb_treasury (profit + gas_cost entries)',
                  'Net profit: 85% to owner wallet, 5% Gelato fee, 10% gas reserve',
                  'Engine status updated in arb_engine_status per chain per scan',
                ].map((step, i) => (
                  <div key={i} className="flex items-center gap-3 bg-slate-800/30 rounded-lg px-4 py-3">
                    <div className="w-7 h-7 rounded-full bg-emerald-600 flex items-center justify-center text-white text-xs flex-shrink-0">{i + 1}</div>
                    <span>{step}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {activeTab === 'deploy' && (
          <div className="max-w-2xl space-y-4">
            <div className="bg-slate-900/50 rounded-xl border border-emerald-800/40 p-6">
              <h3 className="text-sm font-semibold text-emerald-300 mb-4 flex items-center gap-2">
                <Rocket className="w-4 h-4 text-emerald-400" /> Zero-Cost Deployment Guide
              </h3>
              <p className="text-sm text-slate-400 mb-4">
                Follow these steps to deploy the full arbitrage engine at zero cost. Everything is gasless — Gelato SyncFee pays from profit.
              </p>

              <div className="space-y-4">
                <DeployStep step={1} title="Create or Import a Wallet" done={!!wallet?.isUnlocked}>
                  <p className="text-xs text-slate-400 mb-2">Go to the Wallet tab and create a new wallet or import an existing one. This wallet receives arbitrage profits.</p>
                  {!wallet?.isUnlocked && (
                    <button onClick={() => setActiveTab('wallet')} className="text-xs text-emerald-400 hover:text-emerald-300 flex items-center gap-1">
                      Go to Wallet <ArrowRight className="w-3 h-3" />
                    </button>
                  )}
                </DeployStep>

                <DeployStep step={2} title="Add Your Gelato API Key" done={!!gelatoStatus?.configured}>
                  <p className="text-xs text-slate-400 mb-2">Add your Gelato API key as an edge function secret:</p>
                  <div className="relative">
                    <code className="block bg-slate-800 text-emerald-300 text-xs px-3 py-2 rounded-lg overflow-x-auto">
                      npx supabase secrets set GELATO_API_KEY=your_key_here
                    </code>
                    <button onClick={() => copyToClipboard('npx supabase secrets set GELATO_API_KEY=your_key_here')}
                      className="absolute right-2 top-1.5 text-slate-500 hover:text-slate-300">
                      <Copy className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <p className="text-xs text-slate-500 mt-2">
                    Free key at{' '}
                    <a href="https://app.gelato.network" target="_blank" rel="noopener noreferrer" className="text-cyan-400 hover:text-cyan-300 inline-flex items-center gap-0.5">
                      app.gelato.network <ExternalLink className="w-3 h-3" />
                    </a>
                  </p>
                </DeployStep>

                <DeployStep step={3} title="Deploy Executor Contracts (Zero Gas)" done={Object.keys(deployedContracts).length === CHAIN_KEYS.length}>
                  <p className="text-xs text-slate-400 mb-2">
                    Click "Start Engine" in the header. The engine deploys executor contracts to all {CHAIN_KEYS.length} chains via Gelato SyncFee. No gas tokens needed.
                  </p>
                  {wallet?.isUnlocked && Object.keys(deployedContracts).length < CHAIN_KEYS.length && (
                    <button onClick={handleOneClickStart} disabled={deploying}
                      className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 rounded text-xs font-medium flex items-center gap-1.5">
                      {deploying ? <RefreshCcw className="w-3 h-3 animate-spin" /> : <Rocket className="w-3 h-3" />}
                      {deploying ? 'Deploying...' : 'Deploy Now'}
                    </button>
                  )}
                </DeployStep>

                <DeployStep step={4} title="Start Scanning & Executing" done={engineRunning}>
                  <p className="text-xs text-slate-400 mb-2">
                    The engine scans real DEX prices every {SCAN_INTERVAL_MS / 1000} seconds. Profitable opportunities execute automatically via Gelato.
                  </p>
                </DeployStep>

                <DeployStep step={5} title="Monitor Revenue" done={totalProfit > 0}>
                  <p className="text-xs text-slate-400 mb-2">
                    Check the Revenue tab for treasury records, execution records, and engine status. All data is live from the database.
                  </p>
                </DeployStep>
              </div>
            </div>

            <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-6">
              <h3 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2">
                <Cpu className="w-4 h-4 text-cyan-400" /> Executor Contract Status
              </h3>
              <div className="space-y-2">
                {CHAIN_KEYS.map(chainKey => {
                  const chain = CHAINS[chainKey];
                  const addr = deployedContracts[chainKey];
                  return (
                    <div key={chainKey} className="flex items-center gap-3 bg-slate-800/50 rounded-lg px-3 py-2">
                      <span className="text-sm font-medium w-24">{chain.name}</span>
                      {addr ? (
                        <><code className="text-xs font-mono text-emerald-300 flex-1 truncate">{addr}</code><CheckCircle className="w-4 h-4 text-emerald-400" /></>
                      ) : (
                        <><span className="text-xs text-slate-500 flex-1">Auto-deploys via Gelato (zero gas)</span><Clock className="w-4 h-4 text-slate-500" /></>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-6">
              <h3 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2">
                <Link2 className="w-4 h-4 text-cyan-400" /> Contract Architecture
              </h3>
              <div className="space-y-3 text-xs text-slate-400">
                <div className="bg-slate-800/30 rounded-lg p-3">
                  <p className="font-semibold text-slate-300 mb-1">FlashArbExecutor.sol</p>
                  <p>Takes Balancer 0% flash loans, executes swaps across Uniswap V3 + V2 DEXs, distributes profit (85% owner / 5% Gelato / 10% reserve). Callable only by Gelato relayer.</p>
                </div>
                <div className="bg-slate-800/30 rounded-lg p-3">
                  <p className="font-semibold text-slate-300 mb-1">Balancer V2 Vault</p>
                  <p>Provides 0% flash loans (no fee, no collateral). Same vault address (0xBA12...) works on all chains.</p>
                </div>
                <div className="bg-slate-800/30 rounded-lg p-3">
                  <p className="font-semibold text-slate-300 mb-1">Gelato Relay Network</p>
                  <p>Relays transactions via callWithSyncFee. Gas fee paid from profit in USDC. Private mempool protects against MEV.</p>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'settings' && (
          <div className="max-w-2xl space-y-4">
            <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-6">
              <h3 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2">
                <Settings className="w-4 h-4 text-cyan-400" /> Engine Settings
              </h3>
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-slate-300">Auto-Execute</p>
                    <p className="text-xs text-slate-500">Automatically execute profitable opportunities via Gelato</p>
                  </div>
                  <button onClick={() => setAutoExecute(!autoExecute)} className={`w-12 h-6 rounded-full transition-colors ${autoExecute ? 'bg-emerald-600' : 'bg-slate-700'}`}>
                    <div className={`w-5 h-5 rounded-full bg-white transition-transform ${autoExecute ? 'translate-x-6' : 'translate-x-0.5'}`} />
                  </button>
                </div>
                <div>
                  <label className="text-sm font-medium text-slate-300">Min Profit (USD)</label>
                  <input type="text" value={minProfit} onChange={e => setMinProfit(e.target.value)}
                    className="w-full px-3 py-2 mt-1 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white" />
                </div>
                <div>
                  <label className="text-sm font-medium text-slate-300">Scan Interval</label>
                  <p className="text-xs text-slate-500 mt-1">{SCAN_INTERVAL_MS / 1000} seconds — matches Polygon/Optimism block times</p>
                </div>
              </div>
            </div>

            <div className="bg-slate-900/50 rounded-xl border border-amber-800/40 p-6">
              <h3 className="text-sm font-semibold text-amber-300 mb-4 flex items-center gap-2">
                <Key className="w-4 h-4 text-amber-400" /> Gelato API Key Status
              </h3>
              <div className={`mb-4 p-3 rounded-lg border ${gelatoStatus?.configured ? 'bg-emerald-950/30 border-emerald-800/40' : 'bg-amber-950/30 border-amber-800/40'}`}>
                <p className={`text-sm flex items-center gap-2 ${gelatoStatus?.configured ? 'text-emerald-300' : 'text-amber-300'}`}>
                  {gelatoStatus?.configured ? <CheckCircle className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
                  {gelatoStatus?.configured ? 'Gelato API key is configured. Live SyncFee execution is active.'
                    : 'Gelato API key is NOT configured. Add it to enable live execution.'}
                </p>
              </div>
              <div className="relative">
                <code className="block bg-slate-800 text-emerald-300 text-xs px-3 py-2 rounded-lg overflow-x-auto">
                  npx supabase secrets set GELATO_API_KEY=your_key_here
                </code>
                <button onClick={() => copyToClipboard('npx supabase secrets set GELATO_API_KEY=your_key_here')}
                  className="absolute right-2 top-1.5 text-slate-500 hover:text-slate-300">
                  <Copy className="w-3.5 h-3.5" />
                </button>
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
                      {addr ? (
                        <><code className="text-xs font-mono text-emerald-300 flex-1 truncate">{addr}</code><CheckCircle className="w-4 h-4 text-emerald-400" /></>
                      ) : (
                        <><span className="text-xs text-slate-500 flex-1">Auto-deploys via Gelato (zero gas)</span><Clock className="w-4 h-4 text-slate-500" /></>
                      )}
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

function StatusItem({ label, value, color }: { label: string; value: string; color: string }) {
  const cm: Record<string, string> = {
    emerald: 'text-emerald-400', cyan: 'text-cyan-400', slate: 'text-slate-500', amber: 'text-amber-400',
  };
  return (
    <div>
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`text-sm font-semibold ${cm[color] || cm.slate}`}>{value}</p>
    </div>
  );
}

function DeployStep({ step, title, done, children }: { step: number; title: string; done: boolean; children: React.ReactNode }) {
  return (
    <div className={`rounded-lg border p-4 ${done ? 'bg-emerald-950/20 border-emerald-800/30' : 'bg-slate-800/30 border-slate-700/50'}`}>
      <div className="flex items-center gap-3 mb-2">
        {done ? (
          <CheckCircle2 className="w-5 h-5 text-emerald-400 flex-shrink-0" />
        ) : (
          <div className="w-5 h-5 rounded-full bg-slate-700 flex items-center justify-center text-xs text-slate-400 flex-shrink-0">{step}</div>
        )}
        <p className={`text-sm font-medium ${done ? 'text-emerald-300' : 'text-slate-300'}`}>{title}</p>
      </div>
      <div className="pl-8">{children}</div>
    </div>
  );
}
