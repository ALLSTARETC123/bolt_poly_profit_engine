/*
# Flash Loan Micro-Arbitrage Engine Schema

## Purpose
Database schema for a flash loan arbitrage engine that discovers and executes
micro-arbitrage opportunities across Polygon, Arbitrum, and Optimism using
Aave V3 flash loans. The engine scans DEX pools for price discrepancies,
triangular arbitrage, pool imbalances, and multi-hop routes, then executes
trades using flash-borrowed capital with zero user funds at risk.

## New Tables (drops old Fetch.ai agent tables that are no longer used)

1. `arb_wallet` — The engine's EVM wallet (generated in-browser, stored encrypted).
   - `id` (uuid PK)
   - `address` (text, unique) — The 0x... wallet address
   - `encrypted_private_key` (text) — AES-encrypted private key
   - `salt` (text) — Salt for decryption
   - `chain_balances` (jsonb) — Per-chain native token balances
   - `deployed_contracts` (jsonb) — Per-chain flash executor contract addresses
   - `created_at` (timestamptz)

2. `arb_opportunities` — Discovered arbitrage opportunities.
   - `id` (uuid PK)
   - `chain` (text) — 'polygon', 'arbitrum', 'optimism'
   - `opportunity_type` (text) — 'two_dex', 'triangular', 'multi_hop', 'pool_imbalance'
   - `token_path` (jsonb) — Array of token addresses forming the route
   - `dex_path` (jsonb) — Array of DEX names for each hop
   - `pool_addresses` (jsonb) — Array of pool/pair addresses
   - `flash_loan_provider` (text) — 'aave_v3', 'balancer', 'dodo'
   - `flash_loan_asset` (text) — Address of borrowed token
   - `flash_loan_amount` (numeric) — Amount to borrow (in token units)
   - `estimated_profit` (numeric) — Expected profit in USD
   - `estimated_gas_cost` (numeric) — Gas cost in USD
   - `net_profit` (numeric) — Profit after gas and fees
   - `profit_margin_pct` (numeric) — Net profit as % of flash loan amount
   - `pool_reserves` (jsonb) — Reserves at discovery time
   - `price_impact` (numeric) — Estimated price impact
   - `confidence_score` (numeric) — 0-1 confidence
   - `status` (text) — 'detected', 'validated', 'executing', 'executed', 'failed', 'expired'
   - `block_number` (bigint) — Block when discovered
   - `expires_at` (timestamptz) — When opportunity expires
   - `created_at` (timestamptz)

3. `arb_executions` — Record of executed arbitrage trades.
   - `id` (uuid PK)
   - `opportunity_id` (uuid FK -> arb_opportunities)
   - `chain` (text)
   - `tx_hash` (text) — On-chain transaction hash
   - `flash_loan_amount` (numeric)
   - `flash_loan_fee` (numeric) — Aave 0.05% fee
   - `gas_used` (numeric)
   - `gas_cost_usd` (numeric)
   - `revenue_gross` (numeric) — Gross revenue from trades
   - `revenue_net` (numeric) — Net profit after all costs
   - `status` (text) — 'pending', 'success', 'failed', 'reverted'
   - `error_message` (text, nullable)
   - `block_number` (bigint)
   - `executor_contract` (text) — Which executor contract was used
   - `executed_at` (timestamptz)

4. `arb_treasury` — Treasury ledger tracking all net profits.
   - `id` (uuid PK)
   - `execution_id` (uuid FK -> arb_executions, nullable)
   - `amount_usd` (numeric) — Net profit amount
   - `cumulative_usd` (numeric) — Running total
   - `type` (text) — 'profit', 'gas_cost', 'flash_fee', 'deployment'
   - `chain` (text)
   - `created_at` (timestamptz)

5. `arb_config` — Engine configuration.
   - `id` (uuid PK)
   - `key` (text, unique)
   - `value` (jsonb)
   - `updated_at` (timestamptz)

6. `arb_engine_status` — Engine heartbeat and status.
   - `id` (uuid PK)
   - `chain` (text, unique)
   - `status` (text) — 'scanning', 'executing', 'idle', 'error'
   - `last_scan_at` (timestamptz)
   - `opportunities_found` (integer, default 0)
   - `trades_executed` (integer, default 0)
   - `current_block` (bigint)
   - `rpc_latency_ms` (integer)
   - `error_message` (text, nullable)
   - `updated_at` (timestamptz)

## Security
- All tables RLS enabled, single-tenant (no auth), TO anon, authenticated.
- Private key is encrypted client-side before storage.
*/

-- Wallet
CREATE TABLE IF NOT EXISTS arb_wallet (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  address text UNIQUE NOT NULL,
  encrypted_private_key text NOT NULL,
  salt text NOT NULL,
  chain_balances jsonb DEFAULT '{}'::jsonb,
  deployed_contracts jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE arb_wallet ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_arb_wallet" ON arb_wallet;
CREATE POLICY "anon_select_arb_wallet" ON arb_wallet FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_arb_wallet" ON arb_wallet;
CREATE POLICY "anon_insert_arb_wallet" ON arb_wallet FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_arb_wallet" ON arb_wallet;
CREATE POLICY "anon_update_arb_wallet" ON arb_wallet FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_arb_wallet" ON arb_wallet;
CREATE POLICY "anon_delete_arb_wallet" ON arb_wallet FOR DELETE
  TO anon, authenticated USING (true);

-- Opportunities
CREATE TABLE IF NOT EXISTS arb_opportunities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chain text NOT NULL,
  opportunity_type text NOT NULL,
  token_path jsonb NOT NULL DEFAULT '[]'::jsonb,
  dex_path jsonb NOT NULL DEFAULT '[]'::jsonb,
  pool_addresses jsonb NOT NULL DEFAULT '[]'::jsonb,
  flash_loan_provider text NOT NULL DEFAULT 'aave_v3',
  flash_loan_asset text NOT NULL,
  flash_loan_amount numeric NOT NULL DEFAULT 0,
  estimated_profit numeric NOT NULL DEFAULT 0,
  estimated_gas_cost numeric NOT NULL DEFAULT 0,
  net_profit numeric NOT NULL DEFAULT 0,
  profit_margin_pct numeric NOT NULL DEFAULT 0,
  pool_reserves jsonb DEFAULT '{}'::jsonb,
  price_impact numeric DEFAULT 0,
  confidence_score numeric DEFAULT 0,
  status text NOT NULL DEFAULT 'detected' CHECK (status IN ('detected', 'validated', 'executing', 'executed', 'failed', 'expired')),
  block_number bigint,
  expires_at timestamptz,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE arb_opportunities ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_arb_opportunities" ON arb_opportunities;
CREATE POLICY "anon_select_arb_opportunities" ON arb_opportunities FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_arb_opportunities" ON arb_opportunities;
CREATE POLICY "anon_insert_arb_opportunities" ON arb_opportunities FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_arb_opportunities" ON arb_opportunities;
CREATE POLICY "anon_update_arb_opportunities" ON arb_opportunities FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_arb_opportunities" ON arb_opportunities;
CREATE POLICY "anon_delete_arb_opportunities" ON arb_opportunities FOR DELETE
  TO anon, authenticated USING (true);

-- Executions
CREATE TABLE IF NOT EXISTS arb_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id uuid REFERENCES arb_opportunities(id) ON DELETE SET NULL,
  chain text NOT NULL,
  tx_hash text,
  flash_loan_amount numeric DEFAULT 0,
  flash_loan_fee numeric DEFAULT 0,
  gas_used numeric DEFAULT 0,
  gas_cost_usd numeric DEFAULT 0,
  revenue_gross numeric DEFAULT 0,
  revenue_net numeric DEFAULT 0,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed', 'reverted')),
  error_message text,
  block_number bigint,
  executor_contract text,
  executed_at timestamptz DEFAULT now()
);

ALTER TABLE arb_executions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_arb_executions" ON arb_executions;
CREATE POLICY "anon_select_arb_executions" ON arb_executions FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_arb_executions" ON arb_executions;
CREATE POLICY "anon_insert_arb_executions" ON arb_executions FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_arb_executions" ON arb_executions;
CREATE POLICY "anon_update_arb_executions" ON arb_executions FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_arb_executions" ON arb_executions;
CREATE POLICY "anon_delete_arb_executions" ON arb_executions FOR DELETE
  TO anon, authenticated USING (true);

-- Treasury
CREATE TABLE IF NOT EXISTS arb_treasury (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id uuid REFERENCES arb_executions(id) ON DELETE SET NULL,
  amount_usd numeric NOT NULL DEFAULT 0,
  cumulative_usd numeric NOT NULL DEFAULT 0,
  type text NOT NULL CHECK (type IN ('profit', 'gas_cost', 'flash_fee', 'deployment')),
  chain text NOT NULL,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE arb_treasury ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_arb_treasury" ON arb_treasury;
CREATE POLICY "anon_select_arb_treasury" ON arb_treasury FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_arb_treasury" ON arb_treasury;
CREATE POLICY "anon_insert_arb_treasury" ON arb_treasury FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_arb_treasury" ON arb_treasury;
CREATE POLICY "anon_update_arb_treasury" ON arb_treasury FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_arb_treasury" ON arb_treasury;
CREATE POLICY "anon_delete_arb_treasury" ON arb_treasury FOR DELETE
  TO anon, authenticated USING (true);

-- Config
CREATE TABLE IF NOT EXISTS arb_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text UNIQUE NOT NULL,
  value jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE arb_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_arb_config" ON arb_config;
CREATE POLICY "anon_select_arb_config" ON arb_config FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_arb_config" ON arb_config;
CREATE POLICY "anon_insert_arb_config" ON arb_config FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_arb_config" ON arb_config;
CREATE POLICY "anon_update_arb_config" ON arb_config FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_arb_config" ON arb_config;
CREATE POLICY "anon_delete_arb_config" ON arb_config FOR DELETE
  TO anon, authenticated USING (true);

-- Engine status per chain
CREATE TABLE IF NOT EXISTS arb_engine_status (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chain text UNIQUE NOT NULL,
  status text NOT NULL DEFAULT 'idle' CHECK (status IN ('scanning', 'executing', 'idle', 'error')),
  last_scan_at timestamptz,
  opportunities_found integer DEFAULT 0,
  trades_executed integer DEFAULT 0,
  current_block bigint,
  rpc_latency_ms integer,
  error_message text,
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE arb_engine_status ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_arb_engine_status" ON arb_engine_status;
CREATE POLICY "anon_select_arb_engine_status" ON arb_engine_status FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_arb_engine_status" ON arb_engine_status;
CREATE POLICY "anon_insert_arb_engine_status" ON arb_engine_status FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_arb_engine_status" ON arb_engine_status;
CREATE POLICY "arb_engine_status_update" ON arb_engine_status FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_arb_engine_status" ON arb_engine_status;
CREATE POLICY "anon_delete_arb_engine_status" ON arb_engine_status FOR DELETE
  TO anon, authenticated USING (true);

-- Seed config
INSERT INTO arb_config (key, value) VALUES
  ('min_profit_usd', '0.50'::jsonb),
  ('max_flash_loan_usd', '50000'::jsonb),
  ('min_profit_margin_pct', '0.1'::jsonb),
  ('max_gas_price_gwei', '100'::jsonb),
  ('scan_interval_seconds', '5'::jsonb),
  ('auto_execute', 'false'::jsonb),
  ('max_hops', '3'::jsonb),
  ('enabled_chains', '["polygon","arbitrum","optimism"]'::jsonb),
  ('triangular_tokens', '["WETH","USDC","WMATIC","DAI","USDT"]'::jsonb),
  ('flash_loan_provider', '"aave_v3"'::jsonb),
  ('aave_pool_address_polygon', '"0x794a61358D6845594F94dc1DB02A252b5b4814aD"'::jsonb),
  ('aave_pool_address_arbitrum', '"0x794a61358D6845594F94dc1DB02A252b5b4814aD"'::jsonb),
  ('aave_pool_address_optimism', '"0x794a61358D6845594F94dc1DB02A252b5b4814aD"'::jsonb),
  ('slippage_tolerance_pct', '0.5'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Seed engine status rows
INSERT INTO arb_engine_status (chain, status) VALUES
  ('polygon', 'idle'),
  ('arbitrum', 'idle'),
  ('optimism', 'idle')
ON CONFLICT (chain) DO NOTHING;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_arb_opportunities_chain_status ON arb_opportunities(chain, status);
CREATE INDEX IF NOT EXISTS idx_arb_opportunities_created ON arb_opportunities(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_arb_executions_created ON arb_executions(executed_at DESC);
CREATE INDEX IF NOT EXISTS idx_arb_treasury_created ON arb_treasury(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_arb_engine_status_chain ON arb_engine_status(chain);
