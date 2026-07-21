/*
# Create wallet and treasury tables for Flash Arb Engine

1. New Tables
- `arb_wallet`: Stores the encrypted wallet (address, encrypted private key, salt, chain balances, deployed contracts)
- `arb_treasury`: Records profit/loss entries from arbitrage execution
- `arb_opportunities`: Stores scanned arbitrage opportunities for history

2. Security
- Enable RLS on all tables
- Allow anon + authenticated CRUD (single-tenant app, no sign-in screen)
*/

CREATE TABLE IF NOT EXISTS arb_wallet (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  address text NOT NULL,
  encrypted_private_key text NOT NULL,
  salt text NOT NULL,
  chain_balances jsonb DEFAULT '{}',
  deployed_contracts jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);

ALTER TABLE arb_wallet ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_wallet" ON arb_wallet;
CREATE POLICY "anon_select_wallet" ON arb_wallet FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_wallet" ON arb_wallet;
CREATE POLICY "anon_insert_wallet" ON arb_wallet FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_wallet" ON arb_wallet;
CREATE POLICY "anon_update_wallet" ON arb_wallet FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_wallet" ON arb_wallet;
CREATE POLICY "anon_delete_wallet" ON arb_wallet FOR DELETE
  TO anon, authenticated USING (true);

CREATE TABLE IF NOT EXISTS arb_treasury (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL DEFAULT 'profit',
  amount_usd numeric DEFAULT 0,
  chain text,
  token_symbol text,
  tx_hash text,
  opportunity_type text,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE arb_treasury ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_treasury" ON arb_treasury;
CREATE POLICY "anon_select_treasury" ON arb_treasury FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_treasury" ON arb_treasury;
CREATE POLICY "anon_insert_treasury" ON arb_treasury FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_treasury" ON arb_treasury;
CREATE POLICY "anon_update_treasury" ON arb_treasury FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_treasury" ON arb_treasury;
CREATE POLICY "anon_delete_treasury" ON arb_treasury FOR DELETE
  TO anon, authenticated USING (true);

CREATE TABLE IF NOT EXISTS arb_opportunities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chain text NOT NULL,
  opportunity_type text NOT NULL,
  token_path text[] DEFAULT '{}',
  dex_path text[] DEFAULT '{}',
  flash_loan_asset text,
  flash_loan_amount numeric,
  estimated_profit numeric,
  estimated_gas_cost numeric,
  net_profit numeric,
  profit_margin_pct numeric,
  confidence_score numeric,
  flash_provider text DEFAULT 'balancer_v2',
  block_number bigint,
  executed boolean DEFAULT false,
  tx_hash text,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE arb_opportunities ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_opportunities" ON arb_opportunities;
CREATE POLICY "anon_select_opportunities" ON arb_opportunities FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_opportunities" ON arb_opportunities;
CREATE POLICY "anon_insert_opportunities" ON arb_opportunities FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_opportunities" ON arb_opportunities;
CREATE POLICY "anon_update_opportunities" ON arb_opportunities FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_opportunities" ON arb_opportunities;
CREATE POLICY "anon_delete_opportunities" ON arb_opportunities FOR DELETE
  TO anon, authenticated USING (true);

CREATE INDEX IF NOT EXISTS idx_arb_treasury_created ON arb_treasury(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_arb_opportunities_created ON arb_opportunities(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_arb_wallet_address ON arb_wallet(address);
