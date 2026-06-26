ALTER TABLE route_optimizations
DROP CONSTRAINT route_optimizations_optimization_type_check,
ADD CONSTRAINT route_optimizations_optimization_type_check
CHECK (optimization_type = ANY (ARRAY[
  'frontrun'::text, 'backrun'::text, 'sandwich'::text, 'cross_dex_arb'::text, 'liquidation'::text,
  'gas_reduction'::text, 'route_optimization'::text, 'slippage_reduction'::text, 'latency_optimization'::text
]));