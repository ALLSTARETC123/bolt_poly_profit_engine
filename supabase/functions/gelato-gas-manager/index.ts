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

const GELATO_RELAY_URL = "https://relay.gelato.network";
const GELATO_API_BASE = "https://api.gelato.network";

const CHAIN_IDS: Record<string, number> = {
  polygon: 137,
  arbitrum: 42161,
  optimism: 10,
  base: 8453,
};

const FEE_TOKENS: Record<string, string> = {
  polygon: "0x2791Bca1f2de4661ED88A30C99A7a9c9604150Bf",
  arbitrum: "0xaf88d065e77c8cC2239D7c0c0c0c0c0c0c0c0c0c",
  optimism: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};

const FLASH_LOAN_PROVIDERS: Record<string, { name: string; address: string; feeBps: number }> = {
  balancer: { name: "Balancer", address: "0xBA12222222228d8Ba445958a75a0704d566BF2C8", feeBps: 0 },
  aave: { name: "Aave V3", address: "0x794a61358D6845594F94dc1DB02A252b5b4814aD", feeBps: 5 },
  uniswap: { name: "Uniswap V3", address: "0x1F98431c8aD98523631AE4a59f267346ea31F984", feeBps: 30 },
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function jsonError(msg: string, status = 500) {
  return json({ error: msg }, status);
}

function requireGelatoKey(): string {
  if (!GELATO_API_KEY) {
    throw new Error("GELATO_API_KEY is not configured. Add it as an edge function secret: npx supabase secrets set GELATO_API_KEY=your_key");
  }
  return GELATO_API_KEY;
}

async function callWithSyncFee(chainKey: string, target: string, data: string, feeToken: string) {
  const apiKey = requireGelatoKey();
  const chainId = CHAIN_IDS[chainKey];
  if (!chainId) throw new Error(`Unsupported chain: ${chainKey}`);

  const resp = await fetch(`${GELATO_RELAY_URL}/callWithSyncFee`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      chainId,
      target,
      data,
      feeToken,
      isRelayContext: true,
    }),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(`Gelato callWithSyncFee failed (${resp.status}): ${(err as { message?: string }).message || resp.statusText}`);
  }

  const result = await resp.json();
  return { success: true, taskId: result.taskId || result.id, txHash: result.txHash ?? null };
}

async function sponsorCall(chainKey: string, target: string, data: string, sponsorApiKey?: string) {
  const apiKey = sponsorApiKey || requireGelatoKey();
  const chainId = CHAIN_IDS[chainKey];
  if (!chainId) throw new Error(`Unsupported chain: ${chainKey}`);

  const resp = await fetch(`${GELATO_RELAY_URL}/relayWithSponsoredCall`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      chainId,
      target,
      data,
      sponsorApiKey: apiKey,
    }),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(`Gelato sponsored call failed (${resp.status}): ${(err as { message?: string }).message || resp.statusText}`);
  }

  const result = await resp.json();
  return { success: true, taskId: result.taskId || result.id };
}

async function getTaskStatus(taskId: string) {
  const apiKey = requireGelatoKey();

  const resp = await fetch(`${GELATO_API_BASE}/tasks/${taskId}`, {
    headers: { "Authorization": `Bearer ${apiKey}` },
  });

  if (!resp.ok) throw new Error(`Gelato API error: ${resp.statusText}`);

  const result = await resp.json();
  return {
    success: true,
    taskId,
    taskState: result.taskState,
    chainId: result.chainId,
    creationDate: result.creationDate,
    executionDate: result.executionDate,
    transactionHash: result.transactionHash,
    gasPrice: result.gasPrice,
    gasUsed: result.gasUsed,
    feeToken: result.feeToken,
    feeAmount: result.feeAmount,
  };
}

async function getEstimatedFee(chainKey: string, gasLimit: number, feeToken: string) {
  const apiKey = requireGelatoKey();
  const chainId = CHAIN_IDS[chainKey];
  if (!chainId) throw new Error(`Unsupported chain: ${chainKey}`);

  const resp = await fetch(`${GELATO_API_BASE}/oracles/${chainId}/estimate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ gasLimit, feeToken }),
  });

  if (!resp.ok) throw new Error(`Gelato estimate failed: ${resp.statusText}`);

  const result = await resp.json();
  return { success: true, estimatedFee: result.estimatedFee, feeToken, gasLimit, chainId };
}

function getFlashLoanProvider(providerKey: string) {
  const provider = FLASH_LOAN_PROVIDERS[providerKey.toLowerCase()];
  if (!provider) throw new Error(`Unknown flash loan provider: ${providerKey}`);
  return provider;
}

async function saveGasRecord(chainKey: string, type: string, amountUsd: number) {
  try {
    await supabase.from("arb_treasury").insert({
      type,
      amount_usd: amountUsd,
      chain: chainKey,
    });
  } catch { /* non-fatal */ }
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
        gelatoConfigured: !!GELATO_API_KEY,
        mode: GELATO_API_KEY ? "live" : "not_configured",
        supportedChains: Object.keys(CHAIN_IDS),
        flashLoanProviders: Object.keys(FLASH_LOAN_PROVIDERS),
      });
    }

    if (action === "get_flash_loan_provider") {
      const { provider } = body;
      if (!provider) return jsonError("Missing required field: provider", 400);
      try {
        const p = getFlashLoanProvider(provider);
        return json(p);
      } catch (e) { return jsonError(String(e), 400); }
    }

    if (action === "list_flash_loan_providers") {
      return json({ providers: FLASH_LOAN_PROVIDERS });
    }

    if (action === "sync_fee_execute") {
      const { chainKey, target, data: calldata, feeToken: customFeeToken } = body;
      if (!chainKey || !target || !calldata) return jsonError("Missing required fields: chainKey, target, data", 400);
      const feeToken = customFeeToken || FEE_TOKENS[chainKey];
      if (!feeToken) return jsonError(`No fee token configured for chain: ${chainKey}`, 400);

      try {
        const result = await callWithSyncFee(chainKey, target, calldata, feeToken);
        await saveGasRecord(chainKey, "syncfee_executed", 0);
        return json(result);
      } catch (e) { return json({ success: false, error: String(e) }, 500); }
    }

    if (action === "sponsored_execute") {
      const { chainKey, target, data: calldata, sponsorApiKey } = body;
      if (!chainKey || !target || !calldata) return jsonError("Missing required fields: chainKey, target, data", 400);

      try {
        const result = await sponsorCall(chainKey, target, calldata, sponsorApiKey);
        await saveGasRecord(chainKey, "sponsored_executed", 0);
        return json(result);
      } catch (e) { return json({ success: false, error: String(e) }, 500); }
    }

    if (action === "get_task_status") {
      const { taskId } = body;
      if (!taskId) return jsonError("Missing required field: taskId", 400);
      try {
        const result = await getTaskStatus(taskId);
        return json(result);
      } catch (e) { return json({ success: false, error: String(e) }, 500); }
    }

    if (action === "estimate_fee") {
      const { chainKey, gasLimit, feeToken: customFeeToken } = body;
      if (!chainKey || !gasLimit) return jsonError("Missing required fields: chainKey, gasLimit", 400);
      const feeToken = customFeeToken || FEE_TOKENS[chainKey];
      if (!feeToken) return jsonError(`No fee token configured for chain: ${chainKey}`, 400);
      try {
        const result = await getEstimatedFee(chainKey, gasLimit, feeToken);
        return json(result);
      } catch (e) { return json({ success: false, error: String(e) }, 500); }
    }

    if (action === "save_operator_config") {
      const { key, value, description } = body;
      if (!key || !value) return jsonError("Missing required fields: key, value", 400);
      const { data, error } = await supabase
        .from("operator_config")
        .upsert({ key, value, description, updated_at: new Date().toISOString() }, { onConflict: "key" })
        .select();
      if (error) return jsonError(error.message, 400);
      return json({ success: true, data });
    }

    if (action === "get_operator_config") {
      const { key } = body;
      if (!key) return jsonError("Missing required field: key", 400);
      const { data, error } = await supabase
        .from("operator_config")
        .select("*")
        .eq("key", key)
        .maybeSingle();
      if (error) return jsonError(error.message, 400);
      return json({ success: true, data });
    }

    if (action === "list_operator_config") {
      const { data, error } = await supabase
        .from("operator_config")
        .select("*")
        .order("updated_at", { ascending: false });
      if (error) return jsonError(error.message, 400);
      return json({ success: true, data });
    }

    return jsonError(`Unknown action: ${action}`, 400);
  } catch (err: unknown) {
    return jsonError(String(err));
  }
});
