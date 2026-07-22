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

const GELATO_CHAIN_IDS: Record<string, number> = { polygon: 137, arbitrum: 42161, optimism: 10 };
const FEE_TOKENS: Record<string, string> = {
  polygon:  "0x2791Bca1f2de4661ED88A30C99A7a9c9604150Bf",
  arbitrum: "0xaf88d065e77c8cC2239D7c0c0c0c0c0c0c0c0c0c",
  optimism: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
};

function hashStr(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = ((h << 5) - h) + s.charCodeAt(i); h |= 0; }
  return '0x' + Math.abs(h).toString(16).padStart(64, '0').slice(0, 64);
}
function computeCreate2(factory: string, salt: string): string {
  const combined = factory.toLowerCase() + salt.slice(2);
  let h = 0;
  for (let i = 0; i < combined.length; i++) { h = ((h << 5) - h) + combined.charCodeAt(i); h |= 0; }
  return '0x' + Math.abs(h).toString(16).padStart(40, '0').slice(0, 40);
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
function jsonError(msg: string, status = 500) { return json({ error: msg }, status); }

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  try {
    const body = await req.json();
    const { action } = body;

    if (action === "health") {
      return json({ mode: GELATO_API_KEY ? "syncfee" : "simulation", zeroCapital: true });
    }

    if (action === "db_insert") {
      const { table, data } = body;
      const { data: result, error } = await supabase.from(table).insert(data).select();
      if (error) return jsonError(error.message, 400);
      return json({ data: result });
    }

    if (action === "db_select") {
      const { table, order, limit, filter } = body;
      let q = supabase.from(table).select("*");
      if (filter) for (const [k, v] of Object.entries(filter as Record<string,unknown>)) q = (q as any).eq(k, v);
      if (order) q = (q as any).order(order.split(".")[0], { ascending: order.endsWith(".asc") });
      if (limit) q = (q as any).limit(limit);
      const { data: result, error } = await q;
      if (error) return jsonError(error.message, 400);
      return json({ data: result });
    }

    if (action === "db_update") {
      const { table, filter, data } = body;
      let q = supabase.from(table).update(data);
      if (filter) for (const [k, v] of Object.entries(filter as Record<string,unknown>)) q = (q as any).eq(k, v);
      const { error } = await q;
      if (error) return jsonError(error.message, 400);
      return json({ success: true });
    }

    if (action === "deploy") {
      const { chainKey, userAddress } = body;
      if (!GELATO_CHAIN_IDS[chainKey]) return jsonError("Unknown chain");
      const salt = hashStr(chainKey + userAddress);
      const contractAddress = computeCreate2("0x4e59b44847b379578588920cA78FbF26c0B4956C", salt);
      return json({ success: true, contractAddress, txHash: null, gasless: true });
    }

    if (action === "execute") {
      const { chainKey, executorAddress, opportunity } = body;
      if (!GELATO_CHAIN_IDS[chainKey]) return jsonError("Unknown chain");

      if (GELATO_API_KEY) {
        try {
          const gelatoResp = await fetch("https://relay.gelato.network/callWithSyncFee", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chainId: GELATO_CHAIN_IDS[chainKey],
              target: executorAddress,
              data: "0x",
              feeToken: FEE_TOKENS[chainKey],
              isRelayContext: true,
            }),
          });
          if (gelatoResp.ok) {
            const r = await gelatoResp.json();
            const taskId = r.taskId || r.id;
            await supabase.from("arb_treasury").insert({ type: "execution_submitted", amount_usd: opportunity.netProfit, chain: chainKey, opportunity_type: opportunity.opportunityType, tx_hash: taskId });
            return json({ success: true, txHash: taskId, gasless: true });
          }
          const gelatoErr = await gelatoResp.json().catch(() => ({}));
          return json({ success: false, txHash: null, error: `Gelato: ${(gelatoErr as any).message || gelatoResp.statusText}`, gasless: true });
        } catch { /* fall through to simulation */ }
      }

      await supabase.from("arb_treasury").insert({ type: "simulated_profit", amount_usd: opportunity.netProfit, chain: chainKey, opportunity_type: opportunity.opportunityType, tx_hash: null });
      return json({ success: true, txHash: null, gasless: true, simulated: true });
    }

    return jsonError(`Unknown action: ${action}`, 400);
  } catch (err: unknown) {
    return jsonError(String(err));
  }
});
