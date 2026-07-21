/*
# Agent Network Tables for Fetch.ai Signal Marketplace

## Purpose
Creates the database schema for a Fetch.ai uAgent that sells Polygon mempool
signals (DEX swap detection, gas overpayment, route inefficiency) to other
autonomous agents on the Fetch.ai network. Revenue is generated through
agent-to-agent FET token micropayments — no capital, no trading, no wallet
funding required to start.

## New Tables

1. `agent_subscribers` — Tracks autonomous agents that have discovered and
   subscribed to our signal service via the Fetch.ai Almanac registry.
   - `id` (uuid PK)
   - `subscriber_address` (text, unique) — The Fetch.ai network address of the subscribing agent
   - `subscriber_name` (text) — Agent name as registered on Almanac
   - `tier` (text) — 'free' (5-min delayed signals) or 'premium' (real-time)
   - `status` (text) — 'active', 'suspended', 'churned'
   - `joined_at` (timestamptz) — When the agent first queried our service
   - `last_query_at` (timestamptz) — Most recent signal request
   - `total_queries` (integer) — Lifetime signal requests from this agent
   - `total_fet_paid` (numeric) — Lifetime FET tokens paid by this subscriber
   - `metadata` (jsonb) — Additional agent metadata from Almanac

2. `signal_requests` — Log of every signal query from other agents.
   - `id` (uuid PK)
   - `subscriber_address` (text) — Who requested
   - `signal_type` (text) — 'gas_overpayment', 'route_inefficiency', 'dex_swap', 'all'
   - `tier` (text) — 'free' or 'premium'
   - `result_count` (integer) — How many signals were returned
   - `latency_ms` (integer) — Response time
   - `payment_amount` (numeric) — FET charged (0 for free tier)
   - `payment_status` (text) — 'free', 'pending', 'paid', 'failed'
   - `payment_tx_hash` (text, nullable) — On-chain payment tx hash
   - `created_at` (timestamptz)

3. `agent_revenue` — Ledger of all FET token payments received.
   - `id` (uuid PK)
   - `subscriber_address` (text) — Who paid
   - `amount_fet` (numeric) — FET tokens received
   - `usd_value` (numeric) — Approximate USD value at time of payment
   - `signal_request_id` (uuid, nullable FK) — Which signal request triggered the payment
   - `tx_hash` (text) — On-chain transaction hash
   - `block_number` (bigint) — Fetch.ai chain block
   - `status` (text) — 'confirmed', 'pending', 'failed'
   - `created_at` (timestamptz)

4. `agent_config` — Configuration for the uAgent service.
   - `id` (uuid PK)
   - `key` (text, unique) — Config key
   - `value` (jsonb) — Config value
   - `updated_at` (timestamptz)

## Security
- All tables have RLS enabled.
- This is a single-tenant app (no user sign-in) — the dashboard reads/writes
  as the anon key. All policies use `TO anon, authenticated` with `USING (true)`
  because the data is intentionally shared (the agent service is public).
- The edge function uses the service role key to write, bypassing RLS.

## Notes
- The `mempool_transactions` table already exists and stores the raw signal data.
- The uAgent Python script reads from these tables via the Supabase REST API.
- FET payments are settled on the Fetch.ai chain, not on Polygon.
*/

-- Agent subscribers table
CREATE TABLE IF NOT EXISTS agent_subscribers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscriber_address text UNIQUE NOT NULL,
  subscriber_name text DEFAULT '',
  tier text NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'premium')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'churned')),
  joined_at timestamptz DEFAULT now(),
  last_query_at timestamptz,
  total_queries integer DEFAULT 0,
  total_fet_paid numeric DEFAULT 0,
  metadata jsonb DEFAULT '{}'::jsonb
);

ALTER TABLE agent_subscribers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_agent_subscribers" ON agent_subscribers;
CREATE POLICY "anon_select_agent_subscribers" ON agent_subscribers FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_agent_subscribers" ON agent_subscribers;
CREATE POLICY "anon_insert_agent_subscribers" ON agent_subscribers FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_agent_subscribers" ON agent_subscribers;
CREATE POLICY "anon_update_agent_subscribers" ON agent_subscribers FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_agent_subscribers" ON agent_subscribers;
CREATE POLICY "anon_delete_agent_subscribers" ON agent_subscribers FOR DELETE
  TO anon, authenticated USING (true);

-- Signal requests log
CREATE TABLE IF NOT EXISTS signal_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscriber_address text NOT NULL,
  signal_type text NOT NULL DEFAULT 'all',
  tier text NOT NULL DEFAULT 'free',
  result_count integer DEFAULT 0,
  latency_ms integer DEFAULT 0,
  payment_amount numeric DEFAULT 0,
  payment_status text NOT NULL DEFAULT 'free' CHECK (payment_status IN ('free', 'pending', 'paid', 'failed')),
  payment_tx_hash text,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE signal_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_signal_requests" ON signal_requests;
CREATE POLICY "anon_select_signal_requests" ON signal_requests FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_signal_requests" ON signal_requests;
CREATE POLICY "anon_insert_signal_requests" ON signal_requests FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_signal_requests" ON signal_requests;
CREATE POLICY "anon_update_signal_requests" ON signal_requests FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_signal_requests" ON signal_requests;
CREATE POLICY "anon_delete_signal_requests" ON signal_requests FOR DELETE
  TO anon, authenticated USING (true);

-- Revenue ledger
CREATE TABLE IF NOT EXISTS agent_revenue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscriber_address text NOT NULL,
  amount_fet numeric NOT NULL DEFAULT 0,
  usd_value numeric DEFAULT 0,
  signal_request_id uuid REFERENCES signal_requests(id) ON DELETE SET NULL,
  tx_hash text,
  block_number bigint,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('confirmed', 'pending', 'failed')),
  created_at timestamptz DEFAULT now()
);

ALTER TABLE agent_revenue ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_agent_revenue" ON agent_revenue;
CREATE POLICY "anon_select_agent_revenue" ON agent_revenue FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_agent_revenue" ON agent_revenue;
CREATE POLICY "anon_insert_agent_revenue" ON agent_revenue FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_agent_revenue" ON agent_revenue;
CREATE POLICY "anon_update_agent_revenue" ON agent_revenue FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_agent_revenue" ON agent_revenue;
CREATE POLICY "anon_delete_agent_revenue" ON agent_revenue FOR DELETE
  TO anon, authenticated USING (true);

-- Agent configuration
CREATE TABLE IF NOT EXISTS agent_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text UNIQUE NOT NULL,
  value jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE agent_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_agent_config" ON agent_config;
CREATE POLICY "anon_select_agent_config" ON agent_config FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_agent_config" ON agent_config;
CREATE POLICY "anon_insert_agent_config" ON agent_config FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_agent_config" ON agent_config;
CREATE POLICY "anon_update_agent_config" ON agent_config FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_agent_config" ON agent_config;
CREATE POLICY "anon_delete_agent_config" ON agent_config FOR DELETE
  TO anon, authenticated USING (true);

-- Seed default config
INSERT INTO agent_config (key, value) VALUES
  ('agent_name', '"Polygon Mempool Signal Agent"'::jsonb),
  ('agent_description', '"Provides real-time Polygon DEX mempool signals: gas overpayment detection, route inefficiency, and swap identification for autonomous agents."'::jsonb),
  ('free_tier_delay_minutes', '5'::jsonb),
  ('premium_price_per_query_fet', '0.5'::jsonb),
  ('free_tier_max_results', '10'::jsonb),
  ('premium_tier_max_results', '100'::jsonb),
  ('agent_status', '"registered"'::jsonb),
  ('almanac_registered', 'false'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Indexes for query performance
CREATE INDEX IF NOT EXISTS idx_signal_requests_subscriber ON signal_requests(subscriber_address);
CREATE INDEX IF NOT EXISTS idx_signal_requests_created ON signal_requests(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_revenue_created ON agent_revenue(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_subscribers_status ON agent_subscribers(status);
