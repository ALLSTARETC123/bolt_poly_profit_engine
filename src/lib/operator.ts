import { supabase } from './supabase';

export interface OperatorConfig {
  key: string;
  value: unknown;
  description: string;
}

export interface TreasuryRecord {
  id: string;
  execution_id: string | null;
  amount_usd: string;
  cumulative_usd: string;
  type: string;
  chain: string;
  created_at: string;
}

export interface ExecutionRecord {
  id: string;
  opportunity_id: string | null;
  chain: string;
  tx_hash: string | null;
  flash_loan_amount: string;
  flash_loan_fee: string;
  gas_used: string;
  gas_cost_usd: string;
  revenue_gross: string;
  revenue_net: string;
  status: string;
  error_message: string | null;
  block_number: number | null;
  executor_contract: string | null;
  executed_at: string;
}

export interface OpportunityRecord {
  id: string;
  chain: string;
  opportunity_type: string;
  token_path: string[];
  dex_path: string[];
  pool_addresses: string[];
  flash_loan_provider: string;
  flash_loan_asset: string;
  flash_loan_amount: string;
  estimated_profit: string;
  estimated_gas_cost: string;
  net_profit: string;
  profit_margin_pct: string;
  pool_reserves: Record<string, string>;
  price_impact: string;
  confidence_score: string;
  status: string;
  block_number: number;
  expires_at: string;
  created_at: string;
}

export interface EngineStatusRecord {
  id: string;
  chain: string;
  status: string;
  last_scan_at: string;
  opportunities_found: number;
  trades_executed: number;
  current_block: number;
  rpc_latency_ms: number;
  error_message: string | null;
  updated_at: string;
}

export async function fetchOperatorConfig(): Promise<OperatorConfig[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.from('operator_config').select('*').order('key');
  if (error) return [];
  return (data as OperatorConfig[]) || [];
}

export async function fetchArbConfig(): Promise<{ key: string; value: unknown }[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.from('arb_config').select('*').order('key');
  if (error) return [];
  return (data as { key: string; value: unknown }[]) || [];
}

export async function fetchTreasuryRecords(limit = 100): Promise<TreasuryRecord[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('arb_treasury').select('*').order('created_at', { ascending: false }).limit(limit);
  if (error) return [];
  return (data as TreasuryRecord[]) || [];
}

export async function fetchExecutionRecords(limit = 100): Promise<ExecutionRecord[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('arb_executions').select('*').order('executed_at', { ascending: false }).limit(limit);
  if (error) return [];
  return (data as ExecutionRecord[]) || [];
}

export async function fetchOpportunityRecords(limit = 100): Promise<OpportunityRecord[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('arb_opportunities').select('*').order('created_at', { ascending: false }).limit(limit);
  if (error) return [];
  return (data as OpportunityRecord[]) || [];
}

export async function fetchEngineStatus(): Promise<EngineStatusRecord[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('arb_engine_status').select('*').order('chain');
  if (error) return [];
  return (data as EngineStatusRecord[]) || [];
}

export async function insertOpportunity(opp: {
  chain: string;
  opportunity_type: string;
  token_path: string[];
  dex_path: string[];
  pool_addresses: string[];
  flash_loan_provider: string;
  flash_loan_asset: string;
  flash_loan_amount: number;
  estimated_profit: number;
  estimated_gas_cost: number;
  net_profit: number;
  profit_margin_pct: number;
  pool_reserves: Record<string, string>;
  price_impact: number;
  confidence_score: number;
  status: string;
  block_number: number;
  expires_at: string;
}): Promise<string | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.from('arb_opportunities').insert({
    ...opp,
    token_path: opp.token_path as unknown as never,
    dex_path: opp.dex_path as unknown as never,
    pool_addresses: opp.pool_addresses as unknown as never,
    pool_reserves: opp.pool_reserves as unknown as never,
  }).select('id').maybeSingle();
  if (error) return null;
  return (data as { id: string } | null)?.id || null;
}

export async function updateOpportunityStatus(id: string, status: string): Promise<void> {
  if (!supabase) return;
  await supabase.from('arb_opportunities').update({ status }).eq('id', id);
}

export async function insertExecution(exec: {
  opportunity_id: string | null;
  chain: string;
  tx_hash: string | null;
  flash_loan_amount: number;
  flash_loan_fee: number;
  gas_used: number;
  gas_cost_usd: number;
  revenue_gross: number;
  revenue_net: number;
  status: string;
  error_message: string | null;
  block_number: number | null;
  executor_contract: string | null;
}): Promise<string | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.from('arb_executions').insert(exec).select('id').maybeSingle();
  if (error) return null;
  return (data as { id: string } | null)?.id || null;
}

export async function updateExecutionStatus(id: string, status: string, txHash?: string, errorMessage?: string): Promise<void> {
  if (!supabase) return;
  const update: Record<string, unknown> = { status };
  if (txHash) update.tx_hash = txHash;
  if (errorMessage) update.error_message = errorMessage;
  await supabase.from('arb_executions').update(update).eq('id', id);
}

export async function insertTreasuryEntry(entry: {
  execution_id: string | null;
  amount_usd: number;
  type: string;
  chain: string;
}): Promise<void> {
  if (!supabase) return;
  await supabase.from('arb_treasury').insert(entry);
}

export async function updateEngineStatus(chain: string, status: string, blockNumber: number, opportunitiesFound: number, rpcLatencyMs: number, errorMessage?: string): Promise<void> {
  if (!supabase) return;
  await supabase.from('arb_engine_status').update({
    status,
    current_block: blockNumber,
    opportunities_found: opportunitiesFound,
    last_scan_at: new Date().toISOString(),
    rpc_latency_ms: rpcLatencyMs,
    error_message: errorMessage || null,
    updated_at: new Date().toISOString(),
  }).eq('chain', chain);
}

export async function incrementEngineTrades(chain: string): Promise<void> {
  if (!supabase) return;
  const { data } = await supabase.from('arb_engine_status').select('trades_executed').eq('chain', chain).maybeSingle();
  const current = (data as { trades_executed: number } | null)?.trades_executed || 0;
  await supabase.from('arb_engine_status').update({
    trades_executed: current + 1,
    updated_at: new Date().toISOString(),
  }).eq('chain', chain);
}

export async function fetchTreasurySummary(): Promise<{ totalProfit: number; totalGas: number; totalFlashFee: number; totalDeploy: number }> {
  if (!supabase) return { totalProfit: 0, totalGas: 0, totalFlashFee: 0, totalDeploy: 0 };
  const { data, error } = await supabase.from('arb_treasury').select('type, amount_usd');
  if (error || !data) return { totalProfit: 0, totalGas: 0, totalFlashFee: 0, totalDeploy: 0 };

  const records = data as { type: string; amount_usd: string }[];
  const summary = { totalProfit: 0, totalGas: 0, totalFlashFee: 0, totalDeploy: 0 };
  for (const r of records) {
    const amt = parseFloat(r.amount_usd || '0');
    if (r.type === 'profit') summary.totalProfit += amt;
    else if (r.type === 'gas_cost') summary.totalGas += amt;
    else if (r.type === 'flash_fee') summary.totalFlashFee += amt;
    else if (r.type === 'deployment') summary.totalDeploy += amt;
  }
  return summary;
}
