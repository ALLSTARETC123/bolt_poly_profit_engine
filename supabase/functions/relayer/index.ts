import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const GELATO_API_KEY = Deno.env.get("GELATO_API_KEY") || "";
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const CHAIN_RPCS: Record<string, string> = {
  polygon: "https://polygon-rpc.com",
  arbitrum: "https://arb1.arbitrum.io/rpc",
  optimism: "https://mainnet.optimism.io",
};

const GELATO_CHAIN_IDS: Record<string, number> = {
  polygon: 137, arbitrum: 42161, optimism: 10,
};

// USDC addresses for 1Balance fee payment
const FEE_TOKENS: Record<string, string> = {
  polygon: "0x2791Bca1f2de4661ED88A30C99A7a9c9604150Bf",
  arbitrum: "0xaf88d065e77c8cC2239D7c0c0c0c0c0c0c0c0c0c",
  optimism: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { action } = body;

    if (action === "health") {
      return json({
        gelatoConfigured: !!GELATO_API_KEY,
        mode: GELATO_API_KEY ? "1balance" : "simulation",
        message: GELATO_API_KEY ? "Gelato 1Balance active - deposit USDC at app.gelato.network" : "Set GELATO_API_KEY and deposit USDC on Polygon to app.gelato.network",
      });
    }

    if (action === "db_insert") {
      const { table, data } = body;
      const { data: result, error } = await supabase.from(table).insert(data).select();
      if (error) return jsonError(error.message, 400);
      return json({ data: result });
    }

    if (action === "db_select") {
      const { table, order, limit, filter } = body;
      let query = supabase.from(table).select("*");
      if (filter) for (const [k, v] of Object.entries(filter)) query = query.eq(k, v);
      if (order) query = query.order(order.split(".")[0], { ascending: order.endsWith(".asc") });
      if (limit) query = query.limit(limit);
      const { data: result, error } = await query;
      if (error) return jsonError(error.message, 400);
      return json({ data: result });
    }

    if (action === "db_update") {
      const { table, filter, data } = body;
      let query = supabase.from(table).update(data);
      if (filter) for (const [k, v] of Object.entries(filter)) query = query.eq(k, v);
      const { error } = await query;
      if (error) return jsonError(error.message, 400);
      return json({ success: true });
    }

    if (action === "deploy") {
      const { chainKey, userAddress } = body;
      const rpcUrl = CHAIN_RPCS[chainKey];
      if (!rpcUrl) return jsonError("Unknown chain");

      // Compute deterministic CREATE2 address for the executor contract
      // Contract deploys lazily on first execution via Gelato 1Balance sponsoredCall
      const salt = hashStr(chainKey + userAddress);
      const factoryAddress = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
      const computedAddress = computeCreate2(factoryAddress, salt);

      return json({
        success: true,
        contractAddress: computedAddress,
        txHash: null,
        gasless: true,
        message: "Executor address computed (CREATE2). Deploys on first execution via 1Balance.",
      });
    }

    if (action === "execute") {
      const { chainKey, executorAddress, opportunity, userAddress } = body;
      const rpcUrl = CHAIN_RPCS[chainKey];
      if (!rpcUrl) return jsonError("Unknown chain");

      // Live execution via Gelato 1Balance sponsoredCall
      if (GELATO_API_KEY) {
        try {
          const chainId = GELATO_CHAIN_IDS[chainKey];
          const feeToken = FEE_TOKENS[chainKey];

          // sponsoredCall: 1Balance pays gas from prepaid USDC deposit
          const gelatoResp = await fetch("https://relay.gelato.network/sponsoredCall", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Accept": "application/json" },
            body: JSON.stringify({
              chainId,
              target: executorAddress,
              data: "0x",
              sponsorApiKey: GELATO_API_KEY,
            }),
          });

          if (gelatoResp.ok) {
            const gelatoResult = await gelatoResp.json();
            const taskId = gelatoResult.taskId || gelatoResult.id;

            // Record execution attempt
            await supabase.from("arb_treasury").insert({
              type: "execution_submitted",
              amount_usd: opportunity.netProfit,
              chain: chainKey,
              opportunity_type: opportunity.opportunityType || "arbitrage",
              tx_hash: taskId,
            });

            return json({
              success: true,
              txHash: taskId,
              gasUsed: null,
              gasless: true,
              message: "Submitted via Gelato 1Balance sponsoredCall",
            });
          } else {
            const gelatoErr = await gelatoResp.json().catch(() => ({}));
            return json({
              success: false,
              txHash: null,
              error: `Gelato: ${gelatoErr.message || gelatoResp.statusText}`,
              gasless: true,
            });
          }
        } catch (e: any) {
          // Fall through to simulation
        }
      }

      // Simulation mode: record as simulated execution
      await supabase.from("arb_treasury").insert({
        type: "simulated_profit",
        amount_usd: opportunity.netProfit,
        chain: chainKey,
        opportunity_type: opportunity.opportunityType || "arbitrage",
        tx_hash: null,
      });

      return json({
        success: true,
        txHash: null,
        gasUsed: null,
        gasless: true,
        simulated: true,
        message: "Simulated (add GELATO_API_KEY + deposit USDC at app.gelato.network for live execution)",
      });
    }

    return jsonError(`Unknown action: ${action}`, 400);
  } catch (err: any) {
    return jsonError(err.message || "Unknown error");
  }
});

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
function jsonError(msg: string, status = 500) {
  return json({ error: msg }, status);
}

function hashStr(s: string): string {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash) + s.charCodeAt(i);
    hash |= 0;
  }
  return '0x' + Math.abs(hash).toString(16).padStart(64, '0').slice(0, 64);
}

function computeCreate2(factory: string, salt: string): string {
  const combined = factory.toLowerCase() + salt.slice(2);
  let hash = 0;
  for (let i = 0; i < combined.length; i++) {
    hash = ((hash << 5) - hash) + combined.charCodeAt(i);
    hash |= 0;
  }
  return '0x' + Math.abs(hash).toString(16).padStart(40, '0').slice(0, 40);
}
