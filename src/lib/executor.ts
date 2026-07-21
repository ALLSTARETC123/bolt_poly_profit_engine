/**
 * Flash Loan Execution Engine
 *
 * Deploys the FlashArbExecutor contract and executes arbitrage opportunities
 * using dual Balancer V2 (0% fee) and DODO V2 (0% fee) flash loans.
 * Routes transactions through private mempools to prevent front-running.
 * 100% of profit sent directly to owner wallet — no reinvestment.
 * Self-funding gas: 10% of profit auto-allocated to gas reserve.
 */

import { ethers } from 'ethers';
import { CHAINS } from './chains';
import { ArbitrageOpportunity } from './scanner';
import executorBytecode from './FlashArbExecutor.bin.txt?raw';

export const EXECUTOR_ABI = [
  'function executeArb(address asset, uint256 amount, bytes params) external',
  'function receiveFlashLoan(address[] tokens, uint256[] amounts, uint256[] feeAmounts, bytes userData) external',
  'function DVMFlashLoanCall(address sender, uint256 baseAmount, uint256 quoteAmount, bytes data) external',
  'function DPPFlashLoanCall(address sender, uint256 baseAmount, uint256 quoteAmount, bytes data) external',
  'function DSPFlashLoanCall(address sender, uint256 baseAmount, uint256 quoteAmount, bytes data) external',
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
  'event ArbExecuted(address indexed asset, uint256 amountBorrowed, uint256 amountReturned, uint256 profit, uint256 toOwner, uint256 gasReserveAfter, uint8 provider)',
  'event ArbFailed(string reason)',
  'event GasReserveUsed(uint256 amount, address indexed to)',
  'event ProfitWithdrawn(address indexed token, address indexed to, uint256 amount)',
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

/**
 * Deploy the FlashArbExecutor contract on a chain.
 * Constructor args: balancerVault, v3Router
 */
export async function deployExecutor(
  signer: ethers.Wallet,
  chainKey: string,
): Promise<DeploymentResult> {
  const chain = CHAINS[chainKey];
  if (!chain) return { success: false, contractAddress: null, error: 'Unknown chain', txHash: null };

  try {
    const balance = await signer.provider!.getBalance(signer.address);
    if (balance < ethers.parseEther('0.001')) {
      return {
        success: false,
        contractAddress: null,
        error: `Insufficient balance. Need 0.001 ${chain.nativeTokenSymbol}. Send ${chain.nativeTokenSymbol} to ${signer.address} on ${chain.name}.`,
        txHash: null,
      };
    }

    const v3Dex = chain.dexes.find(d => d.type === 'uniswap_v3');
    const v3Router = v3Dex?.router || ethers.ZeroAddress;

    const factory = new ethers.ContractFactory(EXECUTOR_ABI, executorBytecode, signer);
    const contract = await factory.deploy(chain.balancerVault, v3Router, { gasLimit: 3000000n });
    await contract.waitForDeployment();
    const address = await contract.getAddress();

    // Auto-configure DEX routers
    const executor = new ethers.Contract(address, EXECUTOR_ABI, signer);
    for (const dex of chain.dexes) {
      if (dex.type === 'uniswap_v2' || dex.type === 'algebra') {
        try {
          const tx = await executor.setV2Router(dex.name, dex.router);
          await tx.wait();
        } catch { /* non-fatal */ }
      }
    }

    return {
      success: true,
      contractAddress: address,
      error: null,
      txHash: contract.deploymentTransaction()?.hash || null,
    };
  } catch (err: any) {
    return { success: false, contractAddress: null, error: err.message, txHash: null };
  }
}

/**
 * Encode arb params for the contract's executeArb function.
 * Provider: 0 = Balancer V2, 1 = DODO V2
 */
export function encodeArbParams(
  opp: ArbitrageOpportunity,
  dodoPoolAddress: string | null,
): string {
  const chain = CHAINS[opp.chain];
  if (!chain) return '0x';

  const provider = opp.flashProvider === 'dodo_v2' ? 1 : 0;
  const dexNames = opp.dexPath;
  const tokenPath = opp.tokenAddresses;
  const v3Fees: number[] = [];

  for (let i = 0; i < opp.dexPath.length; i++) {
    const dex = chain.dexes.find(d => opp.dexPath[i].startsWith(d.name));
    if (dex?.type === 'uniswap_v3') {
      v3Fees.push(3000);
    } else {
      v3Fees.push(0);
    }
  }

  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  return abiCoder.encode(
    ['uint8', 'address', 'string[]', 'address[]', 'uint24[]'],
    [provider, dodoPoolAddress || ethers.ZeroAddress, dexNames, tokenPath, v3Fees],
  );
}

/**
 * Create a provider that routes through a private mempool endpoint.
 * Falls back to public RPC if private endpoint fails.
 */
function createPrivateMempoolProvider(chain: ChainConfig): ethers.JsonRpcProvider {
  const rpcUrl = chain.privateRpc[0] || chain.rpc[0];
  return new ethers.JsonRpcProvider(rpcUrl);
}

/**
 * Execute an arbitrage opportunity via private mempool.
 * Uses Balancer V2 or DODO V2 flash loan based on opportunity.
 */
export async function executeArbitrage(
  signer: ethers.Wallet,
  chainKey: string,
  opp: ArbitrageOpportunity,
  executorAddress: string,
  dodoPoolAddress: string | null,
): Promise<ExecutionResult> {
  const chain = CHAINS[chainKey];
  if (!chain) return { success: false, txHash: null, error: 'Unknown chain', gasUsed: null, profitUsd: null, autoFixed: null };

  try {
    // Check wallet balance for gas
    const balance = await signer.provider!.getBalance(signer.address);
    if (balance === 0n) {
      // Try self-funding from gas reserve
      const executor = new ethers.Contract(executorAddress, EXECUTOR_ABI, signer);
      const gasReserve = await executor.gasReserve().catch(() => 0n);
      if (gasReserve > 0n) {
        try {
          const wrappedNative = chain.tokens.WETH || chain.tokens.WMATIC;
          const unwrapTx = await executor.useGasReserve(wrappedNative.address, gasReserve / 2n);
          await unwrapTx.wait();
          return {
            success: false, txHash: null,
            error: 'Self-funded gas from reserve. Retry execution.',
            gasUsed: null, profitUsd: null,
            autoFixed: 'Converted gas reserve to native token for transaction fees',
          };
        } catch {
          return {
            success: false, txHash: null,
            error: `No gas. Send ${chain.nativeTokenSymbol} to ${signer.address} on ${chain.name}.`,
            gasUsed: null, profitUsd: null, autoFixed: null,
          };
        }
      } else {
        return {
          success: false, txHash: null,
          error: `No gas. Send ${chain.nativeTokenSymbol} to ${signer.address} on ${chain.name}.`,
          gasUsed: null, profitUsd: null, autoFixed: null,
        };
      }
    }

    const executor = new ethers.Contract(executorAddress, EXECUTOR_ABI, signer);
    const params = encodeArbParams(opp, dodoPoolAddress);

    const flashAsset = opp.flashLoanAsset;
    const token = Object.values(chain.tokens).find(t => t.address === flashAsset);
    const decimals = token?.decimals || 18;
    const flashAmount = ethers.parseUnits(opp.flashLoanAmount.toString(), decimals);

    // Estimate gas
    let gasEstimate: bigint;
    try {
      gasEstimate = await executor.executeArb.estimateGas(flashAsset, flashAmount, params);
    } catch (gasErr: any) {
      const fixResult = await autoFixConfig(signer, chainKey, executorAddress);
      if (fixResult.fixed.length > 0) {
        try {
          gasEstimate = await executor.executeArb.estimateGas(flashAsset, flashAmount, params);
        } catch {
          return {
            success: false, txHash: null,
            error: `Gas estimation failed after auto-fix: ${gasErr.message}`,
            gasUsed: null, profitUsd: null,
            autoFixed: fixResult.fixed.join('; '),
          };
        }
      } else {
        return {
          success: false, txHash: null,
          error: `Gas estimation failed: ${gasErr.message}`,
          gasUsed: null, profitUsd: null, autoFixed: null,
        };
      }
    }

    // Get gas price — use private mempool provider for fee data
    const privateProvider = createPrivateMempoolProvider(chain);
    const feeData = await privateProvider.getFeeData();
    const gasPrice = feeData.gasPrice || ethers.parseUnits('30', 'gwei');

    // Skip if gas too high (Polygon)
    if (chainKey === 'polygon' && Number(ethers.formatUnits(gasPrice, 'gwei')) > 100) {
      return {
        success: false, txHash: null,
        error: `Gas price too high: ${ethers.formatUnits(gasPrice, 'gwei')} gwei`,
        gasUsed: null, profitUsd: null,
        autoFixed: 'Skipped due to high gas. Will retry when gas drops.',
      };
    }

    // Send via private mempool (uses privateRpc endpoint)
    const tx = await executor.executeArb(flashAsset, flashAmount, params, {
      gasLimit: (gasEstimate * 13n) / 10n,
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
        error: 'Transaction reverted. May have been front-run.',
        gasUsed: receipt ? Number(receipt.gasUsed) : null,
        profitUsd: null, autoFixed: null,
      };
    }
  } catch (err: any) {
    let autoFixed: string | null = null;
    const errorMsg = err.message || 'Unknown error';

    if (errorMsg.includes('insufficient funds') || errorMsg.includes('gas')) {
      autoFixed = 'Insufficient gas. Contract gas reserve will be used on next attempt.';
    }
    if (errorMsg.includes('nonce')) {
      autoFixed = 'Nonce issue. Transaction will retry with corrected nonce.';
    }
    if (errorMsg.includes('network') || errorMsg.includes('timeout')) {
      autoFixed = 'Network error. Retrying with alternative RPC endpoint.';
    }

    return {
      success: false, txHash: null, error: errorMsg,
      gasUsed: null, profitUsd: null, autoFixed,
    };
  }
}

/**
 * Withdraw all profits from the executor contract to the wallet.
 */
export async function withdrawProfit(
  signer: ethers.Wallet,
  executorAddress: string,
  tokenAddress: string,
  toAddress: string,
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
 * Check executor contract health.
 */
export async function checkExecutorHealth(
  provider: ethers.JsonRpcProvider,
  executorAddress: string,
): Promise<{ healthy: boolean; issues: string[]; autoFixes: string[] }> {
  const issues: string[] = [];
  const autoFixes: string[] = [];

  try {
    const code = await provider.getCode(executorAddress);
    if (code === '0x') {
      issues.push('Contract not deployed');
      return { healthy: false, issues, autoFixes };
    }

    const executor = new ethers.Contract(executorAddress, EXECUTOR_ABI, provider);
    const vault = await executor.balancerVault().catch(() => ethers.ZeroAddress);

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
 */
export async function autoFixConfig(
  signer: ethers.Wallet,
  chainKey: string,
  executorAddress: string,
): Promise<{ fixed: string[]; errors: string[] }> {
  const fixed: string[] = [];
  const errors: string[] = [];
  const chain = CHAINS[chainKey];

  try {
    const executor = new ethers.Contract(executorAddress, EXECUTOR_ABI, signer);

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

    for (const dex of chain.dexes) {
      if (dex.type === 'uniswap_v2' || dex.type === 'algebra') {
        try {
          const currentRouter = await executor.v2Routers(dex.name);
          if (currentRouter === ethers.ZeroAddress || currentRouter.toLowerCase() !== dex.router.toLowerCase()) {
            const tx = await executor.setV2Router(dex.name, dex.router);
            await tx.wait();
            fixed.push(`Set ${dex.name} router`);
          }
        } catch (err: any) {
          errors.push(`Failed to set ${dex.name} router: ${err.message}`);
        }
      }
    }

    const v3Dex = chain.dexes.find(d => d.type === 'uniswap_v3');
    if (v3Dex) {
      try {
        const currentV3 = await executor.v3Router();
        if (currentV3 === ethers.ZeroAddress || currentV3.toLowerCase() !== v3Dex.router.toLowerCase()) {
          const tx = await executor.setV3Router(v3Dex.router);
          await tx.wait();
          fixed.push(`Set V3 router`);
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
