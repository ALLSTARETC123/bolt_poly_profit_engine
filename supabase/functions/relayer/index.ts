/**
 * Relayer Edge Function — Gasless transaction relay.
 *
 * This function holds a "gas tank" wallet (RELAYER_PRIVATE_KEY) that pays for
 * gas on behalf of users. Users sign EIP-712 messages off-chain (free) and
 * submit them here. The relayer submits the transaction on-chain.
 *
 * The relayer is reimbursed via:
 * 1. 5% of each arbitrage profit (RELAYER_FEE_PERCENT in the contract)
 * 2. The contract's gas reserve (10% of profit)
 *
 * This eliminates the cold-start problem: users never need native tokens.
 *
 * Endpoints:
 * POST /functions/v1/relayer
 *   { action: 'deploy', chainKey, userAddress, balancerVault, v3Router, bytecode, abi, dexConfigs }
 *   { action: 'execute', chainKey, executorAddress, asset, amount, params, deadline, v, r, s, userAddress }
 *   { action: 'health' }
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { ethers } from "npm:ethers@6.13.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const RELAYER_PRIVATE_KEY = Deno.env.get("RELAYER_PRIVATE_KEY") || "";
const CHAIN_RPCS: Record<string, string> = {
  polygon: "https://polygon-bor-rpc.publicnode.com",
  arbitrum: "https://arbitrum-one-rpc.publicnode.com",
  optimism: "https://optimism-rpc.publicnode.com",
};

const EXECUTOR_ABI = [
  'function executeArbWithSig(address asset, uint256 amount, bytes params, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external',
  'function initializeOwner(address _owner) external',
  'function setV2Router(string name, address router) external',
  'function setV3Router(address router) external',
  'function setRelayer(address _relayer) external',
  'function owner() view returns (address)',
  'function relayer() view returns (address)',
  'function nonces(address) view returns (uint256)',
  'event ArbExecuted(address indexed asset, uint256 borrowed, uint256 profit, uint256 toOwner, uint256 toRelayer, uint256 gasReserveAfter, uint8 provider)',
];

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { action } = body;

    if (action === "health") {
      const relayerWallet = new ethers.Wallet(RELAYER_PRIVATE_KEY);
      const balances: Record<string, string> = {};
      for (const [chain, rpc] of Object.entries(CHAIN_RPCS)) {
        try {
          const provider = new ethers.JsonRpcProvider(rpc);
          const balance = await provider.getBalance(relayerWallet.address);
          balances[chain] = ethers.formatEther(balance);
        } catch {
          balances[chain] = "error";
        }
      }
      return new Response(JSON.stringify({
        relayerAddress: relayerWallet.address,
        balances,
        configured: !!RELAYER_PRIVATE_KEY,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (!RELAYER_PRIVATE_KEY) {
      return new Response(JSON.stringify({
        success: false,
        error: "Relayer not configured. Set RELAYER_PRIVATE_KEY environment variable.",
      }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const rpcUrl = CHAIN_RPCS[body.chainKey];
    if (!rpcUrl) {
      return new Response(JSON.stringify({
        success: false, error: `Unknown chain: ${body.chainKey}`,
      }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const relayerWallet = new ethers.Wallet(RELAYER_PRIVATE_KEY, provider);

    if (action === "deploy") {
      // Deploy the contract on behalf of the user
      // The relayer is the deployer, then sets the user as owner and itself as relayer
      const { balancerVault, v3Router, bytecode, abi, dexConfigs, userAddress } = body;

      const factory = new ethers.ContractFactory(abi, bytecode, relayerWallet);
      const contract = await factory.deploy(balancerVault, v3Router, { gasLimit: 3000000n });
      await contract.waitForDeployment();
      const contractAddress = await contract.getAddress();

      // Set the real user as owner
      const tx1 = await contract.initializeOwner(userAddress);
      await tx1.wait();

      // Set ourselves as the relayer
      const tx2 = await contract.setRelayer(relayerWallet.address);
      await tx2.wait();

      // Configure DEX routers
      const executor = new ethers.Contract(contractAddress, abi, relayerWallet);
      for (const dex of dexConfigs) {
        if (dex.type === 'uniswap_v2' || dex.type === 'algebra') {
          try {
            const tx = await executor.setV2Router(dex.name, dex.router);
            await tx.wait();
          } catch (e) { /* non-fatal */ }
        }
      }

      return new Response(JSON.stringify({
        success: true,
        contractAddress,
        txHash: contract.deploymentTransaction()?.hash,
        relayerAddress: relayerWallet.address,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "execute") {
      // Execute an arbitrage on behalf of the user via their EIP-712 signature
      const { executorAddress, asset, amount, params, deadline, v, r, s } = body;

      const executor = new ethers.Contract(executorAddress, EXECUTOR_ABI, relayerWallet);

      // Verify the signature matches the contract's expected hash
      // (the contract does the actual verification, we just relay)

      // Estimate gas
      let gasEstimate: bigint;
      try {
        gasEstimate = await executor.executeArbWithSig.estimateGas(
          asset, amount, params, deadline, v, r, s,
        );
      } catch (err: any) {
        return new Response(JSON.stringify({
          success: false,
          error: `Gas estimation failed: ${err.message?.slice(0, 200)}`,
          autoFixed: null,
        }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // Get gas price
      const feeData = await provider.getFeeData();
      const gasPrice = feeData.gasPrice || ethers.parseUnits('30', 'gwei');

      // Submit the transaction via the relayer (private mempool compatible)
      const tx = await executor.executeArbWithSig(
        asset, amount, params, deadline, v, r, s,
        { gasLimit: (gasEstimate * 13n) / 10n, gasPrice },
      );

      const receipt = await tx.wait();

      if (receipt && receipt.status === 1) {
        return new Response(JSON.stringify({
          success: true,
          txHash: receipt.hash,
          gasUsed: Number(receipt.gasUsed),
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      } else {
        return new Response(JSON.stringify({
          success: false,
          txHash: receipt?.hash || null,
          error: 'Transaction reverted. May have been front-run.',
          gasUsed: receipt ? Number(receipt.gasUsed) : null,
          autoFixed: null,
        }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }

    return new Response(JSON.stringify({
      success: false, error: `Unknown action: ${action}`,
    }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (err: any) {
    return new Response(JSON.stringify({
      success: false, error: err.message || 'Unknown error',
    }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
