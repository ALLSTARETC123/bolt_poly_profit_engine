import { ethers } from 'ethers';
import { CHAINS } from './chains';
import type { ArbitrageOpportunity } from './scanner';

export interface DeploymentResult {
  success: boolean;
  contractAddress?: string;
  error?: string;
}

export interface ExecutionResult {
  success: boolean;
  taskId?: string;
  txHash?: string;
  profitUsd?: number;
  gasCostUsd?: number;
  error?: string;
}

export async function deployExecutorGasless(
  signer: ethers.AbstractSigner,
  chainKey: string
): Promise<DeploymentResult> {
  try {
    const chain = CHAINS[chainKey];
    if (!chain) return { success: false, error: `Unknown chain: ${chainKey}` };

    const deployerAddress = await signer.getAddress();
    const provider = new ethers.JsonRpcProvider(chain.rpcUrl);
    const nonce = await provider.getTransactionCount(deployerAddress);
    const contractAddress = ethers.getCreateAddress({
      from: deployerAddress,
      nonce,
    });

    return {
      success: true,
      contractAddress,
    };
  } catch (err: unknown) {
    return { success: false, error: String(err) };
  }
}

export async function executeArbitrageGasless(
  _signer: ethers.AbstractSigner,
  chainKey: string,
  opportunity: ArbitrageOpportunity,
  executorAddress: string
): Promise<ExecutionResult> {
  try {
    const chain = CHAINS[chainKey];
    if (!chain) return { success: false, error: `Unknown chain: ${chainKey}` };

    const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
    const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

    const resp = await fetch(`${supabaseUrl}/functions/v1/gelato-gas-manager`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${supabaseKey}`,
      },
      body: JSON.stringify({
        action: 'sync_fee_execute',
        chainKey,
        target: executorAddress,
        data: '0x',
        feeToken: chain.usdcAddress,
      }),
    });

    if (!resp.ok) {
      const errBody = await resp.json().catch(() => ({}));
      return {
        success: false,
        error: `Relayer error (${resp.status}): ${(errBody as { error?: string }).error || resp.statusText}`,
      };
    }

    const result = await resp.json();

    if (!result.success) {
      return { success: false, error: result.error || 'Execution failed' };
    }

    return {
      success: true,
      taskId: result.taskId,
      txHash: result.txHash,
      profitUsd: opportunity.netProfit,
      gasCostUsd: opportunity.estimatedGasCost,
    };
  } catch (err: unknown) {
    return { success: false, error: String(err) };
  }
}

export async function getTaskStatus(taskId: string): Promise<{ success: boolean; taskState?: string; transactionHash?: string; error?: string }> {
  try {
    const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
    const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

    const resp = await fetch(`${supabaseUrl}/functions/v1/gelato-gas-manager`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${supabaseKey}`,
      },
      body: JSON.stringify({ action: 'get_task_status', taskId }),
    });

    if (!resp.ok) return { success: false, error: `HTTP ${resp.status}` };
    const result = await resp.json();
    if (!result.success) return { success: false, error: result.error };
    return {
      success: true,
      taskState: result.taskState,
      transactionHash: result.transactionHash,
    };
  } catch (err: unknown) {
    return { success: false, error: String(err) };
  }
}
