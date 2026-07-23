import { supabase } from './supabase';

export interface OperatorConfig {
  key: string;
  value: unknown;
  description: string;
}

export interface RevenueRecord {
  id: string;
  subscriber_address: string;
  amount_fet: string;
  usd_value: string;
  signal_request_id: string | null;
  tx_hash: string | null;
  block_number: number | null;
  status: string;
  created_at: string;
}

export interface SignalRequest {
  id: string;
  subscriber_address: string;
  signal_type: string;
  tier: string;
  result_count: number;
  latency_ms: number;
  payment_amount: string;
  payment_status: string;
  payment_tx_hash: string | null;
  created_at: string;
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

export interface EscrowRebate {
  id: string;
  transaction_hash: string;
  sender_address: string;
  recipient_address: string | null;
  amount_numeric: string;
  token_address: string | null;
  rebate_type: string;
  status: string;
  block_number: number | null;
  gas_used: string | null;
  gas_price: string | null;
  confirmed_at: string | null;
  created_at: string;
}

export async function fetchOperatorConfig(): Promise<OperatorConfig[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('operator_config')
    .select('*')
    .order('key');
  if (error) return [];
  return (data as OperatorConfig[]) || [];
}

export async function updateOperatorConfig(key: string, value: unknown): Promise<boolean> {
  if (!supabase) return false;
  if (!key || typeof key !== 'string' || key.length > 100) return false;
  const { error } = await supabase
    .from('operator_config')
    .update({ value, updated_at: new Date().toISOString() })
    .eq('key', key);
  return !error;
}

export async function fetchRevenueRecords(limit = 50): Promise<RevenueRecord[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('agent_revenue')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) return [];
  return (data as RevenueRecord[]) || [];
}

export async function fetchSignalRequests(limit = 50): Promise<SignalRequest[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('signal_requests')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) return [];
  return (data as SignalRequest[]) || [];
}

export async function fetchTreasuryRecords(limit = 50): Promise<TreasuryRecord[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('arb_treasury')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) return [];
  return (data as TreasuryRecord[]) || [];
}

export async function fetchEscrowRebates(limit = 50): Promise<EscrowRebate[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('escrow_rebates')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) return [];
  return (data as EscrowRebate[]) || [];
}

export async function fetchTreasurySummary(): Promise<{ totalProfit: number; totalGas: number; totalFlashFee: number; totalDeploy: number }> {
  if (!supabase) return { totalProfit: 0, totalGas: 0, totalFlashFee: 0, totalDeploy: 0 };
  const { data, error } = await supabase
    .from('arb_treasury')
    .select('type, amount_usd');
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
