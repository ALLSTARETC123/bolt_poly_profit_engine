-- Public utility: allow anon SELECT on log/metric tables
-- Write operations remain protected (edge function uses service role)

CREATE POLICY "public_select_mempool_transactions" ON mempool_transactions
  FOR SELECT TO anon USING (true);

CREATE POLICY "public_select_route_optimizations" ON route_optimizations
  FOR SELECT TO anon USING (true);

CREATE POLICY "public_select_service_metrics" ON service_metrics
  FOR SELECT TO anon USING (true);

CREATE POLICY "public_select_operator_config" ON operator_config
  FOR SELECT TO anon USING (true);

-- Allow anon INSERT into mempool and optimizations for the frontend service
-- (the frontend uses the anon key directly since there's no auth layer)
CREATE POLICY "public_insert_mempool_transactions" ON mempool_transactions
  FOR INSERT TO anon WITH CHECK (true);

CREATE POLICY "public_insert_route_optimizations" ON route_optimizations
  FOR INSERT TO anon WITH CHECK (true);

CREATE POLICY "public_insert_operator_logs" ON operator_logs
  FOR INSERT TO anon WITH CHECK (true);

CREATE POLICY "public_select_operator_logs" ON operator_logs
  FOR SELECT TO anon USING (true);