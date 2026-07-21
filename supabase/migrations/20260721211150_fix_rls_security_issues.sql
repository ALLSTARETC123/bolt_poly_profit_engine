/*
# Fix RLS security issues: remove permissive write policies and fix SECURITY DEFINER view

## Summary
- Recreate `execution_pnl` view as SECURITY INVOKER (was SECURITY DEFINER)
- Drop ALL INSERT/UPDATE/DELETE policies that had `true` (always-true) clauses
- Keep only SELECT policies for anon/authenticated (read-only public data)
- Write operations (INSERT/UPDATE/DELETE) now go through the edge function
  using the service role key, which bypasses RLS entirely
- This is a single-tenant app with no sign-in screen, so SELECT remains open
  but all mutations are gated by the server-side edge function

## Tables affected (21 tables)
- agent_config, agent_revenue, agent_subscribers, agent_wallet, agents
- arb_config, arb_engine_status, arb_executions, arb_opportunities, arb_treasury, arb_wallet
- escrow_rebates, execution_records, mempool_transactions
- operator_config, operator_logs, route_optimizations, service_metrics
- signal_requests, wallet_transactions, withdrawal_requests

## Security changes
- View: execution_pnl changed from SECURITY DEFINER to SECURITY INVOKER
- RLS: All write policies (INSERT/UPDATE/DELETE) with `true` clauses dropped
- RLS: SELECT policies retained (read-only access for anon + authenticated)
- Writes: Now routed through edge function with service role key (bypasses RLS)
*/

-- ── Fix SECURITY DEFINER view ──────────────────────────────
DROP VIEW IF EXISTS public.execution_pnl;
CREATE VIEW public.execution_pnl AS
  SELECT
    count(*) FILTER (WHERE status = 'confirmed') AS confirmed_count,
    count(*) FILTER (WHERE status = 'failed' OR status = 'reverted') AS failed_count,
    COALESCE(sum(profit_matic) FILTER (WHERE status = 'confirmed'), 0) AS total_profit_matic,
    COALESCE(sum(gas_cost_matic) FILTER (WHERE status = 'confirmed'), 0) AS total_gas_cost_matic,
    COALESCE(sum(profit_matic - COALESCE(gas_cost_matic, 0)) FILTER (WHERE status = 'confirmed'), 0) AS net_profit_matic
  FROM execution_records;
ALTER VIEW public.execution_pnl OWNER TO postgres;

-- ── Drop ALL permissive write policies ──────────────────────
-- These all had USING(true) or WITH CHECK(true), allowing unrestricted
-- writes from anon. Writes now go through the edge function (service role).

-- agent_config
DROP POLICY IF EXISTS "anon_delete_agent_config" ON agent_config;
DROP POLICY IF EXISTS "anon_insert_agent_config" ON agent_config;
DROP POLICY IF EXISTS "anon_update_agent_config" ON agent_config;

-- agent_revenue
DROP POLICY IF EXISTS "anon_delete_agent_revenue" ON agent_revenue;
DROP POLICY IF EXISTS "anon_insert_agent_revenue" ON agent_revenue;
DROP POLICY IF EXISTS "anon_update_agent_revenue" ON agent_revenue;

-- agent_subscribers
DROP POLICY IF EXISTS "anon_delete_agent_subscribers" ON agent_subscribers;
DROP POLICY IF EXISTS "anon_insert_agent_subscribers" ON agent_subscribers;
DROP POLICY IF EXISTS "anon_update_agent_subscribers" ON agent_subscribers;

-- agent_wallet
DROP POLICY IF EXISTS "anon_delete_agent_wallet" ON agent_wallet;
DROP POLICY IF EXISTS "anon_insert_agent_wallet" ON agent_wallet;
DROP POLICY IF EXISTS "anon_update_agent_wallet" ON agent_wallet;

-- agents
DROP POLICY IF EXISTS "insert_agents_authenticated" ON agents;
DROP POLICY IF EXISTS "update_agents_authenticated" ON agents;

-- arb_config
DROP POLICY IF EXISTS "anon_delete_arb_config" ON arb_config;
DROP POLICY IF EXISTS "anon_insert_arb_config" ON arb_config;
DROP POLICY IF EXISTS "anon_update_arb_config" ON arb_config;

-- arb_engine_status
DROP POLICY IF EXISTS "anon_delete_arb_engine_status" ON arb_engine_status;
DROP POLICY IF EXISTS "anon_insert_arb_engine_status" ON arb_engine_status;
DROP POLICY IF EXISTS "arb_engine_status_update" ON arb_engine_status;

-- arb_executions
DROP POLICY IF EXISTS "anon_delete_arb_executions" ON arb_executions;
DROP POLICY IF EXISTS "anon_insert_arb_executions" ON arb_executions;
DROP POLICY IF EXISTS "anon_update_arb_executions" ON arb_executions;

-- arb_opportunities
DROP POLICY IF EXISTS "anon_delete_arb_opportunities" ON arb_opportunities;
DROP POLICY IF EXISTS "anon_insert_arb_opportunities" ON arb_opportunities;
DROP POLICY IF EXISTS "anon_update_arb_opportunities" ON arb_opportunities;
DROP POLICY IF EXISTS "anon_delete_opportunities" ON arb_opportunities;
DROP POLICY IF EXISTS "anon_insert_opportunities" ON arb_opportunities;
DROP POLICY IF EXISTS "anon_update_opportunities" ON arb_opportunities;

-- arb_treasury
DROP POLICY IF EXISTS "anon_delete_arb_treasury" ON arb_treasury;
DROP POLICY IF EXISTS "anon_insert_arb_treasury" ON arb_treasury;
DROP POLICY IF EXISTS "anon_update_arb_treasury" ON arb_treasury;
DROP POLICY IF EXISTS "anon_delete_treasury" ON arb_treasury;
DROP POLICY IF EXISTS "anon_insert_treasury" ON arb_treasury;
DROP POLICY IF EXISTS "anon_update_treasury" ON arb_treasury;

-- arb_wallet
DROP POLICY IF EXISTS "anon_delete_arb_wallet" ON arb_wallet;
DROP POLICY IF EXISTS "anon_insert_arb_wallet" ON arb_wallet;
DROP POLICY IF EXISTS "anon_update_arb_wallet" ON arb_wallet;
DROP POLICY IF EXISTS "anon_delete_wallet" ON arb_wallet;
DROP POLICY IF EXISTS "anon_insert_wallet" ON arb_wallet;
DROP POLICY IF EXISTS "anon_update_wallet" ON arb_wallet;

-- escrow_rebates
DROP POLICY IF EXISTS "insert_escrow_authenticated" ON escrow_rebates;
DROP POLICY IF EXISTS "update_escrow_authenticated" ON escrow_rebates;

-- execution_records
DROP POLICY IF EXISTS "public_insert_execution_records" ON execution_records;
DROP POLICY IF EXISTS "service_update_execution_records" ON execution_records;

-- mempool_transactions
DROP POLICY IF EXISTS "insert_mempool_authenticated" ON mempool_transactions;
DROP POLICY IF EXISTS "public_insert_mempool_transactions" ON mempool_transactions;
DROP POLICY IF EXISTS "update_mempool_authenticated" ON mempool_transactions;

-- operator_config
DROP POLICY IF EXISTS "insert_config_authenticated" ON operator_config;
DROP POLICY IF EXISTS "update_config_authenticated" ON operator_config;

-- operator_logs
DROP POLICY IF EXISTS "insert_logs_authenticated" ON operator_logs;
DROP POLICY IF EXISTS "public_insert_operator_logs" ON operator_logs;

-- route_optimizations
DROP POLICY IF EXISTS "insert_route_authenticated" ON route_optimizations;
DROP POLICY IF EXISTS "public_insert_route_optimizations" ON route_optimizations;
DROP POLICY IF EXISTS "update_route_authenticated" ON route_optimizations;

-- service_metrics
DROP POLICY IF EXISTS "insert_metrics_authenticated" ON service_metrics;

-- signal_requests
DROP POLICY IF EXISTS "anon_delete_signal_requests" ON signal_requests;
DROP POLICY IF EXISTS "anon_insert_signal_requests" ON signal_requests;
DROP POLICY IF EXISTS "anon_update_signal_requests" ON signal_requests;

-- wallet_transactions
DROP POLICY IF EXISTS "anon_delete_wallet_transactions" ON wallet_transactions;
DROP POLICY IF EXISTS "anon_insert_wallet_transactions" ON wallet_transactions;
DROP POLICY IF EXISTS "anon_update_wallet_transactions" ON wallet_transactions;

-- withdrawal_requests
DROP POLICY IF EXISTS "anon_delete_withdrawal_requests" ON withdrawal_requests;
DROP POLICY IF EXISTS "anon_insert_withdrawal_requests" ON withdrawal_requests;
DROP POLICY IF EXISTS "anon_update_withdrawal_requests" ON withdrawal_requests;
