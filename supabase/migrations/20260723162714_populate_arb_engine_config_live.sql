/*
# Populate Arb Engine Tables with Live Configuration

## Summary
Inserts the complete operator_config and arb_config rows for the Flash Arb Engine.
These are the only two configuration tables that need pre-populated rows.
All other tables (arb_opportunities, arb_executions, arb_treasury, arb_engine_status)
will be populated LIVE by the frontend scanner as it runs.

## Tables Populated
- operator_config: 12 config keys for the engine
- arb_config: 13 config keys for arbitrage parameters

## Notes
- Uses ON CONFLICT DO UPDATE to be idempotent
- All values are real configuration for this engine, no simulations
*/

-- Operator config
INSERT INTO operator_config (key, value, description) VALUES
  ('service_name', '"FlashArbEngine"', 'Name of this arbitrage engine service'),
  ('service_enabled', '{"enabled": true}', 'Master switch for the engine'),
  ('flash_loan_provider', '{"provider": "balancer", "fee_pct": 0, "vault_address": "0xBA12222222228d8Ba445958a75a0704d566BF2C8"}', 'Balancer 0% flash loans - zero fee, no collateral'),
  ('gas_relayer', '{"provider": "gelato", "mode": "callWithSyncFee", "fee_source": "profit", "fee_token": "USDC"}', 'Gelato SyncFee - gas paid from profit, zero deposit'),
  ('mev_protection', '{"private_mempool": true, "front_run_protection": true, "sandwich_protection": true}', 'MEV protection via Gelato private mempool'),
  ('monitored_chains', '{"chains": ["polygon", "arbitrum", "optimism", "base"]}', 'Chains actively scanned for arbitrage'),
  ('monitored_tokens', '{"tokens": ["WETH", "USDC", "USDT", "DAI", "WBTC"]}', 'Tokens monitored for cross-DEX arbitrage'),
  ('monitored_dexes', '{"dexes": ["uniswap_v3", "sushiswap", "quickswap", "balancer", "curve"]}', 'DEXs monitored for price discrepancies'),
  ('min_profit_threshold_usd', '{"value": 0.10}', 'Minimum net profit in USD to execute'),
  ('max_flash_loan_amount', '{"value": 500000}', 'Maximum flash loan amount in USD'),
  ('scan_interval_ms', '{"value": 3000}', 'Scan interval in milliseconds'),
  ('auto_execute', '{"enabled": true}', 'Automatically execute profitable opportunities')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, description = EXCLUDED.description, updated_at = now();

-- Arb config
INSERT INTO arb_config (key, value) VALUES
  ('flash_loan_provider', '{"provider": "balancer", "fee_pct": 0, "vault_address": "0xBA12222222228d8Ba445958a75a0704d566BF2C8"}'),
  ('gas_relayer', '{"provider": "gelato", "mode": "callWithSyncFee", "fee_from_profit": true}'),
  ('supported_chains', '{"polygon": 137, "arbitrum": 42161, "optimism": 10, "base": 8453}'),
  ('supported_dexes', '{"uniswap_v3": {"version": 3, "router": "0xE592427A0AEce92De3Edee1F18E0157C05861564", "quoter": "0xb273088f0FF97Be22fAee0586a0E9dD5dF085D77"}, "sushiswap": {"version": 2, "router": "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506"}, "quickswap": {"version": 2, "router": "0xa5E0829CaCED8fFDD4De3c43696c57C7324c41D2"}, "balancer": {"version": 2, "vault": "0xBA12222222228d8Ba445958a75a0704d566BF2C8"}, "curve": {"version": 2, "registry": "0x90E7AC78Bd8f0b1b305d0F3D2900E53732aD30cf"}}'),
  ('token_pairs', '{"pairs": [["WETH", "USDC"], ["WETH", "USDT"], ["WETH", "DAI"], ["WBTC", "WETH"], ["USDC", "USDT"], ["USDC", "DAI"], ["USDT", "DAI"]]}'),
  ('min_profit_usd', '{"value": 0.10}'),
  ('max_flash_loan_usd', '{"value": 500000}'),
  ('scan_interval_ms', '{"value": 3000}'),
  ('auto_execute', '{"enabled": true}'),
  ('mev_protection', '{"private_mempool": true, "front_run": true, "sandwich": true}'),
  ('execution_timeout_ms', '{"value": 30000}'),
  ('max_slippage_bps', '{"value": 50}'),
  ('confidence_threshold', '{"value": 0.7}')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

-- Initialize arb_engine_status rows for each chain
INSERT INTO arb_engine_status (chain, status, opportunities_found, trades_executed)
VALUES
  ('polygon', 'idle', 0, 0),
  ('arbitrum', 'idle', 0, 0),
  ('optimism', 'idle', 0, 0),
  ('base', 'idle', 0, 0)
ON CONFLICT DO NOTHING;
