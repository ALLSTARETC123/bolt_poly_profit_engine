/*
# Drop Irrelevant Tables and Add Write Policies for Arb Engine

## Summary
This migration removes all tables from prior projects (agent network, old route optimization, 
mempool, execution_records, wallet_transactions, withdrawal_requests, service_metrics, 
operator_logs, escrow_rebates) that have nothing to do with the Flash Arb Engine.

It then adds INSERT and UPDATE RLS policies for the anon role on all remaining arb engine 
tables so the frontend can write live scan data, execution records, treasury entries, 
and engine status updates.

## Tables Dropped
- agents, agent_config, agent_subscribers, agent_wallet, agent_revenue, signal_requests
- execution_records (and dependent view execution_pnl)
- mempool_transactions, route_optimizations
- wallet_transactions, withdrawal_requests
- service_metrics, operator_logs
- escrow_rebates

## Tables Kept (Flash Arb Engine only)
- arb_wallet — encrypted wallet storage
- arb_config — engine configuration
- arb_opportunities — live arbitrage opportunities from DEX scanning
- arb_executions — execution records with profit/gas data
- arb_treasury — treasury ledger (profit, gas, flash fees, deploy costs)
- arb_engine_status — per-chain scanner status
- operator_config — operator-level configuration

## Security Changes
- Adds INSERT + UPDATE policies for anon, authenticated on all kept tables
- All data is intentionally public/shared (no-auth single-tenant app)
*/

-- Drop the execution_pnl view first (depends on execution_records)
DROP VIEW IF EXISTS execution_pnl CASCADE;

-- Drop all irrelevant tables
DROP TABLE IF EXISTS agent_revenue CASCADE;
DROP TABLE IF EXISTS signal_requests CASCADE;
DROP TABLE IF EXISTS agent_subscribers CASCADE;
DROP TABLE IF EXISTS agent_wallet CASCADE;
DROP TABLE IF EXISTS agent_config CASCADE;
DROP TABLE IF EXISTS agents CASCADE;
DROP TABLE IF EXISTS escrow_rebates CASCADE;
DROP TABLE IF EXISTS route_optimizations CASCADE;
DROP TABLE IF EXISTS mempool_transactions CASCADE;
DROP TABLE IF EXISTS execution_records CASCADE;
DROP TABLE IF EXISTS wallet_transactions CASCADE;
DROP TABLE IF EXISTS withdrawal_requests CASCADE;
DROP TABLE IF EXISTS service_metrics CASCADE;
DROP TABLE IF EXISTS operator_logs CASCADE;

-- Now add INSERT + UPDATE policies on all remaining arb engine tables

-- arb_opportunities
DROP POLICY IF EXISTS "anon_insert_arb_opportunities" ON arb_opportunities;
CREATE POLICY "anon_insert_arb_opportunities" ON arb_opportunities
  FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_arb_opportunities" ON arb_opportunities;
CREATE POLICY "anon_update_arb_opportunities" ON arb_opportunities
  FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_arb_opportunities" ON arb_opportunities;
CREATE POLICY "anon_delete_arb_opportunities" ON arb_opportunities
  FOR DELETE TO anon, authenticated USING (true);

-- arb_executions
DROP POLICY IF EXISTS "anon_insert_arb_executions" ON arb_executions;
CREATE POLICY "anon_insert_arb_executions" ON arb_executions
  FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_arb_executions" ON arb_executions;
CREATE POLICY "anon_update_arb_executions" ON arb_executions
  FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

-- arb_treasury
DROP POLICY IF EXISTS "anon_insert_arb_treasury" ON arb_treasury;
CREATE POLICY "anon_insert_arb_treasury" ON arb_treasury
  FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_arb_treasury" ON arb_treasury;
CREATE POLICY "anon_update_arb_treasury" ON arb_treasury
  FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

-- arb_engine_status
DROP POLICY IF EXISTS "anon_insert_arb_engine_status" ON arb_engine_status;
CREATE POLICY "anon_insert_arb_engine_status" ON arb_engine_status
  FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_arb_engine_status" ON arb_engine_status;
CREATE POLICY "anon_update_arb_engine_status" ON arb_engine_status
  FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

-- arb_config
DROP POLICY IF EXISTS "anon_insert_arb_config" ON arb_config;
CREATE POLICY "anon_insert_arb_config" ON arb_config
  FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_arb_config" ON arb_config;
CREATE POLICY "anon_update_arb_config" ON arb_config
  FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
