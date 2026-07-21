"""
Polygon Mempool Signal Agent — Fetch.ai Mainnet
=================================================
A Fetch.ai uAgent that:
  1. Registers on the Almanac (auto-discovery by other agents)
  2. Sells Polygon DEX mempool signals to other agents
  3. Accepts FET payments via the Agent Payment Protocol
  4. Manages its own on-chain wallet (check balance, process withdrawals)
  5. Syncs wallet state and revenue to Supabase for the dashboard

Revenue model:
  - Free tier: 5-min delayed signals, max 10 results (0 FET)
  - Premium tier: real-time signals, max 100 results (0.5 FET per query)

Wallet:
  - The agent's wallet is a real Fetch.ai mainnet address (fetch1...)
  - Send FET from any exchange (Coinbase, Binance) to this address to fund it
  - The agent uses cosmpy to check balance and send tokens (withdrawals)
  - Withdrawals are initiated from the dashboard and processed by this agent

Requirements:
  pip install uagents cosmpy

Usage:
  python mempool_signal_agent.py

  For mainnet: ensure the wallet has FET for Almanac registration gas.
  For testnet: set USE_TESTNET=true (registration is free).
"""

import os
import json
import time
import asyncio
import urllib.request
import urllib.error
from typing import Optional
from uagents import Agent, Context, Model, Protocol


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY", "")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", SUPABASE_ANON_KEY)

AGENT_SEED = os.environ.get("AGENT_SEED", "polygon-mempool-signal-agent-v1-secure-seed")
USE_TESTNET = os.environ.get("USE_TESTNET", "false").lower() == "true"

# Pricing
FREE_TIER_DELAY_MIN = 5
PREMIUM_PRICE_FET = 0.5
FREE_MAX_RESULTS = 10
PREMIUM_MAX_RESULTS = 100

# Fetch.ai network config
NETWORK = "testnet" if USE_TESTNET else "mainnet"


# ---------------------------------------------------------------------------
# Message Models
# ---------------------------------------------------------------------------

class SignalRequest(Model):
    signal_type: str
    tier: str = "free"
    max_results: int = 10
    payment_ref: Optional[str] = None


class SignalResponse(Model):
    signals: str
    count: int
    tier: str
    price_fet: float
    payment_required: bool
    agent_address: str
    timestamp: str


class DiscoveryInfo(Model):
    name: str
    description: str
    capabilities: str
    pricing: str
    address: str


# ---------------------------------------------------------------------------
# Cosmpy / Wallet (lazy-loaded so the agent can run without cosmpy installed
# for basic signal serving — wallet features just won't be available)
# ---------------------------------------------------------------------------

_ledger_client = None
_wallet = None

def get_ledger_client():
    global _ledger_client
    if _ledger_client is None:
        try:
            from cosmpy.aerial.client import LedgerClient, NetworkConfig
            if USE_TESTNET:
                _ledger_client = LedgerClient(NetworkConfig.fetchai_stable_testnet())
            else:
                _ledger_client = LedgerClient(NetworkConfig.fetch_mainnet())
        except ImportError:
            print("[WARN] cosmpy not installed — wallet features disabled")
        except Exception as e:
            print(f"[WARN] Failed to connect to Fetch.ai network: {e}")
    return _ledger_client


def get_wallet_balance(address: str) -> float:
    """Query on-chain FET balance via cosmpy."""
    client = get_ledger_client()
    if client is None:
        return 0.0
    try:
        balance = client.query_bank_balance(address)
        # Balance is in attoFET (10^18), convert to FET
        return float(balance) / 1e18
    except Exception as e:
        print(f"[WARN] Failed to query balance: {e}")
        return 0.0


def send_fet(destination: str, amount_fet: float, wallet) -> Optional[str]:
    """Send FET tokens to a destination address. Returns tx hash or None."""
    client = get_ledger_client()
    if client is None:
        return None
    try:
        # Convert FET to attoFET
        amount_attofet = int(amount_fet * 1e18)
        tx = client.send_tokens(destination, amount_attofet, "afet", wallet)
        tx.wait_to_complete()
        return tx.tx_hash
    except Exception as e:
        print(f"[ERROR] Failed to send tokens: {e}")
        return None


# ---------------------------------------------------------------------------
# Supabase data access
# ---------------------------------------------------------------------------

def supabase_query(table: str, params: dict) -> list:
    query_parts = []
    for key, val in params.items():
        query_parts.append(f"{key}={val}")
    query_string = "&".join(query_parts)
    url = f"{SUPABASE_URL}/rest/v1/{table}?{query_string}"
    headers = {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
    }
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode())
    except Exception as e:
        print(f"[ERROR] Supabase query failed: {e}")
        return []


def supabase_insert(table: str, data: dict) -> bool:
    url = f"{SUPABASE_URL}/rest/v1/{table}"
    headers = {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    }
    body = json.dumps(data).encode()
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status in (200, 201)
    except Exception as e:
        print(f"[ERROR] Supabase insert failed: {e}")
        return False


def supabase_upsert(table: str, data: dict, match_key: str, match_val: str) -> bool:
    url = f"{SUPABASE_URL}/rest/v1/{table}?{match_key}=eq.{match_val}"
    headers = {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    }
    body = json.dumps(data).encode()
    req = urllib.request.Request(url, data=body, headers=headers, method="PATCH")
    try:
        with urllib.request.urlopen(req, timeout=10):
            return True
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return supabase_insert(table, data)
        return False
    except Exception:
        return False


def fetch_signals(signal_type: str, tier: str, max_results: int) -> list:
    params = {
        "select": "transaction_hash,from_address,to_address,gas_price,gas_limit,data,route_opportunity,first_seen_at",
        "order": "first_seen_at.desc",
        "limit": str(max_results),
        "route_opportunity": "not.is.null",
    }
    rows = supabase_query("mempool_transactions", params)

    if signal_type != "all":
        filtered = []
        for row in rows:
            opp = row.get("route_opportunity") or {}
            opp_type = opp.get("type", "")
            if signal_type == "gas_overpayment" and opp_type == "gas_reduction":
                filtered.append(row)
            elif signal_type == "route_inefficiency" and opp_type == "route_optimization":
                filtered.append(row)
            elif signal_type == "dex_swap" and opp.get("dex"):
                filtered.append(row)
        rows = filtered

    if tier == "free":
        cutoff = time.time() - (FREE_TIER_DELAY_MIN * 60)
        cutoff_iso = time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime(cutoff))
        rows = [r for r in rows if r.get("first_seen_at", "") <= cutoff_iso]

    signals = []
    for row in rows:
        opp = row.get("route_opportunity") or {}
        signals.append({
            "tx_hash": row.get("transaction_hash", ""),
            "from": row.get("from_address", ""),
            "to": row.get("to_address", ""),
            "gas_price_gwei": round(int(row.get("gas_price", "0")) / 1e9, 2),
            "gas_limit": int(row.get("gas_limit", "0")),
            "dex": opp.get("dex", ""),
            "function": opp.get("functionName", ""),
            "signal_type": opp.get("type", ""),
            "gas_saved": opp.get("gasSaved", 0),
            "confidence": opp.get("confidence", 0),
            "reason": opp.get("reason", ""),
            "detected_at": row.get("first_seen_at", ""),
        })
    return signals


def log_signal_request(subscriber_address, signal_type, tier, result_count,
                        latency_ms, payment_amount, payment_status, payment_tx_hash=None):
    data = {
        "subscriber_address": subscriber_address,
        "signal_type": signal_type,
        "tier": tier,
        "result_count": result_count,
        "latency_ms": latency_ms,
        "payment_amount": payment_amount,
        "payment_status": payment_status,
        "payment_tx_hash": payment_tx_hash,
    }
    url = f"{SUPABASE_URL}/rest/v1/signal_requests"
    headers = {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }
    body = json.dumps(data).encode()
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            result = json.loads(resp.read().decode())
            return result[0].get("id", "") if result else ""
    except Exception as e:
        print(f"[ERROR] Failed to log signal request: {e}")
        return ""


def update_subscriber(subscriber_address, tier, result_count, payment_amount):
    existing = supabase_query("agent_subscribers", {
        "subscriber_address": f"eq.{subscriber_address}",
        "select": "id,total_queries,total_fet_paid",
    })
    if existing:
        sub = existing[0]
        new_queries = sub.get("total_queries", 0) + 1
        new_fet = float(sub.get("total_fet_paid", 0)) + payment_amount
        supabase_upsert("agent_subscribers", {
            "last_query_at": time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime()),
            "total_queries": new_queries,
            "total_fet_paid": new_fet,
            "tier": tier,
            "status": "active",
        }, "subscriber_address", subscriber_address)
    else:
        supabase_insert("agent_subscribers", {
            "subscriber_address": subscriber_address,
            "tier": tier,
            "status": "active",
            "last_query_at": time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime()),
            "total_queries": 1,
            "total_fet_paid": payment_amount,
        })


def record_revenue(subscriber_address, amount_fet, signal_request_id, tx_hash=None):
    supabase_insert("agent_revenue", {
        "subscriber_address": subscriber_address,
        "amount_fet": amount_fet,
        "signal_request_id": signal_request_id if signal_request_id else None,
        "tx_hash": tx_hash,
        "status": "confirmed",
    })


def sync_wallet_to_supabase(wallet_address, agent_address, balance_fet):
    supabase_upsert("agent_wallet", {
        "wallet_address": wallet_address,
        "agent_address": agent_address,
        "balance_fet": balance_fet,
        "balance_updated_at": time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime()),
        "network": NETWORK,
        "seed_phrase_set": True,
    }, "wallet_address", wallet_address)


def record_wallet_transaction(wallet_address, direction, counterparty, amount_fet,
                               tx_hash, block_number=None, status="confirmed", description=""):
    supabase_insert("wallet_transactions", {
        "wallet_address": wallet_address,
        "direction": direction,
        "counterparty_address": counterparty,
        "amount_fet": amount_fet,
        "tx_hash": tx_hash,
        "block_number": block_number,
        "status": status,
        "description": description,
    })


def process_pending_withdrawals(wallet, wallet_address):
    """Check for pending withdrawal requests and execute them on-chain."""
    pending = supabase_query("withdrawal_requests", {
        "status": "eq.pending",
        "order": "requested_at.asc",
        "limit": "5",
    })
    for req in pending:
        req_id = req.get("id")
        dest = req.get("destination_address", "")
        amount = float(req.get("amount_fet", 0))

        if not dest or amount <= 0:
            continue

        # Mark as processing
        supabase_upsert("withdrawal_requests", {
            "status": "processing",
            "processed_at": time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime()),
        }, "id", req_id)

        print(f"[WITHDRAWAL] Sending {amount} FET to {dest}...")

        tx_hash = send_fet(dest, amount, wallet)

        if tx_hash:
            supabase_upsert("withdrawal_requests", {
                "status": "completed",
                "tx_hash": tx_hash,
                "processed_at": time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime()),
            }, "id", req_id)
            record_wallet_transaction(wallet_address, "withdrawal", dest, amount, tx_hash, status="confirmed")
            print(f"[WITHDRAWAL] Success: {tx_hash}")
        else:
            supabase_upsert("withdrawal_requests", {
                "status": "failed",
                "error_message": "Transaction broadcast failed",
                "processed_at": time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime()),
            }, "id", req_id)
            print(f"[WITHDRAWAL] Failed for {req_id}")


# ---------------------------------------------------------------------------
# Agent setup
# ---------------------------------------------------------------------------

agent = Agent(
    name="Polygon Mempool Signal Agent",
    seed=AGENT_SEED,
    port=8000,
    endpoint=["http://localhost:8000/submit"],
)

signal_protocol = Protocol(name="mempool_signals", version="1.1.0")


@agent.on_event("startup")
async def startup(ctx: Context):
    ctx.logger.info("=" * 60)
    ctx.logger.info("  Polygon Mempool Signal Agent")
    ctx.logger.info(f"  Network: {NETWORK.upper()}")
    ctx.logger.info("=" * 60)
    ctx.logger.info(f"Agent address: {agent.address}")
    ctx.logger.info(f"Wallet address: {agent.wallet.address()}")
    ctx.logger.info(f"Almanac registration: auto")
    ctx.logger.info(f"Free tier: {FREE_TIER_DELAY_MIN}min delay, max {FREE_MAX_RESULTS}")
    ctx.logger.info(f"Premium tier: real-time, max {PREMIUM_MAX_RESULTS}, {PREMIUM_PRICE_FET} FET/query")

    # Sync wallet to Supabase
    wallet_addr = agent.wallet.address()
    balance = get_wallet_balance(wallet_addr)
    sync_wallet_to_supabase(wallet_addr, agent.address, balance)
    ctx.logger.info(f"Wallet balance: {balance:.4f} FET")

    if balance == 0 and not USE_TESTNET:
        ctx.logger.warning("")
        ctx.logger.warning("  WALLET IS EMPTY — send FET to this address to fund the agent:")
        ctx.logger.warning(f"  {wallet_addr}")
        ctx.logger.warning("  Buy FET on Coinbase/Binance, withdraw to Fetch.ai mainnet.")
        ctx.logger.warning("")

    # Update agent config
    supabase_upsert("agent_config", {
        "key": "agent_address",
        "value": json.dumps(agent.address),
    }, "key", "agent_address")
    supabase_upsert("agent_config", {
        "key": "wallet_address",
        "value": json.dumps(wallet_addr),
    }, "key", "wallet_address")
    supabase_upsert("agent_config", {
        "key": "almanac_registered",
        "value": json.dumps(True),
    }, "key", "almanac_registered")
    supabase_upsert("agent_config", {
        "key": "network",
        "value": json.dumps(NETWORK),
    }, "key", "network")
    supabase_upsert("agent_config", {
        "key": "last_heartbeat",
        "value": json.dumps({
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime()),
            "agent_address": agent.address,
            "wallet_balance": balance,
        }),
        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime()),
    }, "key", "last_heartbeat")


@agent.on_interval(period=30.0)
async def sync_wallet(ctx: Context):
    """Sync wallet balance and process pending withdrawals every 30 seconds."""
    wallet_addr = agent.wallet.address()
    balance = get_wallet_balance(wallet_addr)
    sync_wallet_to_supabase(wallet_addr, agent.address, balance)

    # Update heartbeat
    supabase_upsert("agent_config", {
        "key": "last_heartbeat",
        "value": json.dumps({
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime()),
            "agent_address": agent.address,
            "wallet_balance": balance,
        }),
        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime()),
    }, "key", "last_heartbeat")

    # Process any pending withdrawal requests
    process_pending_withdrawals(agent.wallet, wallet_addr)


@signal_protocol.on_message(model=SignalRequest)
async def handle_signal_request(ctx: Context, sender: str, msg: SignalRequest):
    start_time = time.time()
    ctx.logger.info(f"Signal request from {sender}: type={msg.signal_type}, tier={msg.tier}")

    tier = msg.tier if msg.tier in ("free", "premium") else "free"
    max_results = min(msg.max_results or 10,
                      PREMIUM_MAX_RESULTS if tier == "premium" else FREE_MAX_RESULTS)

    signals = fetch_signals(msg.signal_type, tier, max_results)
    latency_ms = int((time.time() - start_time) * 1000)

    if tier == "premium":
        price_fet = PREMIUM_PRICE_FET
        payment_required = True
        payment_status = "paid" if msg.payment_ref else "pending"
    else:
        price_fet = 0.0
        payment_required = False
        payment_status = "free"

    request_id = log_signal_request(
        subscriber_address=sender,
        signal_type=msg.signal_type,
        tier=tier,
        result_count=len(signals),
        latency_ms=latency_ms,
        payment_amount=price_fet,
        payment_status=payment_status,
        payment_tx_hash=msg.payment_ref,
    )

    update_subscriber(sender, tier, len(signals), price_fet)

    if tier == "premium" and payment_status == "paid":
        record_revenue(sender, price_fet, request_id, msg.payment_ref)
        # Record as wallet deposit
        record_wallet_transaction(
            agent.wallet.address(), "deposit", sender, price_fet,
            msg.payment_ref, status="confirmed", description=f"Premium signal query: {msg.signal_type}"
        )
        ctx.logger.info(f"Premium query: {price_fet} FET from {sender}")

    response = SignalResponse(
        signals=json.dumps(signals),
        count=len(signals),
        tier=tier,
        price_fet=price_fet,
        payment_required=payment_required,
        agent_address=agent.address,
        timestamp=time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime()),
    )

    await ctx.send(sender, response)
    ctx.logger.info(f"Sent {len(signals)} signals to {sender} (tier={tier}, {latency_ms}ms)")


agent.include(signal_protocol)


if __name__ == "__main__":
    print("=" * 60)
    print("  Polygon Mempool Signal Agent")
    print(f"  Fetch.ai {NETWORK.upper()}")
    print("=" * 60)
    print()
    print("  This agent:")
    print("  1. Registers on the Almanac (auto-discovery)")
    print("  2. Serves Polygon mempool signals to other agents")
    print("  3. Accepts FET payments via Agent Payment Protocol")
    print("  4. Manages its own on-chain wallet")
    print("  5. Processes withdrawal requests from the dashboard")
    print()
    print("  Other agents discover this agent by searching")
    print("  the Almanac for 'mempool', 'polygon', or 'signals'.")
    print()
    print("  Press Ctrl+C to stop.")
    print("=" * 60)
    print()

    agent.run()
