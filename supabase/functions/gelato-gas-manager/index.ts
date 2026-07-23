import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const GELATO_API_KEY = Deno.env.get("GELATO_API_KEY") || "";

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

function isHexString(str: string): boolean {
  return /^0x[0-9a-fA-F]+$/.test(str);
}

function validateChainKey(chainKey: unknown): string | null {
  if (typeof chainKey !== "string") return null;
  if (!CHAIN_IDS.hasOwnProperty(chainKey)) return null;
  return chainKey;
}

function validateAddress(addr: unknown): string | null {
  if (typeof addr !== "string") return null;
  if (!isHexString(addr) || addr.length !== 42) return null;
  return addr;
}

function validateTaskId(taskId: unknown): string | null {
  if (typeof taskId !== "string") return null;
  if (taskId.length > 256) return null;
  if (!/^[a-zA-Z0-9\-_]+$/.test(taskId)) return null;
  return taskId;
}

async function callWithSyncFee(chainKey: string, target: string, data: string, feeToken: string) {
  if (!GELATO_API_KEY) {
    throw new Error("GELATO_API_KEY is not configured. Add it as an edge function secret.");
  }
  const chainId = CHAIN_IDS[chainKey];

  const resp = await fetch(`${GELATO_RELAY_URL}/callWithSyncFee`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${GELATO_API_KEY}`,
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

async function getTaskStatus(taskId: string) {
  if (!GELATO_API_KEY) {
    throw new Error("GELATO_API_KEY is not configured.");
  }

  const resp = await fetch(`${GELATO_API_BASE}/tasks/${taskId}`, {
    headers: { "Authorization": `Bearer ${GELATO_API_KEY}` },
  });

  if (!resp.ok) throw new Error(`Gelato API error: ${resp.statusText}`);

  const result = await resp.json();
  return {
    success: true,
    taskId,
    taskState: result.taskState,
    transactionHash: result.transactionHash,
  };
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

    if (action === "list_flash_loan_providers") {
      return json({ providers: FLASH_LOAN_PROVIDERS });
    }

    if (action === "sync_fee_execute") {
      const { chainKey, target, data: calldata, feeToken: customFeeToken } = body;
      const validChain = validateChainKey(chainKey);
      if (!validChain) return jsonError("Invalid or missing chainKey", 400);
      const validTarget = validateAddress(target);
      if (!validTarget) return jsonError("Invalid or missing target address", 400);
      if (typeof calldata !== "string" || !isHexString(calldata)) {
        return jsonError("Invalid calldata (must be hex string)", 400);
      }
      const feeToken = customFeeToken || FEE_TOKENS[validChain];
      if (!feeToken) return jsonError(`No fee token for chain: ${validChain}`, 400);

      try {
        const result = await callWithSyncFee(validChain, validTarget, calldata, feeToken);
        return json(result);
      } catch (e) { return json({ success: false, error: String(e) }, 500); }
    }

    if (action === "get_task_status") {
      const validTaskId = validateTaskId(body.taskId);
      if (!validTaskId) return jsonError("Invalid or missing taskId", 400);
      try {
        const result = await getTaskStatus(validTaskId);
        return json(result);
      } catch (e) { return json({ success: false, error: String(e) }, 500); }
    }

    return jsonError(`Unknown action: ${String(action)}`, 400);
  } catch (err: unknown) {
    return jsonError(String(err));
  }
});
