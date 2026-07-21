/**
 * Relayer Edge Function — Zero-gas transaction relay via Gelato Network + DB writes.
 *
 * Actions:
 * - deploy: Deploy FlashArbExecutor contract via Gelato relay
 * - execute: Execute arbitrage via Gelato relay with EIP-712 signature
 * - health: Check Gelato/relayer configuration status
 * - db_insert: Insert into a table (service role bypasses RLS)
 * - db_select: Select from a table
 * - db_update: Update a row in a table
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { ethers } from "npm:ethers@6.13.0";
import { createClient } from "npm:@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const GELATO_API_KEY = Deno.env.get("GELATO_API_KEY") || "";
const RELAYER_PRIVATE_KEY = Deno.env.get("RELAYER_PRIVATE_KEY") || "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const CHAIN_RPCS: Record<string, string> = {
  polygon: "https://polygon-bor-rpc.publicnode.com",
  arbitrum: "https://arbitrum-one-rpc.publicnode.com",
  optimism: "https://optimism-rpc.publicnode.com",
};

const GELATO_CHAIN_IDS: Record<string, number> = {
  polygon: 137, arbitrum: 42161, optimism: 10,
};

const EXECUTOR_ABI = [
  "function executeArbWithSig(address asset, uint256 amount, bytes params, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external",
  "function initializeOwner(address _owner) external",
  "function setV2Router(string name, address router) external",
  "function setV3Router(address router) external",
  "function setGelatoRelayer(address _relayer) external",
  "function owner() view returns (address)",
  "function nonces(address) view returns (uint256)",
];

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { action } = body;

    // ── HEALTH CHECK ──────────────────────────────────────
    if (action === "health") {
      const gelatoConfigured = !!GELATO_API_KEY;
      const relayerConfigured = !!RELAYER_PRIVATE_KEY;
      let relayerAddress: string | null = null;
      const balances: Record<string, string> = {};

      if (relayerConfigured) {
        const w = new ethers.Wallet(RELAYER_PRIVATE_KEY);
        relayerAddress = w.address;
        for (const [chain, rpc] of Object.entries(CHAIN_RPCS)) {
          try {
            const provider = new ethers.JsonRpcProvider(rpc);
            const bal = await provider.getBalance(w.address);
            balances[chain] = ethers.formatEther(bal);
          } catch { balances[chain] = "error"; }
        }
      }

      return new Response(JSON.stringify({
        gelatoConfigured, relayerConfigured, relayerAddress, balances,
        mode: gelatoConfigured ? "gelato" : relayerConfigured ? "direct" : "unconfigured",
        message: gelatoConfigured
          ? "Gelato Gas Tank active — zero native tokens needed"
          : relayerConfigured
          ? "Direct relay active — relayer wallet pays gas"
          : "Set GELATO_API_KEY or RELAYER_PRIVATE_KEY",
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── DB OPERATIONS (service role bypasses RLS) ──────────
    if (action === "db_insert") {
      const { table, data } = body;
      const { data: result, error } = await supabase.from(table).insert(data).select();
      if (error) return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      return new Response(JSON.stringify({ data: result }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "db_select") {
      const { table, order, limit, filter } = body;
      let query = supabase.from(table).select("*");
      if (filter) for (const [k, v] of Object.entries(filter)) query = query.eq(k, v);
      if (order) query = query.order(order.split(".")[0], { ascending: order.endsWith(".asc") });
      if (limit) query = query.limit(limit);
      const { data: result, error } = await query;
      if (error) return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      return new Response(JSON.stringify({ data: result }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "db_update") {
      const { table, filter, data } = body;
      let query = supabase.from(table).update(data);
      if (filter) for (const [k, v] of Object.entries(filter)) query = query.eq(k, v);
      const { error } = await query;
      if (error) return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── DEPLOY ─────────────────────────────────────────────
    if (action === "deploy") {
      const { chainKey, userAddress, balancerVault, v3Router, feeToken, gelatoFeeCollector, dexConfigs } = body;
      const rpcUrl = CHAIN_RPCS[chainKey];
      if (!rpcUrl) return new Response(JSON.stringify({ success: false, error: "Unknown chain" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });

      const provider = new ethers.JsonRpcProvider(rpcUrl);

      // Try Gelato-sponsored deployment
      if (GELATO_API_KEY) {
        try {
          const deployTx = await encodeDeployCall(balancerVault, v3Router, feeToken, gelatoFeeCollector);
          const gelatoResp = await fetch("https://relay.gelato.network/callWithSyncFee", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Accept": "application/json" },
            body: JSON.stringify({ chainId: GELATO_CHAIN_IDS[chainKey], target: ethers.ZeroAddress, data: deployTx, feeToken, isRelayContext: false }),
          });
          if (gelatoResp.ok) {
            const gelatoResult = await gelatoResp.json();
            const taskId = gelatoResult.taskId || gelatoResult.id;
            if (taskId) {
              const receipt = await pollGelatoTask(taskId);
              if (receipt && receipt.taskState === "execSuccess") {
                const contractAddress = receipt.receipt?.contractAddress;
                if (contractAddress) {
                  await configureContract(chainKey, contractAddress, userAddress, dexConfigs);
                  return new Response(JSON.stringify({ success: true, contractAddress, txHash: receipt.receipt?.transactionHash, gasless: true, mode: "gelato" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
                }
              }
            }
          }
        } catch (e: any) { console.log("Gelato deploy failed:", e.message); }
      }

      // Fallback: direct deployment
      if (!RELAYER_PRIVATE_KEY) {
        return new Response(JSON.stringify({ success: false, error: "No gas funding. Set GELATO_API_KEY or RELAYER_PRIVATE_KEY." }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      const relayerWallet = new ethers.Wallet(RELAYER_PRIVATE_KEY, provider);
      const factory = new ethers.ContractFactory(EXECUTOR_ABI, "0x", relayerWallet);
      // Direct deploy using raw bytecode would go here; for now return error since we need bytecode
      return new Response(JSON.stringify({ success: false, error: "Direct deploy requires bytecode. Use Gelato mode." }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── EXECUTE ────────────────────────────────────────────
    if (action === "execute") {
      const { chainKey, executorAddress, asset, amount, params, deadline, v, r, s, userAddress } = body;
      const rpcUrl = CHAIN_RPCS[chainKey];
      if (!rpcUrl) return new Response(JSON.stringify({ success: false, error: "Unknown chain" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });

      const provider = new ethers.JsonRpcProvider(rpcUrl);

      // Try Gelato relay
      if (GELATO_API_KEY) {
        try {
          const executor = new ethers.Contract(executorAddress, EXECUTOR_ABI, provider);
          const callData = await executor.executeArbWithSig.populateTransaction(asset, amount, params, deadline, v, r, s);
          const gelatoResp = await fetch("https://relay.gelato.network/callWithSyncFeeERC2771", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Accept": "application/json", "X-API-KEY": GELATO_API_KEY },
            body: JSON.stringify({ chainId: GELATO_CHAIN_IDS[chainKey], target: executorAddress, data: callData, feeToken: ethers.ZeroAddress, sponsorApiKey: GELATO_API_KEY, isRelayContext: true }),
          });
          if (gelatoResp.ok) {
            const gelatoResult = await gelatoResp.json();
            const taskId = gelatoResult.taskId || gelatoResult.id;
            if (taskId) {
              const receipt = await pollGelatoTask(taskId);
              if (receipt && receipt.taskState === "execSuccess") {
                return new Response(JSON.stringify({ success: true, txHash: receipt.receipt?.transactionHash, gasUsed: receipt.receipt?.gasUsed ? Number(receipt.receipt.gasUsed) : null, gasless: true, mode: "gelato" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
              } else {
                return new Response(JSON.stringify({ success: false, txHash: receipt?.receipt?.transactionHash || null, error: `Gelato task: ${receipt?.taskState || "unknown"}`, gasless: true }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
              }
            }
          }
        } catch (e: any) { console.log("Gelato execute failed:", e.message); }
      }

      // Fallback: direct relay
      if (!RELAYER_PRIVATE_KEY) {
        return new Response(JSON.stringify({ success: false, error: "No gas funding. Set GELATO_API_KEY or RELAYER_PRIVATE_KEY." }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      const relayerWallet = new ethers.Wallet(RELAYER_PRIVATE_KEY, provider);
      const executor = new ethers.Contract(executorAddress, EXECUTOR_ABI, relayerWallet);
      try {
        const gasEstimate = await executor.executeArbWithSig.estimateGas(asset, amount, params, deadline, v, r, s);
        const feeData = await provider.getFeeData();
        const gasPrice = feeData.gasPrice || ethers.parseUnits("30", "gwei");
        const tx = await executor.executeArbWithSig(asset, amount, params, deadline, v, r, s, { gasLimit: (gasEstimate * 13n) / 10n, gasPrice });
        const receipt = await tx.wait();
        if (receipt && receipt.status === 1) {
          return new Response(JSON.stringify({ success: true, txHash: receipt.hash, gasUsed: Number(receipt.gasUsed), gasless: true, mode: "direct" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        } else {
          return new Response(JSON.stringify({ success: false, txHash: receipt?.hash || null, error: "Tx reverted", gasless: true }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
      } catch (e: any) {
        return new Response(JSON.stringify({ success: false, error: e.message?.slice(0, 200), gasless: false }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }

    return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || "Unknown error" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});

async function encodeDeployCall(balancerVault: string, v3Router: string, feeToken: string, gelatoFeeCollector: string): Promise<string> {
  // Encode constructor args for deployment
  const iface = new ethers.Interface(EXECUTOR_ABI);
  return iface.encodeDeploy(balancerVault, v3Router, feeToken, gelatoFeeCollector);
}

async function pollGelatoTask(taskId: string, maxAttempts = 30): Promise<any> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const resp = await fetch(`https://relay.gelato.network/tasks/${taskId}`, { headers: { "Accept": "application/json" } });
      if (resp.ok) {
        const task = await resp.json();
        if (["execSuccess", "execReverted", "cancelled"].includes(task.taskState)) {
          return { taskState: task.taskState, receipt: task.transactionReceipt || task.receipt };
        }
      }
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 2000));
  }
  return null;
}

async function configureContract(chainKey: string, contractAddress: string, userAddress: string, dexConfigs: any[]): Promise<void> {
  if (!GELATO_API_KEY) return;
  const provider = new ethers.JsonRpcProvider(CHAIN_RPCS[chainKey]);
  const executor = new ethers.Contract(contractAddress, EXECUTOR_ABI, provider);

  try {
    const initData = await executor.initializeOwner.populateTransaction(userAddress);
    await fetch("https://relay.gelato.network/callWithSyncFee", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": GELATO_API_KEY },
      body: JSON.stringify({ chainId: GELATO_CHAIN_IDS[chainKey], target: contractAddress, data: initData, feeToken: ethers.ZeroAddress, isRelayContext: false }),
    });
  } catch { /* non-fatal */ }

  for (const dex of dexConfigs) {
    if (dex.type === "uniswap_v2" || dex.type === "algebra") {
      try {
        const routerData = await executor.setV2Router.populateTransaction(dex.name, dex.router);
        await fetch("https://relay.gelato.network/callWithSyncFee", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-API-KEY": GELATO_API_KEY },
          body: JSON.stringify({ chainId: GELATO_CHAIN_IDS[chainKey], target: contractAddress, data: routerData, feeToken: ethers.ZeroAddress, isRelayContext: false }),
        });
      } catch { /* non-fatal */ }
    }
  }
}
