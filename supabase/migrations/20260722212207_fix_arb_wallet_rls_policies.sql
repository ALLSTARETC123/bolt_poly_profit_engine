/*
# Fix arb_wallet RLS — add missing CRUD policies

## Summary
The `arb_wallet` table has RLS enabled but NO policies whatsoever, meaning
no role (not even anon) can read or write to it. This silently breaks all
wallet functionality — wallet creation, loading, and deployed-contract
updates all fail because every query returns zero rows.

## Changes
1. Security (RLS)
   - Add `anon_select_arb_wallet`: SELECT for anon + authenticated (single-tenant app, no auth screen)
   - Add `anon_insert_arb_wallet`: INSERT for anon + authenticated
   - Add `anon_update_arb_wallet`: UPDATE for anon + authenticated (needed for deployed_contracts updates)
   - Add `anon_delete_arb_wallet`: DELETE for anon + authenticated

## Tables affected
- `public.arb_wallet` (policy-only, no schema changes)

## Important notes
1. This is a single-tenant app with no sign-in screen — policies use `TO anon, authenticated`
   so the anon-key frontend client can read/write wallet data.
2. Policies are idempotent (DROP IF EXISTS before CREATE).
*/

DROP POLICY IF EXISTS "anon_select_arb_wallet" ON arb_wallet;
CREATE POLICY "anon_select_arb_wallet"
ON arb_wallet FOR SELECT
TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_arb_wallet" ON arb_wallet;
CREATE POLICY "anon_insert_arb_wallet"
ON arb_wallet FOR INSERT
TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_arb_wallet" ON arb_wallet;
CREATE POLICY "anon_update_arb_wallet"
ON arb_wallet FOR UPDATE
TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_arb_wallet" ON arb_wallet;
CREATE POLICY "anon_delete_arb_wallet"
ON arb_wallet FOR DELETE
TO anon, authenticated USING (true);
