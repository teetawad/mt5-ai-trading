# Phase 21 PAPER Trading Operational Run Report

Generated: 2026-08-11T15:20:18.233Z
Mode: PAPER
Symbol: AAPL
Overall status: BLOCKED

This report is for Alpaca PAPER trading only. It does not validate, add, or enable live trading or real-money execution.

| Check | Status | Detail |
| --- | --- | --- |
| paper trading mode | BLOCKED | Set BROKER_PROVIDER=alpaca_paper before Phase 21 validation. |
| alpaca market data provider | BLOCKED | Set MARKET_DATA_PROVIDER=alpaca before Phase 21 validation. |
| database configured | PASS | DATABASE_URL is configured. |
| trading engine configured | PASS | TRADING_ENGINE_URL is configured. |
| alpaca paper credentials | BLOCKED | Alpaca paper credentials must be provided through environment variables only. |
| live trading endpoint guard | PASS | No live Alpaca trading endpoint is configured for paper trading. |
| phase 21 paper order execution opt-in | BLOCKED | Set PHASE21_ENABLE_PAPER_ORDERS=true to permit one Alpaca PAPER validation order. |
| api dashboard endpoint configured | BLOCKED | Set PHASE21_API_URL and PHASE21_OWNER_BEARER_TOKEN to validate the running dashboard API. |

