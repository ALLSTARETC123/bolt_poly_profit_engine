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

const FREE_TIER_DELAY_MIN = 5;
const PREMIUM_PRICE_FET = 0.5;
const FREE_MAX_RESULTS = 10;
const PREMIUM_MAX_RESULTS = 100;

interface SignalQueryRequest {
  signal_type?: string;
  tier?: 'free' | 'premium';
  max_results?: number;
  subscriber_address?: string;
  payment_ref?: string;
}

interface WithdrawalRequest {
  destination_address: string;
  amount_fet: number;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const path = url.pathname.split('/').pop();

    // GET /status — agent service status
    if (req.method === 'GET' && path === 'status') {
      const { data: config } = await supabase.from('agent_config').select('*');
      const getConfig = (key: string) => config?.find(c => c.key === key)?.value;

      const { count: subscriberCount } = await supabase
        .from('agent_subscribers')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'active');

      const { count: totalQueries } = await supabase
        .from('signal_requests')
        .select('*', { count: 'exact', head: true });

      const { data: revenueData } = await supabase
        .from('agent_revenue')
        .select('amount_fet')
        .eq('status', 'confirmed');

      const totalRevenue = revenueData?.reduce((sum, r) => sum + parseFloat(r.amount_fet?.toString() || '0'), 0) || 0;

      // Wallet info
      const { data: wallet } = await supabase
        .from('agent_wallet')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      // Check if agent is online (heartbeat within last 2 minutes)
      const heartbeatVal = getConfig('last_heartbeat');
      let agentOnline = false;
      let lastHeartbeat = null;
      if (heartbeatVal && typeof heartbeatVal === 'object') {
        const ts = (heartbeatVal as any).timestamp;
        if (ts) {
          lastHeartbeat = ts;
          agentOnline = (Date.now() - new Date(ts).getTime()) < 120000;
        }
      }

      return new Response(JSON.stringify({
        service: 'Polygon Mempool Signal Agent',
        status: 'operational',
        agent_address: getConfig('agent_address') || 'pending_registration',
        wallet_address: wallet?.wallet_address || getConfig('wallet_address') || '',
        wallet_balance_fet: wallet ? parseFloat(wallet.balance_fet?.toString() || '0') : 0,
        wallet_network: wallet?.network || getConfig('network') || 'mainnet',
        almanac_registered: getConfig('almanac_registered') === true || getConfig('almanac_registered') === 'true',
        agent_online: agentOnline,
        last_heartbeat: lastHeartbeat,
        active_subscribers: subscriberCount || 0,
        total_queries: totalQueries || 0,
        total_revenue_fet: totalRevenue.toFixed(4),
        pricing: {
          free: { delay_minutes: FREE_TIER_DELAY_MIN, max_results: FREE_MAX_RESULTS, price_fet: 0 },
          premium: { delay_minutes: 0, max_results: PREMIUM_MAX_RESULTS, price_fet: PREMIUM_PRICE_FET },
        },
        capabilities: ['gas_overpayment', 'route_inefficiency', 'dex_swap', 'all'],
        network: 'Fetch.ai',
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // GET /wallet — wallet details
    if (req.method === 'GET' && path === 'wallet') {
      const { data: wallet } = await supabase
        .from('agent_wallet')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      const { data: transactions } = await supabase
        .from('wallet_transactions')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50);

      const { data: withdrawals } = await supabase
        .from('withdrawal_requests')
        .select('*')
        .order('requested_at', { ascending: false })
        .limit(20);

      return new Response(JSON.stringify({
        wallet: wallet || null,
        transactions: transactions || [],
        withdrawals: withdrawals || [],
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // POST /withdraw — create a withdrawal request
    if (req.method === 'POST' && path === 'withdraw') {
      const body: WithdrawalRequest = await req.json();

      if (!body.destination_address || !body.destination_address.startsWith('fetch1')) {
        return new Response(JSON.stringify({
          error: 'Invalid destination address. Must be a Fetch.ai mainnet address (starts with fetch1).',
        }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      if (!body.amount_fet || body.amount_fet <= 0) {
        return new Response(JSON.stringify({
          error: 'Amount must be greater than 0.',
        }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      // Check wallet balance
      const { data: wallet } = await supabase
        .from('agent_wallet')
        .select('balance_fet, wallet_address')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!wallet) {
        return new Response(JSON.stringify({
          error: 'Agent wallet not found. Start the uAgent first to initialize the wallet.',
        }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      const balance = parseFloat(wallet.balance_fet?.toString() || '0');
      if (body.amount_fet > balance) {
        return new Response(JSON.stringify({
          error: `Insufficient balance. Wallet has ${balance.toFixed(4)} FET, requested ${body.amount_fet} FET.`,
          balance: balance,
        }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      // Create withdrawal request
      const { data: withdrawal, error } = await supabase
        .from('withdrawal_requests')
        .insert({
          destination_address: body.destination_address,
          amount_fet: body.amount_fet,
          status: 'pending',
        })
        .select()
        .single();

      if (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      return new Response(JSON.stringify({
        success: true,
        withdrawal_id: withdrawal.id,
        message: 'Withdrawal request created. The uAgent will process it within 30 seconds.',
        amount_fet: body.amount_fet,
        destination: body.destination_address,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // GET /subscribers
    if (req.method === 'GET' && path === 'subscribers') {
      const { data, error } = await supabase
        .from('agent_subscribers')
        .select('*')
        .order('joined_at', { ascending: false });

      if (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      return new Response(JSON.stringify({ subscribers: data, count: data?.length || 0 }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // GET /revenue
    if (req.method === 'GET' && path === 'revenue') {
      const { data, error } = await supabase
        .from('agent_revenue')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100);

      if (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      const totalFet = data?.reduce((sum, r) => sum + parseFloat(r.amount_fet?.toString() || '0'), 0) || 0;
      const confirmedCount = data?.filter(r => r.status === 'confirmed').length || 0;

      return new Response(JSON.stringify({
        payments: data,
        total_payments: data?.length || 0,
        confirmed_payments: confirmedCount,
        total_revenue_fet: totalFet.toFixed(4),
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // GET /requests
    if (req.method === 'GET' && path === 'requests') {
      const { data, error } = await supabase
        .from('signal_requests')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50);

      if (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      return new Response(JSON.stringify({ requests: data, count: data?.length || 0 }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // GET /signals
    if (req.method === 'GET' && path === 'signals') {
      const signalType = url.searchParams.get('signal_type') || 'all';
      const tier = (url.searchParams.get('tier') || 'free') as 'free' | 'premium';
      const maxResults = parseInt(url.searchParams.get('max_results') || '10');
      const effectiveMax = Math.min(maxResults, tier === 'premium' ? PREMIUM_MAX_RESULTS : FREE_MAX_RESULTS);

      let query = supabase
        .from('mempool_transactions')
        .select('transaction_hash,from_address,to_address,gas_price,gas_limit,data,route_opportunity,first_seen_at')
        .not('route_opportunity', 'is', null)
        .order('first_seen_at', { ascending: false })
        .limit(effectiveMax);

      if (tier === 'free') {
        const cutoff = new Date(Date.now() - FREE_TIER_DELAY_MIN * 60 * 1000).toISOString();
        query = query.lte('first_seen_at', cutoff);
      }

      const { data: txData, error: txError } = await query;

      if (txError) {
        return new Response(JSON.stringify({ error: txError.message }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      let signals = (txData || []).map(row => {
        const opp = row.route_opportunity || {};
        return {
          tx_hash: row.transaction_hash,
          from: row.from_address,
          to: row.to_address,
          gas_price_gwei: round(parseInt(row.gas_price || '0') / 1e9, 2),
          gas_limit: parseInt(row.gas_limit || '0'),
          dex: opp.dex || '',
          function: opp.functionName || '',
          signal_type: opp.type || '',
          gas_saved: opp.gasSaved || 0,
          confidence: opp.confidence || 0,
          reason: opp.reason || '',
          detected_at: row.first_seen_at,
        };
      });

      if (signalType !== 'all') {
        signals = signals.filter(s => {
          if (signalType === 'gas_overpayment') return s.signal_type === 'gas_reduction';
          if (signalType === 'route_inefficiency') return s.signal_type === 'route_optimization';
          if (signalType === 'dex_swap') return !!s.dex;
          return true;
        });
      }

      return new Response(JSON.stringify({
        signals,
        count: signals.length,
        tier,
        price_fet: tier === 'premium' ? PREMIUM_PRICE_FET : 0,
        timestamp: new Date().toISOString(),
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // POST / — signal query
    if (req.method === 'POST' && path !== 'withdraw') {
      const body: SignalQueryRequest = await req.json();
      const signalType = body.signal_type || 'all';
      const tier = body.tier || 'free';
      const subscriberAddress = body.subscriber_address || 'unknown';
      const maxResults = Math.min(body.max_results || 10,
        tier === 'premium' ? PREMIUM_MAX_RESULTS : FREE_MAX_RESULTS);

      const startTime = Date.now();

      let query = supabase
        .from('mempool_transactions')
        .select('transaction_hash,from_address,to_address,gas_price,gas_limit,data,route_opportunity,first_seen_at')
        .not('route_opportunity', 'is', null)
        .order('first_seen_at', { ascending: false })
        .limit(maxResults);

      if (tier === 'free') {
        const cutoff = new Date(Date.now() - FREE_TIER_DELAY_MIN * 60 * 1000).toISOString();
        query = query.lte('first_seen_at', cutoff);
      }

      const { data: txData } = await query;

      let signals = (txData || []).map(row => {
        const opp = row.route_opportunity || {};
        return {
          tx_hash: row.transaction_hash,
          from: row.from_address,
          to: row.to_address,
          gas_price_gwei: round(parseInt(row.gas_price || '0') / 1e9, 2),
          gas_limit: parseInt(row.gas_limit || '0'),
          dex: opp.dex || '',
          function: opp.functionName || '',
          signal_type: opp.type || '',
          gas_saved: opp.gasSaved || 0,
          confidence: opp.confidence || 0,
          reason: opp.reason || '',
          detected_at: row.first_seen_at,
        };
      });

      if (signalType !== 'all') {
        signals = signals.filter(s => {
          if (signalType === 'gas_overpayment') return s.signal_type === 'gas_reduction';
          if (signalType === 'route_inefficiency') return s.signal_type === 'route_optimization';
          if (signalType === 'dex_swap') return !!s.dex;
          return true;
        });
      }

      const latencyMs = Date.now() - startTime;
      const priceFet = tier === 'premium' ? PREMIUM_PRICE_FET : 0;
      const paymentStatus = tier === 'premium' ? (body.payment_ref ? 'paid' : 'pending') : 'free';

      const { data: reqRecord } = await supabase.from('signal_requests').insert({
        subscriber_address: subscriberAddress,
        signal_type: signalType,
        tier,
        result_count: signals.length,
        latency_ms: latencyMs,
        payment_amount: priceFet,
        payment_status: paymentStatus,
        payment_tx_hash: body.payment_ref || null,
      }).select();

      const { data: existingSub } = await supabase
        .from('agent_subscribers')
        .select('id,total_queries,total_fet_paid')
        .eq('subscriber_address', subscriberAddress)
        .maybeSingle();

      if (existingSub) {
        await supabase.from('agent_subscribers').update({
          last_query_at: new Date().toISOString(),
          total_queries: (existingSub.total_queries || 0) + 1,
          total_fet_paid: parseFloat(existingSub.total_fet_paid?.toString() || '0') + priceFet,
          tier,
          status: 'active',
        }).eq('id', existingSub.id);
      } else {
        await supabase.from('agent_subscribers').insert({
          subscriber_address: subscriberAddress,
          tier,
          status: 'active',
          total_queries: 1,
          total_fet_paid: priceFet,
        });
      }

      if (tier === 'premium' && paymentStatus === 'paid') {
        await supabase.from('agent_revenue').insert({
          subscriber_address: subscriberAddress,
          amount_fet: priceFet,
          signal_request_id: reqRecord?.[0]?.id || null,
          tx_hash: body.payment_ref || null,
          status: 'confirmed',
        });
      }

      return new Response(JSON.stringify({
        signals,
        count: signals.length,
        tier,
        price_fet: priceFet,
        payment_required: tier === 'premium',
        request_id: reqRecord?.[0]?.id || null,
        timestamp: new Date().toISOString(),
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Default
    return new Response(JSON.stringify({
      service: 'Polygon Mempool Signal Agent — Signal Marketplace API',
      endpoints: {
        'GET /status': 'Agent service status, wallet, and capabilities',
        'GET /wallet': 'Wallet details, transactions, and withdrawals',
        'GET /signals': 'Fetch signals (query: signal_type, tier, max_results)',
        'GET /subscribers': 'List all agent subscribers',
        'GET /revenue': 'Revenue ledger',
        'GET /requests': 'Recent signal requests',
        'POST /': 'Query signals (body: signal_type, tier, subscriber_address, payment_ref)',
        'POST /withdraw': 'Create withdrawal request (body: destination_address, amount_fet)',
      },
      pricing: {
        free: { delay_min: FREE_TIER_DELAY_MIN, max_results: FREE_MAX_RESULTS, price_fet: 0 },
        premium: { delay_min: 0, max_results: PREMIUM_MAX_RESULTS, price_fet: PREMIUM_PRICE_FET },
      },
      network: 'Fetch.ai',
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error('Signal marketplace error:', error);
    return new Response(JSON.stringify({
      error: 'Internal server error',
      message: error.message,
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

function round(n: number, decimals: number): number {
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}
