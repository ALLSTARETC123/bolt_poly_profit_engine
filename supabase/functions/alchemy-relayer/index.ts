import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const ALCHEMY_API_KEY = Deno.env.get("ALCHEMY_API_KEY") || "";
const ALCHEMY_PAYMASTER_POLICY_ID = Deno.env.get("ALCHEMY_PAYMASTER_POLICY_ID") || "";

const CHAIN_RPC_BASE: Record<string, string> = {
  polygon: "https://polygon-mainnet.g.alchemy.com/v2/",
  arbitrum: "https://arb-mainnet.g.alchemy.com/v2/",
  optimism: "https://opt-mainnet.g.alchemy.com/v2/",
  base: "https://base-mainnet.g.alchemy.com/v2/",
};

const FLASHBOTS_RPC = "https://rpc.flashbots.net";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function isHexString(str: string): boolean {
  return /^0x[0-9a-fA-F]+$/.test(str);
}

function validateChainKey(chainKey: unknown): string | null {
  if (typeof chainKey !== "string") return null;
  if (!Object.prototype.hasOwnProperty.call(CHAIN_RPC_BASE, chainKey)) return null;
  return chainKey;
}

function validateAddress(addr: unknown): string | null {
  if (typeof addr !== "string") return null;
  if (!isHexString(addr) || addr.length !== 42) return null;
  return addr;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }
  try {
    const body = await req.json();
    const { action } = body;

    if (action === "health") {
      return json({
        status: "ok",
        alchemyConfigured: !!ALCHEMY_API_KEY,
        paymasterPolicyId: ALCHEMY_PAYMASTER_POLICY_ID || null,
        mode: ALCHEMY_API_KEY ? "alchemy_sponsored" : "public_rpc",
        flashbotsRpc: FLASHBOTS_RPC,
        supportedChains: Object.keys(CHAIN_RPC_BASE),
      });
    }

    if (action === "get_gas_price") {
      const validChain = validateChainKey(body.chainKey);
      if (!validChain) return json({ error: "Invalid chainKey" }, 400);
      const rpcUrl = ALCHEMY_API_KEY
        ? CHAIN_RPC_BASE[validChain] + ALCHEMY_API_KEY
        : null;
      if (!rpcUrl) return json({ error: "Alchemy API key not configured" }, 500);
      try {
        const resp = await fetch(rpcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_gasPrice", params: [] }),
        });
        const result = await resp.json();
        return json({ success: true, gasPrice: result.result });
      } catch (e) {
        return json({ success: false, error: String(e) }, 500);
      }
    }

    if (action === "submit_flashbots") {
      const { signedTx } = body;
      if (typeof signedTx !== "string" || !isHexString(signedTx)) {
        return json({ error: "Invalid signed transaction" }, 400);
      }
      try {
        const resp = await fetch(FLASHBOTS_RPC, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction",
            params: [signedTx],
          }),
        });
        const result = await resp.json();
        if (result.error) return json({ success: false, error: result.error.message }, 500);
        return json({ success: true, txHash: result.result });
      } catch (e) {
        return json({ success: false, error: String(e) }, 500);
      }
    }

    if (action === "get_paymaster_policy") {
      return json({
        success: true,
        policyId: ALCHEMY_PAYMASTER_POLICY_ID || null,
        configured: !!ALCHEMY_PAYMASTER_POLICY_ID,
      });
    }

    return json({ error: `Unknown action: ${String(action)}` }, 400);
  } catch (err: unknown) {
    return json({ error: String(err) }, 500);
  }
});
