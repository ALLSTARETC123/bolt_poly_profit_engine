/*
# Add INSERT and UPDATE RLS policies to operator_config

## Summary
The `operator_config` table currently has RLS enabled with two SELECT policies
(`public_select_operator_config` for anon, `select_config_authenticated` for
authenticated) but no INSERT or UPDATE policies. This means authenticated
users cannot create or modify operator configuration rows.

## Changes
1. Security (RLS)
   - Add `insert_config_authenticated` policy: allows the `authenticated` role
     to INSERT new rows into `operator_config`.
   - Add `update_config_authenticated` policy: allows the `authenticated` role
     to UPDATE existing rows in `operator_config`.
   - Both policies use `TO authenticated` with `WITH CHECK (true)` since
     `operator_config` is a shared configuration table — any authenticated
     operator may write configuration entries. This is the intended access
     model for a shared config store (not per-user owned data).

## Tables affected
- `public.operator_config` (no schema changes, policies only)

## Important notes
1. No columns are added, removed, or modified — this is a policy-only migration.
2. Existing SELECT policies are untouched.
3. The migration is idempotent: policies are dropped before creation.
*/

DROP POLICY IF EXISTS "insert_config_authenticated" ON operator_config;
CREATE POLICY "insert_config_authenticated"
ON operator_config FOR INSERT
TO authenticated
WITH CHECK (true);

DROP POLICY IF EXISTS "update_config_authenticated" ON operator_config;
CREATE POLICY "update_config_authenticated"
ON operator_config FOR UPDATE
TO authenticated
USING (true) WITH CHECK (true);
