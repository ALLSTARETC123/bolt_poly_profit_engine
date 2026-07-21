/**
 * Relayer Edge Function — Zero-gas transaction relay via Gelato Network.
 *
 * Architecture:
 * - Gelato Gas Tank holds USDC (deposited once, covers gas on ALL chains)
 * - User signs EIP-712 message off-chain (free)
 * - This function calls Gelato's sponsoredCallERC2771 API
 * - Gelato submits the transaction on-chain and charges the Gas Tank
 * - The contract pays Gelato's fee from flash loan profit (5% of profit)
 * - 10% of profit auto-deposits to Gas Tank, making the system self-sustaining
 *
 * Zero upfront capital: The first profitable arb generates the USDC that funds
 * all subsequent gas. The Gas Tank starts at $0 and is replenished by the contract.
 *
 * Fallback: If Gelato API key isn't configured, falls back to direct relay
 * using a relayer wallet (RELAYER_PRIVATE_KEY).
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { ethers } from "npm:ethers@6.13.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const GELATO_API_KEY = Deno.env.get("GELATO_API_KEY") || "";
const RELAYER_PRIVATE_KEY = Deno.env.get("RELAYER_PRIVATE_KEY") || "";

const CHAIN_RPCS: Record<string, string> = {
  polygon: "https://polygon-bor-rpc.publicnode.com",
  arbitrum: "https://arbitrum-one-rpc.publicnode.com",
  optimism: "https://optimism-rpc.publicnode.com",
};

const GELATO_CHAIN_IDS: Record<string, number> = {
  polygon: 137,
  arbitrum: 42161,
  optimism: 10,
};

const EXECUTOR_ABI = [
  'function executeArbWithSig(address asset, uint256 amount, bytes params, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external',
  'function initializeOwner(address _owner) external',
  'function setV2Router(string name, address router) external',
  'function setV3Router(address router) external',
  'function setGelatoRelayer(address _relayer) external',
  'function owner() view returns (address)',
  'function relayer() view returns (address)',
  'function nonces(address) view returns (uint256)',
  'event ArbExecuted(address indexed asset, uint256 borrowed, uint256 profit, uint256 toOwner, uint256 toGelato, uint256 toReserve, uint8 provider)',
];

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { action } = body;

    if (action === "health") {
      const gelatoConfigured = !!GELATO_API_KEY;
      const relayerConfigured = !!RELAYER_PRIVATE_KEY;
      let relayerAddress = null;
      let balances: Record<string, string> = {};

      if (relayerConfigured) {
        const relayerWallet = new ethers.Wallet(RELAYER_PRIVATE_KEY);
        relayerAddress = relayerWallet.address;
        for (const [chain, rpc] of Object.entries(CHAIN_RPCS)) {
          try {
            const provider = new ethers.JsonRpcProvider(rpc);
            const balance = await provider.getBalance(relayerWallet.address);
            balances[chain] = ethers.formatEther(balance);
          } catch { balances[chain] = "error"; }
        }
      }

      return new Response(JSON.stringify({
        gelatoConfigured,
        relayerConfigured,
        relayerAddress,
        balances,
        mode: gelatoConfigured ? "gelato" : relayerConfigured ? "direct" : "unconfigured",
        message: gelatoConfigured
          ? "Gelato Gas Tank active — zero native tokens needed"
          : relayerConfigured
          ? "Direct relay active — relayer wallet pays gas"
          : "Set GELATO_API_KEY or RELAYER_PRIVATE_KEY in Supabase secrets",
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const rpcUrl = CHAIN_RPCS[body.chainKey];
    if (!rpcUrl) {
      return new Response(JSON.stringify({ success: false, error: `Unknown chain: ${body.chainKey}` }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const provider = new ethers.JsonRpcProvider(rpcUrl);

    // ── DEPLOY ──────────────────────────────────────────
    if (action === "deploy") {
      const { balancerVault, v3Router, feeToken, gelatoFeeCollector, bytecode, abi, dexConfigs, userAddress } = body;

      // Try Gelato-sponsored deployment first
      if (GELATO_API_KEY) {
        try {
          // Deploy via Gelato: encode the deploy call and send to Gelato's relay API
          // Gelato sponsors the gas from the Gas Tank
          const deployData = encodeDeployData(abi, bytecode, [balancerVault, v3Router, feeToken, gelatoFeeCollector]);

          const gelatoResponse = await fetch("https://relay.gelato.network/callWithSyncFee", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Accept": "application/json" },
            body: JSON.stringify({
              chainId: GELATO_CHAIN_IDS[body.chainKey],
              target: ethers.ZeroAddress, // deploy target
              data: deployData,
              feeToken: feeToken,
              isRelayContext: false,
            }),
          });

          if (gelatoResponse.ok) {
            const gelatoResult = await gelatoResponse.json();
            // Gelato returns a task ID — poll for completion
            const taskId = gelatoResult.taskId || gelatoResult.id;
            if (taskId) {
              const receipt = await pollGelatoTask(taskId);
              if (receipt && receipt.status === 'execSuccess') {
                const contractAddress = receipt.receipt?.contractAddress;
                if (contractAddress) {
                  // Configure the contract via Gelato
                  await configureContractViaGelato(contractAddress, abi, userAddress, dexConfigs, body.chainKey, feeToken);
                  return new Response(JSON.stringify({
                    success: true, contractAddress, txHash: receipt.receipt?.transactionHash,
                    gasless: true, mode: "gelato",
                  }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
                }
              }
            }
          }
        } catch (gelatoErr) {
          console.log("Gelato deploy failed, falling back to direct:", gelatoErr.message);
        }
      }

      // Fallback: direct deployment via relayer wallet
      if (!RELAYER_PRIVATE_KEY) {
        return new Response(JSON.stringify({
          success: false,
          error: "No gas funding available. Set GELATO_API_KEY or RELAYER_PRIVATE_KEY in Supabase secrets.",
        }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const relayerWallet = new ethers.Wallet(RELAYER_PRIVATE_KEY, provider);
      const factory = new ethers.ContractFactory(abi, bytecode, relayerWallet);
      const contract = await factory.deploy(balancerVault, v3Router, feeToken, gelatoFeeCollector, { gasLimit: 3000000n });
      await contract.waitForDeployment();
      const contractAddress = await contract.getAddress();

      // Set user as owner
      const tx1 = await contract.initializeOwner(userAddress);
      await tx1.wait();

      // Set ourselves as the gelato relayer
      const tx2 = await contract.setGelatoRelayer(relayerWallet.address);
      await tx2.wait();

      // Configure DEX routers
      const executor = new ethers.Contract(contractAddress, abi, relayerWallet);
      for (const dex of dexConfigs) {
        if (dex.type === 'uniswap_v2' || dex.type === 'algebra') {
          try { const tx = await executor.setV2Router(dex.name, dex.router); await tx.wait(); } catch (e) { /* non-fatal */ }
        }
      }

      return new Response(JSON.stringify({
        success: true, contractAddress,
        txHash: contract.deploymentTransaction()?.hash,
        gasless: true, mode: "direct",
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── EXECUTE ─────────────────────────────────────────
    if (action === "execute") {
      const { executorAddress, asset, amount, params, deadline, v, r, s } = body;

      // Try Gelato-sponsored execution
      if (GELATO_API_KEY) {
        try {
          const executor = new ethers.Contract(executorAddress, EXECUTOR_ABI, provider);
          const callData = await executor.executeArbWithSig.populateTransaction(
            asset, amount, params, deadline, v, r, s,
          );

          const gelatoResponse = await fetch("https://relay.gelato.network/callWithSyncFeeERC2771", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Accept": "application/json",
              "X-API-KEY": GELATO_API_KEY,
            },
            body: JSON.stringify({
              chainId: GELATO_CHAIN_IDS[body.chainKey],
              target: executorAddress,
              data: callData,
              feeToken: body.feeToken || ethers.ZeroAddress,
              sponsorApiKey: GELATO_API_KEY,
              isRelayContext: true,
            }),
          });

          if (gelatoResponse.ok) {
            const gelatoResult = await gelatoResponse.json();
            const taskId = gelatoResult.taskId || gelatoResult.id;
            if (taskId) {
              const receipt = await pollGelatoTask(taskId);
              if (receipt && receipt.status === 'execSuccess') {
                return new Response(JSON.stringify({
                  success: true,
                  txHash: receipt.receipt?.transactionHash,
                  gasUsed: receipt.receipt?.gasUsed ? Number(receipt.receipt.gasUsed) : null,
                  gasless: true, mode: "gelato",
                }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
              } else {
                return new Response(JSON.stringify({
                  success: false,
                  txHash: receipt?.receipt?.transactionHash || null,
                  error: `Gelato task failed: ${receipt?.status || 'unknown'}`,
                  gasUsed: null, autoFixed: null, gasless: true,
                }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
              }
            }
          }
        } catch (gelatoErr) {
          console.log("Gelato execute failed, falling back to direct:", gelatoErr.message);
        }
      }

      // Fallback: direct relay
      if (!RELAYER_PRIVATE_KEY) {
        return new Response(JSON.stringify({
          success: false,
          error: "No gas funding available. Set GELATO_API_KEY or RELAYER_PRIVATE_KEY.",
        }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const relayerWallet = new ethers.Wallet(RELAYER_PRIVATE_KEY, provider);
      const executor = new ethers.Contract(executorAddress, EXECUTOR_ABI, relayerWallet);

      let gasEstimate: bigint;
      try {
        gasEstimate = await executor.executeArbWithSig.estimateGas(asset, amount, params, deadline, v, r, s);
      } catch (err: any) {
        return new Response(JSON.stringify({
          success: false,
          error: `Gas estimation failed: ${err.message?.slice(0, 200)}`,
          autoFixed: null,
        }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const feeData = await provider.getFeeData();
      const gasPrice = feeData.gasPrice || ethers.parseUnits('30', 'gwei');

      const tx = await executor.executeArbWithSig(asset, amount, params, deadline, v, r, s, {
        gasLimit: (gasEstimate * 13n) / 10n, gasPrice,
      });
      const receipt = await tx.wait();

      if (receipt && receipt.status === 1) {
        return new Response(JSON.stringify({
          success: true, txHash: receipt.hash, gasUsed: Number(receipt.gasUsed),
          gasless: true, mode: "direct",
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      } else {
        return new Response(JSON.stringify({
          success: false, txHash: receipt?.hash || null,
          error: 'Transaction reverted. May have been front-run.',
          gasUsed: receipt ? Number(receipt.gasUsed) : null,
          autoFixed: null, gasless: true,
        }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }

    return new Response(JSON.stringify({ success: false, error: `Unknown action: ${action}` }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (err: any) {
    return new Response(JSON.stringify({ success: false, error: err.message || 'Unknown error' }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});

function encodeDeployData(abi: any, bytecode: string, args: any[]): string {
  const factory = new ethers.ContractFactory(abi, bytecode);
  return factory.getDeployTransaction(...args).data;
}

async function pollGelatoTask(taskId: string, maxAttempts = 30): Promise<any> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(`https://relay.gelato.network/tasks/${taskId}`, {
        headers: { "Accept": "application/json" },
      });
      if (response.ok) {
        const task = await response.json();
        if (task.taskState === 'execSuccess' || task.taskState === 'execReverted' || task.taskState === 'cancelled') {
          return { status: task.taskState, receipt: task.transactionReceipt || task.receipt };
        }
      }
    } catch { /* retry */ }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  return null;
}

async function configureContractViaGelato(
  contractAddress: string, abi: any, userAddress: string,
  dexConfigs: any[], chainKey: string, feeToken: string,
): Promise<void> {
  // If Gelato is available, configure via sponsored calls
  if (!GELATO_API_KEY) return;
  const provider = new ethers.JsonRpcProvider(CHAIN_RPCS[chainKey]);
  const executor = new ethers.Contract(contractAddress, abi, provider);

  try {
    const initCallData = await executor.initializeOwner.populateTransaction(userAddress);
    await fetch("https://relay.gelato.network/callWithSyncFee", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": GELATO_API_KEY },
      body: JSON.stringify({
        chainId: GELATO_CHAIN_IDS[chainKey],
        target: contractAddress,
        data: initCallData,
        feeToken,
        isRelayContext: false,
      }),
    });
  } catch { /* non-fatal */ }

  for (const dex of dexConfigs) {
    if (dex.type === 'uniswap_v2' || dex.type === 'algebra') {
      try {
        const routerCallData = await executor.setV2Router.populateTransaction(dex.name, dex.router);
        await fetch("https://relay.gelato.network/callWithSyncFee", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-API-KEY": GELATO_API_KEY },
          body: JSON.stringify({
            chainId: GELATO_CHAIN_IDS[chainKey],
            target: contractAddress,
            data: routerCallData,
            feeToken,
            isRelayContext: false,
          }),
        });
      } catch { /* non-fatal */ }
    }
  }
}
