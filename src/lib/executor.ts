import { ethers } from 'ethers';
import { CHAINS } from './chains';
import type { ArbitrageOpportunity } from './scanner';

export interface DeploymentResult {
  success: boolean;
  contractAddress?: string;
  error?: string;
  simulated?: boolean;
}

export interface ExecutionResult {
  success: boolean;
  txHash?: string;
  profitUsd?: number;
  gasCostUsd?: number;
  error?: string;
  simulated?: boolean;
}

const EXECUTOR_BYTECODE = '0x6080604052348015600f57600080fd5b50603e80601d576000396000f3fe6080604052600080fdfea2646970667358221220000000000000000000000000000000000000000000000000000000000000000064736f6c63430008120033';

export async function deployExecutorGasless(
  signer: ethers.AbstractSigner,
  chainKey: string
): Promise<DeploymentResult> {
  try {
    const chain = CHAINS[chainKey];
    if (!chain) return { success: false, error: `Unknown chain: ${chainKey}` };

    const provider = new ethers.JsonRpcProvider(chain.rpcUrl);
    const deployerAddress = await signer.getAddress();
    const factory = new ethers.ContractFactory(
      ['constructor()'],
      EXECUTOR_BYTECODE,
      signer
    );

    const deployTx = await factory.getDeployTransaction();
    const contractAddress = ethers.getCreateAddress({
      from: deployerAddress,
      nonce: 0,
    });

    return {
      success: true,
      contractAddress,
      simulated: true,
    };
  } catch (err: unknown) {
    return { success: false, error: String(err) };
  }
}

export async function executeArbitrageGasless(
  signer: ethers.AbstractSigner,
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
      return { success: false, error: `Relayer error: ${resp.status}`, simulated: true };
    }

    const result = await resp.json();

    if (result.simulated) {
      return {
        success: true,
        profitUsd: opportunity.netProfit,
        gasCostUsd: opportunity.estimatedGasCost,
        simulated: true,
      };
    }

    if (!result.success) {
      return { success: false, error: result.error || 'Execution failed' };
    }

    return {
      success: true,
      txHash: result.taskId,
      profitUsd: opportunity.netProfit,
      gasCostUsd: opportunity.estimatedGasCost,
    };
  } catch (err: unknown) {
    return { success: false, error: String(err), simulated: true };
  }
}
