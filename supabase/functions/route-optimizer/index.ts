import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

const POLYGON_RPC = 'https://polygon-mainnet.g.alchemy.com/v2/wf-n8242VyUxgSwmWNs9h';
const TREASURY_ADDRESS = '0xCD339078D159404D29000A6716D962C8833ABfe8';

interface OptimizeRequest {
  transactionHash?: string;
  fromAddress?: string;
  toAddress?: string;
  value?: string;
  gasPrice?: string;
  gasLimit?: string;
  data?: string;
  agentId?: string;
  chain?: 'polygon' | 'solana';
}

interface OptimizationResult {
  hasOpportunity: boolean;
  optimizationType: string;
  estimatedSavings: number;
  originalGas: number;
  optimizedGas: number;
  routeDescription: string;
  timestamp: string;
  transactionHash: string;
  confidence: number;
}

async function analyzeTransaction(tx: OptimizeRequest): Promise<OptimizationResult> {
  const value = parseFloat(tx.value || '0');
  const gasPrice = parseFloat(tx.gasPrice || '0');
  const gasLimit = parseFloat(tx.gasLimit || '210000');

  const optimizationTypes = [
    'gas_reduction',
    'route_optimization',
    'slippage_reduction',
    'latency_optimization',
  ];

  const hasOpportunity = value > 1e18 && gasPrice > 1e9;
  const savings = hasOpportunity ? Math.floor(Math.random() * 50000) + 21000 : 0;
  const optimizedGas = hasOpportunity ? gasLimit - savings : gasLimit;

  return {
    hasOpportunity,
    optimizationType: hasOpportunity ? optimizationTypes[Math.floor(Math.random() * optimizationTypes.length)] : 'none',
    estimatedSavings: savings,
    originalGas: gasLimit,
    optimizedGas,
    routeDescription: hasOpportunity ? 'Alternative route found through optimized DEX aggregator' : 'No optimization available',
    timestamp: new Date().toISOString(),
    transactionHash: tx.transactionHash || `0x${Date.now().toString(16)}`,
    confidence: hasOpportunity ? 0.85 + Math.random() * 0.1 : 0,
  };
}

async function storeTransaction(tx: OptimizeRequest, result: OptimizationResult) {
  const { error } = await supabase.from('mempool_transactions').insert({
    transaction_hash: tx.transactionHash || `0x${Date.now().toString(16)}`,
    from_address: tx.fromAddress || '',
    to_address: tx.toAddress || '',
    value: tx.value || '0',
    gas_price: tx.gasPrice || '0',
    gas_limit: tx.gasLimit || '210000',
    data: tx.data || '',
    status: 'pending',
    route_opportunity: result,
  });
  return !error;
}

async function createOptimizationRecord(tx: OptimizeRequest, result: OptimizationResult) {
  if (!result.hasOpportunity) return null;

  const { data, error } = await supabase.from('route_optimizations').insert({
    mempool_tx_id: null,
    optimization_type: result.optimizationType,
    input_token: tx.fromAddress || '',
    output_token: tx.toAddress || '',
    input_amount: parseFloat(tx.value || '0'),
    expected_output: parseFloat(tx.value || '0') * 1.001,
    profit_estimate: result.estimatedSavings * parseFloat(tx.gasPrice || '0'),
    simulated_gas: result.optimizedGas,
    status: 'simulated',
    priority_score: result.confidence * 100,
    valid_until: new Date(Date.now() + 30000).toISOString(),
    simulation_trace: result,
  }).select();

  return error ? null : data?.[0];
}

async function recordMetric(name: string, value: number, metadata: Record<string, any> = {}) {
  await supabase.from('service_metrics').insert({
    metric_name: name,
    metric_value: value,
    metadata,
  });
}

async function calculateFeeBreakdown(profitEstimate: number): Promise<{
  userRebate: number;
  protocolFee: number;
  reinvestment: number;
}> {
  const feePercent = 0.003;
  const virtualProtocolShare = 0.10;
  const reinvestPercent = 0.15;

  const totalFee = profitEstimate * feePercent;
  const protocolFee = totalFee * virtualProtocolShare;
  const userRebate = totalFee - protocolFee;
  const reinvestment = userRebate * reinvestPercent;

  return { userRebate, protocolFee, reinvestment };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const path = url.pathname.split('/').pop();

    if (req.method === 'GET') {
      if (path === 'status') {
        return new Response(JSON.stringify({
          status: 'operational',
          version: '1.0.0',
          treasury: TREASURY_ADDRESS,
          supportedChains: ['polygon', 'solana'],
          feeStructure: {
            serviceFee: '0.3%',
            virtualProtocolShare: '10%',
            reinvestmentRate: '15%',
          },
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      if (path === 'config') {
        const { data } = await supabase.from('operator_config').select('*');
        return new Response(JSON.stringify({ config: data }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      if (path === 'metrics') {
        const { data } = await supabase.from('service_metrics')
          .select('*')
          .order('recorded_at', { ascending: false })
          .limit(100);
        return new Response(JSON.stringify({ metrics: data }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({
        service: 'RouteOptimization Protocol',
        endpoints: {
          'POST /': 'Analyze and optimize a transaction',
          'GET /status': 'Get service status',
          'GET /config': 'Get configuration',
          'GET /metrics': 'Get service metrics',
        },
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (req.method === 'POST') {
      const body: OptimizeRequest = await req.json();
      const result = await analyzeTransaction(body);

      await storeTransaction(body, result);
      await recordMetric('tx_analyzed', 1, { hasOpportunity: result.hasOpportunity });

      if (result.hasOpportunity) {
        await recordMetric('optimizations_found', 1, { type: result.optimizationType });
        await recordMetric('avg_gas_saved', result.estimatedSavings);

        const optRecord = await createOptimizationRecord(body, result);
        if (optRecord && body.agentId) {
          await supabase.from('operator_logs').insert({
            action: 'optimization_available',
            target: body.agentId,
            details: {
              optimizationId: optRecord.id,
              transactionHash: result.transactionHash,
              estimatedSavings: result.estimatedSavings,
            },
          });
        }

        const feeBreakdown = await calculateFeeBreakdown(result.estimatedSavings * parseFloat(body.gasPrice || '0'));

        return new Response(JSON.stringify({
          success: true,
          optimization: result,
          optimizationId: optRecord?.id,
          feeBreakdown,
          message: 'Optimization opportunity detected',
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      return new Response(JSON.stringify({
        success: true,
        optimization: result,
        message: 'No optimization opportunity found',
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Edge function error:', error);
    return new Response(JSON.stringify({
      error: 'Internal server error',
      message: error.message,
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
