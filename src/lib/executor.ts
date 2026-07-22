import { ethers } from 'ethers';
import { CHAINS } from './chains';
import { ArbitrageOpportunity } from './scanner';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const EXECUTOR_ABI = [
  'function executeArbWithSig(address asset, uint256 amount, bytes params, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external',
  'function initializeOwner(address _owner) external',
  'function setV2Router(string name, address router) external',
  'function setV3Router(address router) external',
  'function setGelatoRelayer(address _relayer) external',
  'function owner() view returns (address)',
  'function nonces(address) view returns (uint256)',
  'function totalProfit() view returns (uint256)',
  'function gasReserve() view returns (uint256)',
];

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
  if (!resp.ok) throw new Error(`Relayer error: ${resp.status}`);
  return resp.json();
}

export async function deployExecutorGasless(userWallet: ethers.Wallet, chainKey: string): Promise<DeploymentResult> {
  const chain = CHAINS[chainKey];
  if (!chain) return { success: false, contractAddress: null, error: 'Unknown chain', txHash: null, gasless: false };
  try {
    const v3Dex = chain.dexes.find(d => d.type === 'uniswap_v3');
    const result = await relay('deploy', {
      chainKey, userAddress: userWallet.address,
      balancerVault: chain.balancerVault,
      v3Router: v3Dex?.router || ethers.ZeroAddress,
      feeToken: chain.tokens.USDC?.address || ethers.ZeroAddress,
      gelatoFeeCollector: chain.gelatoFeeCollector,
      dexConfigs: chain.dexes.map(d => ({ name: d.name, router: d.router, type: d.type })),
    });
    return result.success
      ? { success: true, contractAddress: result.contractAddress, error: null, txHash: result.txHash, gasless: true }
      : { success: false, contractAddress: null, error: result.error, txHash: null, gasless: false };
  } catch (err: any) {
    return { success: false, contractAddress: null, error: err.message, txHash: null, gasless: false };
  }
}

export function encodeArbParams(opp: ArbitrageOpportunity): string {
  const chain = CHAINS[opp.chain];
  if (!chain) return '0x';
  const v3Fees: number[] = [];
  for (let i = 0; i < opp.dexPath.length; i++) {
    const dex = chain.dexes.find(d => opp.dexPath[i].startsWith(d.name));
    v3Fees.push(dex?.type === 'uniswap_v3' ? 3000 : 0);
  }
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ['uint8', 'string[]', 'address[]', 'uint24[]'],
    [0, opp.dexPath, opp.tokenAddresses, v3Fees],
  );
}

export async function executeArbitrageGasless(
  userWallet: ethers.Wallet, chainKey: string,
  opp: ArbitrageOpportunity, executorAddress: string,
): Promise<ExecutionResult> {
  const chain = CHAINS[chainKey];
  if (!chain) return { success: false, txHash: null, error: 'Unknown chain', gasUsed: null, profitUsd: null, gasless: false };
  try {
    const provider = new ethers.JsonRpcProvider(chain.rpc[0]);
    const executor = new ethers.Contract(executorAddress, EXECUTOR_ABI, provider);
    const currentNonce = await executor.nonces(userWallet.address).catch(() => 0n);
    const deadline = Math.floor(Date.now() / 1000) + 600;
    const token = Object.values(chain.tokens).find(t => t.address === opp.flashLoanAsset);
    const decimals = token?.decimals || 18;
    const flashAmount = ethers.parseUnits(opp.flashLoanAmount.toString(), decimals);
    const params = encodeArbParams(opp);

    const domain = { name: 'FlashArbExecutor', version: '1', chainId: chain.id, verifyingContract: executorAddress };
    const types = {
      ExecuteArb: [
        { name: 'asset', type: 'address' }, { name: 'amount', type: 'uint256' },
        { name: 'params', type: 'bytes' }, { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    };
    const value = { asset: opp.flashLoanAsset, amount: flashAmount, params, nonce: currentNonce, deadline };
    const signature = await userWallet.signTypedData(domain, types, value);
    const sig = ethers.Signature.from(signature);

    const result = await relay('execute', {
      chainKey, executorAddress, asset: opp.flashLoanAsset,
      amount: flashAmount.toString(), params, deadline,
      v: sig.v, r: sig.r, s: sig.s, userAddress: userWallet.address,
    });

    return result.success
      ? { success: true, txHash: result.txHash, error: null, gasUsed: result.gasUsed, profitUsd: opp.netProfit, gasless: true }
      : { success: false, txHash: result.txHash || null, error: result.error, gasUsed: null, profitUsd: null, gasless: true };
  } catch (err: any) {
    return { success: false, txHash: null, error: err.message, gasUsed: null, profitUsd: null, gasless: false };
  }
}
