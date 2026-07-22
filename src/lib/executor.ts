import { ethers } from 'ethers';
import { CHAINS } from './chains';
import { ArbitrageOpportunity } from './scanner';

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
    throw new Error(err.error || `Relayer error: ${resp.status}`);
  }
  return resp.json();
}

export async function deployExecutorGasless(userWallet: ethers.Wallet, chainKey: string): Promise<DeploymentResult> {
  const chain = CHAINS[chainKey];
  if (!chain) return { success: false, contractAddress: null, error: 'Unknown chain', txHash: null, gasless: false };
  try {
    const result = await relay('deploy', {
      chainKey, userAddress: userWallet.address,
      dexConfigs: chain.dexes.map(d => ({ name: d.name, router: d.router, type: d.type })),
    });
    return result.success
      ? { success: true, contractAddress: result.contractAddress, error: null, txHash: result.txHash, gasless: result.gasless || false }
      : { success: false, contractAddress: null, error: result.error, txHash: null, gasless: false };
  } catch (err: any) {
    return { success: false, contractAddress: null, error: err.message, txHash: null, gasless: false };
  }
}

export async function executeArbitrageGasless(
  userWallet: ethers.Wallet, chainKey: string,
  opp: ArbitrageOpportunity, executorAddress: string,
): Promise<ExecutionResult> {
  try {
    const result = await relay('execute', {
      chainKey, executorAddress, opportunity: {
        chain: opp.chain, tokenPath: opp.tokenPath, tokenAddresses: opp.tokenAddresses,
        dexPath: opp.dexPath, flashLoanAsset: opp.flashLoanAsset,
        flashLoanAmount: opp.flashLoanAmount, netProfit: opp.netProfit,
        opportunityType: opp.opportunityType,
      },
      userAddress: userWallet.address,
    });
    return result.success
      ? { success: true, txHash: result.txHash, error: null, gasUsed: result.gasUsed, profitUsd: opp.netProfit, gasless: true }
      : { success: false, txHash: result.txHash || null, error: result.error, gasUsed: null, profitUsd: null, gasless: true };
  } catch (err: any) {
    return { success: false, txHash: null, error: err.message, gasUsed: null, profitUsd: null, gasless: false };
  }
}
