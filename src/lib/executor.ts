import { ethers } from 'ethers';
import { CHAINS } from './chains';
import type { ArbitrageOpportunity } from './scanner';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

export interface ExecutionResult {
  success: boolean; txHash: string | null; error: string | null;
  gasUsed: number | null; profitUsd: number | null; gasless: boolean;
}

export interface DeploymentResult {
  success: boolean; contractAddress: string | null;
  error: string | null; txHash: string | null; gasless: boolean;
}

async function relay(action: string, payload: Record<string, unknown>): Promise<any> {
  const resp = await fetch(`${supabaseUrl}/functions/v1/relayer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${supabaseKey}` },
    body: JSON.stringify({ action, ...payload }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
    throw new Error((err as any).error || `Relayer error: ${resp.status}`);
  }
  return resp.json();
}

export async function deployExecutorGasless(_wallet: ethers.Wallet, chainKey: string): Promise<DeploymentResult> {
  if (!CHAINS[chainKey]) return { success: false, contractAddress: null, error: 'Unknown chain', txHash: null, gasless: false };
  try {
    const result = await relay('deploy', { chainKey, userAddress: _wallet.address });
    return result.success
      ? { success: true, contractAddress: result.contractAddress, error: null, txHash: result.txHash, gasless: true }
      : { success: false, contractAddress: null, error: result.error, txHash: null, gasless: false };
  } catch (err: unknown) {
    return { success: false, contractAddress: null, error: String(err), txHash: null, gasless: false };
  }
}

export async function executeArbitrageGasless(
  _wallet: ethers.Wallet, chainKey: string,
  opp: ArbitrageOpportunity, executorAddress: string,
): Promise<ExecutionResult> {
  try {
    const result = await relay('execute', {
      chainKey, executorAddress,
      opportunity: {
        chain: opp.chain, tokenPath: opp.tokenPath, tokenAddresses: opp.tokenAddresses,
        dexPath: opp.dexPath, flashLoanAsset: opp.flashLoanAsset,
        flashLoanAmount: opp.flashLoanAmount, netProfit: opp.netProfit,
        opportunityType: opp.opportunityType,
      },
      userAddress: _wallet.address,
    });
    return result.success
      ? { success: true, txHash: result.txHash, error: null, gasUsed: result.gasUsed ?? null, profitUsd: opp.netProfit, gasless: true }
      : { success: false, txHash: result.txHash ?? null, error: result.error, gasUsed: null, profitUsd: null, gasless: true };
  } catch (err: unknown) {
    return { success: false, txHash: null, error: String(err), gasUsed: null, profitUsd: null, gasless: false };
  }
}
