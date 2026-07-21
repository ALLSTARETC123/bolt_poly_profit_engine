/**
 * Gasless execution engine.
 *
 * The user NEVER needs native tokens. Instead:
 * 1. User signs an EIP-712 message in the browser (free, off-chain).
 * 2. The signed message is sent to a Supabase Edge Function (relayer).
 * 3. The relayer holds a small "gas tank" wallet, submits the transaction on-chain,
 *    and gets reimbursed from the contract's profit (5% of each arb).
 * 4. The contract's gas reserve (10% of profit) replenishes the relayer's gas tank.
 *
 * This eliminates the cold-start problem entirely.
 */

import { ethers } from 'ethers';
import { createClient } from '@supabase/supabase-js';
import { CHAINS } from './chains';
import { ArbitrageOpportunity } from './scanner';
import executorBytecode from './FlashArbExecutor.bin.txt?raw';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

export const EXECUTOR_ABI = [
  'function executeArb(address asset, uint256 amount, bytes params) external',
  'function executeArbWithSig(address asset, uint256 amount, bytes params, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external',
  'function initializeOwner(address _owner) external',
  'function setV2Router(string name, address router) external',
  'function setV3Router(address router) external',
  'function setBalancerVault(address vault) external',
  'function setRelayer(address _relayer) external',
  'function owner() view returns (address)',
  'function relayer() view returns (address)',
  'function balancerVault() view returns (address)',
  'function totalProfit() view returns (uint256)',
  'function gasReserve() view returns (uint256)',
  'function v2Routers(string) view returns (address)',
  'function v3Router() view returns (address)',
  'function nonces(address) view returns (uint256)',
  'function useGasReserve(address wrappedNative, uint256 amount) external',
  'function withdrawProfit(address token, address to) external',
  'function getBalance(address token) view returns (uint256)',
  'event ArbExecuted(address indexed asset, uint256 borrowed, uint256 profit, uint256 toOwner, uint256 toRelayer, uint256 gasReserveAfter, uint8 provider)',
];

export interface ExecutionResult {
  success: boolean;
  txHash: string | null;
  error: string | null;
  gasUsed: number | null;
  profitUsd: number | null;
  autoFixed: string | null;
  gasless: boolean;
}

export interface DeploymentResult {
  success: boolean;
  contractAddress: string | null;
  error: string | null;
  txHash: string | null;
  gasless: boolean;
}

/**
 * Gasless deploy: asks the relayer (Edge Function) to deploy the contract
 * on behalf of the user. The relayer pays gas, then is set as the relayer
 * on the contract. The user's address is set as the owner.
 */
export async function deployExecutorGasless(
  userWallet: ethers.Wallet,
  chainKey: string,
): Promise<DeploymentResult> {
  const chain = CHAINS[chainKey];
  if (!chain) return { success: false, contractAddress: null, error: 'Unknown chain', txHash: null, gasless: false };

  try {
    const v3Dex = chain.dexes.find(d => d.type === 'uniswap_v3');
    const v3Router = v3Dex?.router || ethers.ZeroAddress;

    // Ask the relayer to deploy on our behalf
    const response = await fetch(`${supabaseUrl}/functions/v1/relayer`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${supabaseKey}`,
      },
      body: JSON.stringify({
        action: 'deploy',
        chainKey,
        userAddress: userWallet.address,
        balancerVault: chain.balancerVault,
        v3Router,
        bytecode: executorBytecode,
        abi: EXECUTOR_ABI,
        dexConfigs: chain.dexes.map(d => ({ name: d.name, router: d.router, type: d.type })),
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return { success: false, contractAddress: null, error: `Relayer error: ${errText.slice(0, 200)}`, txHash: null, gasless: false };
    }

    const result = await response.json();
    if (result.success) {
      return {
        success: true,
        contractAddress: result.contractAddress,
        error: null,
        txHash: result.txHash,
        gasless: true,
      };
    } else {
      return { success: false, contractAddress: null, error: result.error, txHash: null, gasless: false };
    }
  } catch (err: any) {
    return { success: false, contractAddress: null, error: err.message, txHash: null, gasless: false };
  }
}

/**
 * Encode arb params for the contract.
 * Provider: 0 = Balancer V2, 1 = DODO V2
 */
export function encodeArbParams(opp: ArbitrageOpportunity, dodoPoolAddress: string | null): string {
  const chain = CHAINS[opp.chain];
  if (!chain) return '0x';
  const provider = opp.flashProvider === 'dodo_v2' ? 1 : 0;
  const v3Fees: number[] = [];
  for (let i = 0; i < opp.dexPath.length; i++) {
    const dex = chain.dexes.find(d => opp.dexPath[i].startsWith(d.name));
    v3Fees.push(dex?.type === 'uniswap_v3' ? 3000 : 0);
  }
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ['uint8', 'address', 'string[]', 'address[]', 'uint24[]'],
    [provider, dodoPoolAddress || ethers.ZeroAddress, opp.dexPath, opp.tokenAddresses, v3Fees],
  );
}

/**
 * Gasless execute: user signs EIP-712 message, relayer submits the transaction.
 * The user never needs native tokens.
 */
export async function executeArbitrageGasless(
  userWallet: ethers.Wallet,
  chainKey: string,
  opp: ArbitrageOpportunity,
  executorAddress: string,
  dodoPoolAddress: string | null,
): Promise<ExecutionResult> {
  const chain = CHAINS[chainKey];
  if (!chain) return { success: false, txHash: null, error: 'Unknown chain', gasUsed: null, profitUsd: null, autoFixed: null, gasless: false };

  try {
    const provider = new ethers.JsonRpcProvider(chain.rpc[0]);
    const executor = new ethers.Contract(executorAddress, EXECUTOR_ABI, provider);

    // Get the current nonce from the contract
    const currentNonce = await executor.nonces(userWallet.address).catch(() => 0n);
    const deadline = Math.floor(Date.now() / 1000) + 600; // 10 min

    const flashAsset = opp.flashLoanAsset;
    const token = Object.values(chain.tokens).find(t => t.address === flashAsset);
    const decimals = token?.decimals || 18;
    const flashAmount = ethers.parseUnits(opp.flashLoanAmount.toString(), decimals);
    const params = encodeArbParams(opp, dodoPoolAddress);

    // Sign the EIP-712 message (free, off-chain)
    const domain = {
      name: 'FlashArbExecutor',
      version: '1',
      chainId: chain.id,
      verifyingContract: executorAddress,
    };
    const types = {
      ExecuteArb: [
        { name: 'asset', type: 'address' },
        { name: 'amount', type: 'uint256' },
        { name: 'params', type: 'bytes' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    };
    const value = {
      asset: flashAsset,
      amount: flashAmount,
      params: params,
      nonce: currentNonce,
      deadline: deadline,
    };

    const signature = await userWallet.signTypedData(domain, types, value);
    const sig = ethers.Signature.from(signature);

    // Send to relayer
    const response = await fetch(`${supabaseUrl}/functions/v1/relayer`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${supabaseKey}`,
      },
      body: JSON.stringify({
        action: 'execute',
        chainKey,
        executorAddress,
        asset: flashAsset,
        amount: flashAmount.toString(),
        params,
        deadline,
        v: sig.v,
        r: sig.r,
        s: sig.s,
        userAddress: userWallet.address,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return { success: false, txHash: null, error: `Relayer error: ${errText.slice(0, 200)}`, gasUsed: null, profitUsd: null, autoFixed: null, gasless: false };
    }

    const result = await response.json();
    if (result.success) {
      return {
        success: true, txHash: result.txHash, error: null,
        gasUsed: result.gasUsed, profitUsd: opp.netProfit,
        autoFixed: null, gasless: true,
      };
    } else {
      return {
        success: false, txHash: result.txHash || null,
        error: result.error, gasUsed: result.gasUsed || null,
        profitUsd: null, autoFixed: result.autoFixed || null, gasless: true,
      };
    }
  } catch (err: any) {
    return { success: false, txHash: null, error: err.message, gasUsed: null, profitUsd: null, autoFixed: null, gasless: false };
  }
}

/**
 * Get on-chain treasury balances.
 */
export async function getOnChainTreasury(
  provider: ethers.JsonRpcProvider,
  executorAddress: string,
  chainKey: string,
): Promise<{ totalProfit: string; gasReserve: string; tokenBalances: Record<string, string> }> {
  try {
    const chain = CHAINS[chainKey];
    const executor = new ethers.Contract(executorAddress, EXECUTOR_ABI, provider);
    const [totalProfit, gasReserve] = await Promise.all([
      executor.totalProfit().catch(() => 0n),
      executor.gasReserve().catch(() => 0n),
    ]);
    const tokenBalances: Record<string, string> = {};
    for (const [symbol, token] of Object.entries(chain.tokens)) {
      try {
        const balance = await executor.getBalance(token.address);
        tokenBalances[symbol] = ethers.formatUnits(balance, token.decimals);
      } catch { tokenBalances[symbol] = '0.0'; }
    }
    return { totalProfit: ethers.formatEther(totalProfit), gasReserve: ethers.formatEther(gasReserve), tokenBalances };
  } catch { return { totalProfit: '0.0', gasReserve: '0.0', tokenBalances: {} }; }
}
