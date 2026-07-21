/**
 * Gasless execution engine via Gelato Relay.
 *
 * Zero-gas architecture:
 * 1. User signs EIP-712 message in browser (free, off-chain)
 * 2. Edge function sends to Gelato Relay API (sponsoredCallERC2771)
 * 3. Gelato pays gas, submits tx on-chain
 * 4. Contract pays Gelato fee from flash loan profit in USDC
 * 5. 10% of profit auto-deposited to Gelato Gas Tank for future gas
 *
 * The first arb earns the USDC that funds ALL subsequent gas.
 * Zero upfront capital required from anyone.
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
  'function setGelatoRelayer(address _relayer) external',
  'function setFeeToken(address _feeToken) external',
  'function setGelatoFeeCollector(address _collector) external',
  'function owner() view returns (address)',
  'function gelatoRelayer() view returns (address)',
  'function totalProfit() view returns (uint256)',
  'function totalGasFeesPaid() view returns (uint256)',
  'function gasReserve() view returns (uint256)',
  'function nonces(address) view returns (uint256)',
  'function replenishGasTank(address to, uint256 amount) external',
  'function withdrawProfit(address token, address to) external',
  'function getBalance(address token) view returns (uint256)',
  'event ArbExecuted(address indexed asset, uint256 borrowed, uint256 profit, uint256 toOwner, uint256 toGelato, uint256 toReserve, uint8 provider)',
  'event GasFeePaid(uint256 fee, address indexed feeToken)',
];

export interface ExecutionResult {
  success: boolean; txHash: string | null; error: string | null;
  gasUsed: number | null; profitUsd: number | null;
  autoFixed: string | null; gasless: boolean;
}

export interface DeploymentResult {
  success: boolean; contractAddress: string | null;
  error: string | null; txHash: string | null; gasless: boolean;
}

export async function deployExecutorGasless(
  userWallet: ethers.Wallet, chainKey: string,
): Promise<DeploymentResult> {
  const chain = CHAINS[chainKey];
  if (!chain) return { success: false, contractAddress: null, error: 'Unknown chain', txHash: null, gasless: false };

  try {
    const v3Dex = chain.dexes.find(d => d.type === 'uniswap_v3');
    const v3Router = v3Dex?.router || ethers.ZeroAddress;
    const usdc = chain.tokens.USDC;

    const response = await fetch(`${supabaseUrl}/functions/v1/relayer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${supabaseKey}` },
      body: JSON.stringify({
        action: 'deploy',
        chainKey,
        userAddress: userWallet.address,
        balancerVault: chain.balancerVault,
        v3Router,
        feeToken: usdc.address,
        gelatoFeeCollector: chain.gelatoFeeCollector,
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
    return result.success
      ? { success: true, contractAddress: result.contractAddress, error: null, txHash: result.txHash, gasless: true }
      : { success: false, contractAddress: null, error: result.error, txHash: null, gasless: false };
  } catch (err: any) {
    return { success: false, contractAddress: null, error: err.message, txHash: null, gasless: false };
  }
}

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

export async function executeArbitrageGasless(
  userWallet: ethers.Wallet, chainKey: string,
  opp: ArbitrageOpportunity, executorAddress: string,
  dodoPoolAddress: string | null,
): Promise<ExecutionResult> {
  const chain = CHAINS[chainKey];
  if (!chain) return { success: false, txHash: null, error: 'Unknown chain', gasUsed: null, profitUsd: null, autoFixed: null, gasless: false };

  try {
    const provider = new ethers.JsonRpcProvider(chain.rpc[0]);
    const executor = new ethers.Contract(executorAddress, EXECUTOR_ABI, provider);
    const currentNonce = await executor.nonces(userWallet.address).catch(() => 0n);
    const deadline = Math.floor(Date.now() / 1000) + 600;

    const flashAsset = opp.flashLoanAsset;
    const token = Object.values(chain.tokens).find(t => t.address === flashAsset);
    const decimals = token?.decimals || 18;
    const flashAmount = ethers.parseUnits(opp.flashLoanAmount.toString(), decimals);
    const params = encodeArbParams(opp, dodoPoolAddress);

    const domain = { name: 'FlashArbExecutor', version: '1', chainId: chain.id, verifyingContract: executorAddress };
    const types = {
      ExecuteArb: [
        { name: 'asset', type: 'address' }, { name: 'amount', type: 'uint256' },
        { name: 'params', type: 'bytes' }, { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    };
    const value = { asset: flashAsset, amount: flashAmount, params, nonce: currentNonce, deadline };
    const signature = await userWallet.signTypedData(domain, types, value);
    const sig = ethers.Signature.from(signature);

    const response = await fetch(`${supabaseUrl}/functions/v1/relayer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${supabaseKey}` },
      body: JSON.stringify({
        action: 'execute',
        chainKey,
        executorAddress,
        asset: flashAsset,
        amount: flashAmount.toString(),
        params,
        deadline,
        v: sig.v, r: sig.r, s: sig.s,
        userAddress: userWallet.address,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return { success: false, txHash: null, error: `Relayer error: ${errText.slice(0, 200)}`, gasUsed: null, profitUsd: null, autoFixed: null, gasless: false };
    }

    const result = await response.json();
    return result.success
      ? { success: true, txHash: result.txHash, error: null, gasUsed: result.gasUsed, profitUsd: opp.netProfit, autoFixed: null, gasless: true }
      : { success: false, txHash: result.txHash || null, error: result.error, gasUsed: result.gasUsed || null, profitUsd: null, autoFixed: result.autoFixed || null, gasless: true };
  } catch (err: any) {
    return { success: false, txHash: null, error: err.message, gasUsed: null, profitUsd: null, autoFixed: null, gasless: false };
  }
}

export async function getOnChainTreasury(
  provider: ethers.JsonRpcProvider, executorAddress: string, chainKey: string,
): Promise<{ totalProfit: string; gasReserve: string; totalGasFeesPaid: string }> {
  try {
    const executor = new ethers.Contract(executorAddress, EXECUTOR_ABI, provider);
    const [totalProfit, gasReserve, totalGasFeesPaid] = await Promise.all([
      executor.totalProfit().catch(() => 0n),
      executor.gasReserve().catch(() => 0n),
      executor.totalGasFeesPaid().catch(() => 0n),
    ]);
    return {
      totalProfit: ethers.formatEther(totalProfit),
      gasReserve: ethers.formatEther(gasReserve),
      totalGasFeesPaid: ethers.formatEther(totalGasFeesPaid),
    };
  } catch { return { totalProfit: '0.0', gasReserve: '0.0', totalGasFeesPaid: '0.0' }; }
}
