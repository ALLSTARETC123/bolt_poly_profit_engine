# Polygon Mempool Signal Agent

A Fetch.ai uAgent that sells Polygon DEX mempool signals to other autonomous agents on the Fetch.ai network. Manages its own on-chain wallet, accepts FET payments, and processes withdrawals.

## How It Works

1. **Discovery**: The agent registers on the Fetch.ai Almanac contract on startup. Other agents discover it by searching for capabilities like "mempool", "polygon", or "signals". No marketing needed.

2. **Signal Service**: When another agent sends a `SignalRequest` message, this agent queries Supabase for recent Polygon mempool transactions with optimization opportunities and returns them.

3. **Wallet**: The agent has a real Fetch.ai mainnet wallet (`fetch1...` address). It checks its on-chain balance every 30 seconds and syncs it to the dashboard. It also processes withdrawal requests initiated from the dashboard.

4. **Revenue**: Premium tier queries cost 0.5 FET per request. Payments are settled on the Fetch.ai chain. Free tier (5-min delayed signals) is free to attract agents.

## Setup

```bash
pip install -r requirements.txt
```

## Quick Start

```bash
# 1. Generate the agent .env from your project's .env
python agent/generate_env.py

# 2. Run the agent
cd agent
source .env
python mempool_signal_agent.py
```

## Environment Variables

The `generate_env.py` script reads your project's `.env` and creates `agent/.env` automatically. You need:

- `SUPABASE_URL` — Your Supabase project URL (from `.env`)
- `SUPABASE_ANON_KEY` — Your anon key (from `.env`)
- `AGENT_SEED` — A seed phrase that generates the agent's wallet. Change this to create a unique agent identity.

The agent only needs `SUPABASE_URL` and `SUPABASE_ANON_KEY` for reading signals. The edge function handles all writes with the service role key.

## Funding the Wallet (Mainnet Seed Capital)

1. Buy FET on [Coinbase](https://www.coinbase.com/price/fetch-ai) or [Binance](https://www.binance.com/en/trade/FET_USDT)
2. Withdraw FET to the **Fetch.ai mainnet** network (not ERC-20)
3. Paste your agent's wallet address (shown in the dashboard Wallet tab)
4. The agent needs ~1 FET for Almanac registration gas. The rest is revenue you can withdraw.

If your exchange only supports ERC-20 FET, use the [Fetch.ai Token Bridge](https://token-bridge.fetch.ai/) to convert to native FET.

## Withdrawing Revenue

1. Go to the Wallet tab in the dashboard
2. Click "Withdraw FET"
3. Enter a destination `fetch1...` address and amount
4. The agent processes the withdrawal on-chain within 30 seconds

## Testnet vs Mainnet

By default, the agent runs on mainnet. To use testnet (free registration, no real tokens):
```bash
export USE_TESTNET=true
```

## Agent Address

The agent's address and wallet address are printed on startup and shown in the dashboard.
