import { ethers } from 'ethers';
import { CHAINS, getAlchemyRpcUrl } from './chains';
import { supabase } from './supabase';

export interface ExecutionResult {
  success: boolean;
  txHash?: string;
  error?: string;
  profitUsd?: number;
  gasCostUsd?: number;
  taskId?: string;
}

export interface AlchemyConfig {
  apiKey: string;
  paymasterPolicyId?: string;
}

const EXECUTOR_ABI = [
  { inputs: [{ name: 'asset', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'params', type: 'bytes' }], name: 'executeArb', outputs: [], stateMutability: 'nonpayable', type: 'function' },
  { inputs: [{ name: '_owner', type: 'address' }], name: 'initializeOwner', outputs: [], stateMutability: 'nonpayable', type: 'function' },
  { inputs: [{ name: 'name', type: 'string' }, { name: 'router', type: 'address' }], name: 'setV2Router', outputs: [], stateMutability: 'nonpayable', type: 'function' },
  { inputs: [], name: 'owner', outputs: [{ name: '', type: 'address' }], stateMutability: 'view', type: 'function' },
  { inputs: [], name: 'totalProfit', outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' },
  { inputs: [], name: 'gasReserve', outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' },
];

export async function getAlchemyConfig(): Promise<AlchemyConfig | null> {
  try {
    const { data, error } = await supabase!.from('operator_config')
      .select('key, value').eq('key', 'alchemy_api_key').maybeSingle();
    if (error || !data?.value) return null;
    const policyData = await supabase!.from('operator_config')
      .select('value').eq('key', 'alchemy_paymaster_policy_id').maybeSingle();
    return { apiKey: data.value, paymasterPolicyId: policyData.data?.value || undefined };
  } catch { return null; }
}

export async function setAlchemyConfig(apiKey: string, policyId?: string): Promise<void> {
  if (!supabase) return;
  await supabase.from('operator_config').upsert({ key: 'alchemy_api_key', value: apiKey, description: 'Alchemy API key for RPC and gas sponsorship' }, { onConflict: 'key' });
  if (policyId) {
    await supabase.from('operator_config').upsert({ key: 'alchemy_paymaster_policy_id', value: policyId, description: 'Alchemy paymaster policy ID for gas sponsorship' }, { onConflict: 'key' });
  }
}

export async function checkAlchemyHealth(): Promise<{ configured: boolean; mode: string; paymasterPolicyId?: string }> {
  const config = await getAlchemyConfig();
  if (!config?.apiKey) return { configured: false, mode: 'public_rpc' };
  return { configured: true, mode: 'alchemy_sponsored', paymasterPolicyId: config.paymasterPolicyId };
}

function getProvider(chainKey: string, alchemyKey?: string): ethers.JsonRpcProvider {
  const url = alchemyKey ? getAlchemyRpcUrl(chainKey, alchemyKey) : CHAINS[chainKey].rpcUrl;
  return new ethers.JsonRpcProvider(url, {
    chainId: CHAINS[chainKey].chainId,
    name: CHAINS[chainKey].name,
    ensAddress: undefined,
  }, { staticNetwork: true, batchStallTime: 0 });
}

export async function deployExecutor(
  signer: ethers.Wallet,
  chainKey: string,
  bytecode: string,
  constructorArgs: string
): Promise<ExecutionResult> {
  try {
    const alchemyConfig = await getAlchemyConfig();
    const provider = getProvider(chainKey, alchemyConfig?.apiKey);
    const connectedSigner = signer.connect(provider);
    const fullBytecode = '0x' + bytecode.replace(/^0x/, '') + constructorArgs.replace(/^0x/, '');
    const tx = await connectedSigner.sendTransaction({ data: fullBytecode, gasLimit: 3000000, chainId: CHAINS[chainKey].chainId });
    const receipt = await tx.wait();
    if (receipt?.status === 1 && receipt.contractAddress) {
      const executor = new ethers.Contract(receipt.contractAddress, EXECUTOR_ABI, connectedSigner);
      try { await executor.initializeOwner(await connectedSigner.getAddress()); } catch { /* may already be initialized */ }
      const chain = CHAINS[chainKey];
      try { await executor.setV2Router('sushi', chain.sushiRouter); } catch { /* skip */ }
      if (chain.quickswapRouter !== '0x0000000000000000000000000000000000000000') {
        try { await executor.setV2Router('quickswap', chain.quickswapRouter); } catch { /* skip */ }
      }
      return { success: true, txHash: tx.hash };
    }
    return { success: false, error: 'Deployment failed' };
  } catch (err: unknown) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function executeArbitrage(
  signer: ethers.Wallet,
  chainKey: string,
  tokenPath: string[],
  dexPath: string[],
  flashLoanAmount: number,
  flashLoanAsset: string,
  executorAddress: string
): Promise<ExecutionResult> {
  try {
    const alchemyConfig = await getAlchemyConfig();
    const provider = getProvider(chainKey, alchemyConfig?.apiKey);
    const connectedSigner = signer.connect(provider);
    const executor = new ethers.Contract(executorAddress, EXECUTOR_ABI, connectedSigner);

    const chain = CHAINS[chainKey];
    const tokenAddresses = tokenPath.map(t => {
      if (t === 'WETH') return chain.wethAddress;
      if (t === 'USDC') return chain.usdcAddress;
      if (t === 'USDT') return chain.usdtAddress;
      if (t === 'DAI') return chain.daiAddress;
      if (t === 'WBTC') return chain.wbtcAddress;
      return '';
    });

    const params = ethers.AbiCoder.defaultAbiCoder().encode(
      ['uint8', 'address', 'string[]', 'address[]', 'uint24[]'],
      [0, '0x0000000000000000000000000000000000000000', dexPath, tokenAddresses, [3000, 3000, 3000]]
    );

    const amountWei = ethers.parseUnits(flashLoanAmount.toString(), 6);
    const tx = await executor.executeArb(flashLoanAsset, amountWei, params, { gasLimit: 500000, chainId: CHAINS[chainKey].chainId });
    const receipt = await tx.wait();
    return { success: receipt?.status === 1, txHash: tx.hash };
  } catch (err: unknown) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function getExecutorStats(executorAddress: string, chainKey: string): Promise<{ totalProfit: string; gasReserve: string; owner: string } | null> {
  try {
    const alchemyConfig = await getAlchemyConfig();
    const provider = getProvider(chainKey, alchemyConfig?.apiKey);
    const executor = new ethers.Contract(executorAddress, EXECUTOR_ABI, provider);
    const [totalProfit, gasReserve, owner] = await Promise.all([
      executor.totalProfit(), executor.gasReserve(), executor.owner()
    ]);
    return { totalProfit: totalProfit.toString(), gasReserve: gasReserve.toString(), owner };
  } catch { return null; }
}
