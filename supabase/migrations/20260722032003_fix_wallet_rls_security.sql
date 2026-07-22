
-- Remove SELECT policies on arb_wallet that expose encrypted private keys
DROP POLICY IF EXISTS "anon_select_arb_wallet" ON arb_wallet;
DROP POLICY IF EXISTS "anon_select_wallet" ON arb_wallet;

-- arb_wallet is now fully locked down - only accessible via service role (edge function)
-- arb_treasury and arb_opportunities remain SELECT-only for anon (non-sensitive data)
