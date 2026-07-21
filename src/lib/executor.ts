/**
 * Flash Loan Execution Engine
 *
 * Deploys the FlashArbExecutor contract and executes arbitrage opportunities
 * using Balancer V2 zero-fee flash loans. Handles gas estimation, nonce
 * management, error recovery, and auto-fixing of common issues.
 *
 * The contract self-funds gas by allocating 10% of profit to a gas reserve,
 * which can be converted to native token and sent to the owner wallet.
 */

import { ethers } from 'ethers';
import { CHAINS } from './chains';
import { ArbitrageOpportunity } from './scanner';

// FlashArbExecutor ABI — Balancer V2 zero-fee flash loan version
export const EXECUTOR_ABI = [
  'function executeArb(address asset, uint256 amount, bytes params) external',
  'function receiveFlashLoan(address[] tokens, uint256[] amounts, uint256[] feeAmounts, bytes userData) external',
  'function owner() view returns (address)',
  'function balancerVault() view returns (address)',
  'function totalProfit() view returns (uint256)',
  'function gasReserve() view returns (uint256)',
  'function v2Routers(string) view returns (address)',
  'function v3Router() view returns (address)',
  'function setV2Router(string name, address router) external',
  'function setV3Router(address router) external',
  'function setBalancerVault(address vault) external',
  'function useGasReserve(address wrappedNative, uint256 amount) external',
  'function withdrawProfit(address token, address to) external',
  'function withdrawToken(address token, address to, uint256 amount) external',
  'function getBalance(address token) view returns (uint256)',
  'event ArbExecuted(address indexed asset, uint256 amountBorrowed, uint256 amountReturned, uint256 profit, uint256 gasReserveAfter)',
  'event ArbFailed(string reason)',
  'event GasReserveUsed(uint256 amount, address indexed to)',
];

export interface ExecutionResult {
  success: boolean;
  txHash: string | null;
  error: string | null;
  gasUsed: number | null;
  profitUsd: number | null;
  autoFixed: string | null;
}

export interface DeploymentResult {
  success: boolean;
  contractAddress: string | null;
  error: string | null;
  txHash: string | null;
}

// Compiled contract bytecode is loaded from the bin.txt file
// (compiled with solcjs 0.8.20)
import executorBytecode from './FlashArbExecutor.bin.txt?raw';

/**
 * Deploy the FlashArbExecutor contract on a chain.
 * Uses Balancer V2 Vault (zero-fee flash loans).
 * Requires the wallet to have a small amount of native token for gas.
 */
export async function deployExecutor(
  signer: ethers.Wallet,
  chainKey: string
): Promise<DeploymentResult> {
  const chain = CHAINS[chainKey];
  if (!chain) return { success: false, contractAddress: null, error: 'Unknown chain', txHash: null };

  try {
    // Check balance
    const balance = await signer.provider!.getBalance(signer.address);
    const minBalance = ethers.parseEther('0.001');

    if (balance < minBalance) {
      return {
        success: false,
        contractAddress: null,
        error: `Insufficient balance for gas. Need at least 0.001 ${chain.nativeTokenSymbol}, have ${ethers.formatEther(balance)} ${chain.nativeTokenSymbol}. Send ${chain.nativeTokenSymbol} to ${signer.address} on ${chain.name}.`,
        txHash: null,
      };
    }

    // Get the V3 router address (Uniswap V3 is on all chains)
    const v3Dex = chain.dexes.find(d => d.type === 'uniswap_v3');
    const v3Router = v3Dex?.router || ethers.ZeroAddress;

    // Constructor args: balancerVault, v3Router
    const factory = new ethers.ContractFactory(
      EXECUTOR_ABI,
      executorBytecode,
      signer
    );

    const contract = await factory.deploy(chain.balancerVault, v3Router, {
      gasLimit: 3000000n,
    });

    await contract.waitForDeployment();
    const address = await contract.getAddress();

    // Auto-configure DEX routers on the deployed contract
    const executor = new ethers.Contract(address, EXECUTOR_ABI, signer);
    for (const dex of chain.dexes) {
      if (dex.type === 'uniswap_v2' || dex.type === 'algebra') {
        try {
          const tx = await executor.setV2Router(dex.name, dex.router);
          await tx.wait();
        } catch {
          // Non-fatal: auto-fix will retry later
        }
      }
    }

    return {
      success: true,
      contractAddress: address,
      error: null,
      txHash: contract.deploymentTransaction()?.hash || null,
    };
  } catch (err: any) {
    return {
      success: false,
      contractAddress: null,
      error: err.message,
      txHash: null,
    };
  }
}

/**
 * Prepare the encoded parameters for an arbitrage execution.
 * Encodes the ArbParams struct: { string[] dexNames, address[] tokenPath, uint24[] v3Fees }
 */
export function encodeArbParams(opp: ArbitrageOpportunity): string {
  const chain = CHAINS[opp.chain];
  if (!chain) return '0x';

  const dexNames = opp.dexPath;
  const tokenPath = opp.tokenAddresses;
  const v3Fees: number[] = [];

  for (let i = 0; i < opp.dexPath.length; i++) {
    const dex = chain.dexes.find(d => opp.dexPath[i].startsWith(d.name));
    if (dex?.type === 'uniswap_v3') {
      const feeMatch = opp.dexPath[i].match(/(\d+\.?\d*)%/);
      v3Fees.push(feeMatch ? Math.round(parseFloat(feeMatch[1]) * 10000) : 3000);
    } else {
      v3Fees.push(0);
    }
  }

  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  return abiCoder.encode(
    ['string[]', 'address[]', 'uint24[]'],
    [dexNames, tokenPath, v3Fees]
  );
}

/**
 * Execute an arbitrage opportunity using a Balancer V2 zero-fee flash loan.
 */
export async function executeArbitrage(
  signer: ethers.Wallet,
  chainKey: string,
  opp: ArbitrageOpportunity,
  executorAddress: string
): Promise<ExecutionResult> {
  const chain = CHAINS[chainKey];
  if (!chain) return { success: false, txHash: null, error: 'Unknown chain', gasUsed: null, profitUsd: null, autoFixed: null };

  try {
    const balance = await signer.provider!.getBalance(signer.address);
    if (balance === 0n) {
      // Check if the contract has gas reserve we can use
      const executor = new ethers.Contract(executorAddress, EXECUTOR_ABI, signer);
      const gasReserve = await executor.gasReserve();
      if (gasReserve > 0n) {
        try {
          const wrappedNative = chain.tokens.WETH || chain.tokens.WMATIC;
          const unwrapTx = await executor.useGasReserve(wrappedNative.address, gasReserve / 2n);
          await unwrapTx.wait();
          // Re-check balance
          const newBalance = await signer.provider!.getBalance(signer.address);
          if (newBalance > 0n) {
            pushAutoFix('Self-funded gas from contract reserve');
          } else {
            return {
              success: false,
              txHash: null,
              error: `Wallet has 0 ${chain.nativeTokenSymbol}. Gas reserve was insufficient.`,
              gasUsed: null, profitUsd: null, autoFixed: null,
            };
          }
        } catch {
          return {
            success: false,
            txHash: null,
            error: `Wallet has 0 ${chain.nativeTokenSymbol} and gas reserve unwrap failed.`,
            gasUsed: null, profitUsd: null, autoFixed: null,
          };
        }
      } else {
        return {
          success: false,
          txHash: null,
          error: `Wallet has 0 ${chain.nativeTokenSymbol}. Send ${chain.nativeTokenSymbol} to ${signer.address} on ${chain.name} to pay for gas.`,
          gasUsed: null, profitUsd: null, autoFixed: null,
        };
      }
    }

    const executor = new ethers.Contract(executorAddress, EXECUTOR_ABI, signer);
    const params = encodeArbParams(opp);

    const flashAsset = opp.flashLoanAsset;
    const token = chain.tokens[Object.keys(chain.tokens).find(k => chain.tokens[k].address === flashAsset) || ''];
    const decimals = token?.decimals || 18;
    const flashAmount = ethers.parseUnits(opp.flashLoanAmount.toString(), decimals);

    // Estimate gas
    let gasEstimate: bigint;
    try {
      gasEstimate = await executor.executeArb.estimateGas(flashAsset, flashAmount, params);
    } catch (gasErr: any) {
      // Auto-fix: try reconfiguring routers
      const fixResult = await autoFixConfig(signer, chainKey, executorAddress);
      if (fixResult.fixed.length > 0) {
        try {
          gasEstimate = await executor.executeArb.estimateGas(flashAsset, flashAmount, params);
        } catch {
          return {
            success: false, txHash: null,
            error: `Gas estimation failed after auto-fix: ${gasErr.message}. Route may be invalid or front-run.`,
            gasUsed: null, profitUsd: null,
            autoFixed: fixResult.fixed.join('; '),
          };
        }
      } else {
        return {
          success: false, txHash: null,
          error: `Gas estimation failed: ${gasErr.message}. Opportunity may be front-run or route invalid.`,
          gasUsed: null, profitUsd: null, autoFixed: null,
        };
      }
    }

    // Get gas price from live network data
    const feeData = await signer.provider!.getFeeData();
    const gasPrice = feeData.gasPrice || ethers.parseUnits('30', 'gwei');

    // Skip if gas too high
    const maxGasGwei = 100;
    if (chainKey === 'polygon' && Number(ethers.formatUnits(gasPrice, 'gwei')) > maxGasGwei) {
      return {
        success: false, txHash: null,
        error: `Gas price too high: ${ethers.formatUnits(gasPrice, 'gwei')} gwei (max: ${maxGasGwei}).`,
        gasUsed: null, profitUsd: null,
        autoFixed: 'Skipped execution due to high gas price. Will retry when gas drops.',
      };
    }

    // Send the transaction
    const tx = await executor.executeArb(flashAsset, flashAmount, params, {
      gasLimit: gasEstimate * 13n / 10n,
      gasPrice,
    });

    const receipt = await tx.wait();

    if (receipt && receipt.status === 1) {
      return {
        success: true, txHash: receipt.hash, error: null,
        gasUsed: Number(receipt.gasUsed),
        profitUsd: opp.netProfit, autoFixed: null,
      };
    } else {
      return {
        success: false, txHash: receipt?.hash || null,
        error: 'Transaction reverted. Opportunity may have been front-run.',
        gasUsed: receipt ? Number(receipt.gasUsed) : null,
        profitUsd: null, autoFixed: null,
      };
    }
  } catch (err: any) {
    let autoFixed: string | null = null;
    let errorMsg = err.message || 'Unknown error';

    if (errorMsg.includes('insufficient funds') || errorMsg.includes('gas')) {
      autoFixed = 'Insufficient gas funds detected. Contract gas reserve will be used on next attempt.';
    }
    if (errorMsg.includes('nonce')) {
      autoFixed = 'Nonce issue detected. Transaction will retry with corrected nonce.';
    }
    if (errorMsg.includes('network') || errorMsg.includes('timeout') || errorMsg.includes('fetch')) {
      autoFixed = 'Network error. Retrying with alternative RPC endpoint.';
    }

    return {
      success: false, txHash: null, error: errorMsg,
      gasUsed: null, profitUsd: null, autoFixed,
    };
  }
}

// Helper to track auto-fixes for UI feedback
let _lastAutoFix: string | null = null;
function pushAutoFix(msg: string) { _lastAutoFix = msg; }
export function getLastAutoFix(): string | null { return _lastAutoFix; }

/**
 * Withdraw profits from the executor contract to the wallet.
 */
export async function withdrawProfit(
  signer: ethers.Wallet,
  executorAddress: string,
  tokenAddress: string,
  toAddress: string
): Promise<ExecutionResult> {
  try {
    const executor = new ethers.Contract(executorAddress, EXECUTOR_ABI, signer);
    const tx = await executor.withdrawProfit(tokenAddress, toAddress);
    const receipt = await tx.wait();

    return {
      success: receipt?.status === 1, txHash: receipt?.hash || null,
      error: receipt?.status === 1 ? null : 'Withdrawal reverted',
      gasUsed: receipt ? Number(receipt.gasUsed) : null,
      profitUsd: null, autoFixed: null,
    };
  } catch (err: any) {
    return {
      success: false, txHash: null, error: err.message,
      gasUsed: null, profitUsd: null, autoFixed: null,
    };
  }
}

/**
 * Check the health of an executor contract.
 */
export async function checkExecutorHealth(
  provider: ethers.JsonRpcProvider,
  executorAddress: string
): Promise<{ healthy: boolean; issues: string[]; autoFixes: string[] }> {
  const issues: string[] = [];
  const autoFixes: string[] = [];

  try {
    const executor = new ethers.Contract(executorAddress, EXECUTOR_ABI, provider);

    const code = await provider.getCode(executorAddress);
    if (code === '0x') {
      issues.push('Contract not deployed at this address');
      return { healthy: false, issues, autoFixes };
    }

    const owner = await executor.owner().catch(() => ethers.ZeroAddress);
    const vault = await executor.balancerVault().catch(() => ethers.ZeroAddress);
    const profit = await executor.totalProfit().catch(() => 0n);
    const gasReserve = await executor.gasReserve().catch(() => 0n);

    if (vault === ethers.ZeroAddress) {
      issues.push('Balancer V2 Vault not configured');
      autoFixes.push('Set Balancer V2 Vault address');
    }

    return { healthy: issues.length === 0, issues, autoFixes };
  } catch (err: any) {
    issues.push(`Contract interaction failed: ${err.message}`);
    return { healthy: false, issues, autoFixes };
  }
}

/**
 * Auto-fix common configuration issues.
 * Re-sets DEX routers and Balancer Vault on the contract.
 */
export async function autoFixConfig(
  signer: ethers.Wallet,
  chainKey: string,
  executorAddress: string
): Promise<{ fixed: string[]; errors: string[] }> {
  const fixed: string[] = [];
  const errors: string[] = [];
  const chain = CHAINS[chainKey];

  try {
    const executor = new ethers.Contract(executorAddress, EXECUTOR_ABI, signer);

    // Fix: Set Balancer V2 Vault
    try {
      const currentVault = await executor.balancerVault();
      if (currentVault !== chain.balancerVault) {
        const tx = await executor.setBalancerVault(chain.balancerVault);
        await tx.wait();
        fixed.push(`Set Balancer V2 Vault to ${chain.balancerVault}`);
      }
    } catch (err: any) {
      errors.push(`Failed to set Balancer Vault: ${err.message}`);
    }

    // Fix: Set V2 routers
    for (const dex of chain.dexes) {
      if (dex.type === 'uniswap_v2' || dex.type === 'algebra') {
        try {
          const currentRouter = await executor.v2Routers(dex.name);
          if (currentRouter === ethers.ZeroAddress || currentRouter.toLowerCase() !== dex.router.toLowerCase()) {
            const tx = await executor.setV2Router(dex.name, dex.router);
            await tx.wait();
            fixed.push(`Set ${dex.name} router to ${dex.router}`);
          }
        } catch (err: any) {
          errors.push(`Failed to set ${dex.name} router: ${err.message}`);
        }
      }
    }

    // Fix: Set V3 router
    const v3Dex = chain.dexes.find(d => d.type === 'uniswap_v3');
    if (v3Dex) {
      try {
        const currentV3 = await executor.v3Router();
        if (currentV3 === ethers.ZeroAddress || currentV3.toLowerCase() !== v3Dex.router.toLowerCase()) {
          const tx = await executor.setV3Router(v3Dex.router);
          await tx.wait();
          fixed.push(`Set V3 router to ${v3Dex.router}`);
        }
      } catch (err: any) {
        errors.push(`Failed to set V3 router: ${err.message}`);
      }
    }
  } catch (err: any) {
    errors.push(`Auto-fix failed: ${err.message}`);
  }

  return { fixed, errors };
}

/**
 * Get on-chain treasury balances from the executor contract.
 */
export async function getOnChainTreasury(
  provider: ethers.JsonRpcProvider,
  executorAddress: string,
  chainKey: string
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
      } catch {
        tokenBalances[symbol] = '0.0';
      }
    }

    return {
      totalProfit: ethers.formatEther(totalProfit),
      gasReserve: ethers.formatEther(gasReserve),
      tokenBalances,
    };
  } catch {
    return { totalProfit: '0.0', gasReserve: '0.0', tokenBalances: {} };
  }
}
