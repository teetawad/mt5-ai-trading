# Phase 17 Long-Run PAPER Trading Validation Report

Generated: 2026-08-11T11:32:29.322Z
Mode: PAPER
Symbol: AAPL
Overall status: BLOCKED

This report is for Alpaca PAPER trading only. It does not validate or enable live trading.

| Check | Status | Detail |
| --- | --- | --- |
| paper trading mode | BLOCKED | Set BROKER_PROVIDER=alpaca_paper before Phase 17 validation. |
| alpaca market data provider | BLOCKED | Set MARKET_DATA_PROVIDER=alpaca before Phase 17 validation. |
| database configured | BLOCKED | DATABASE_URL is required to validate proposals, orders, fills, positions, and audit logs. |
| trading engine configured | BLOCKED | TRADING_ENGINE_URL is required to validate real market data and Alpaca paper broker state. |
| alpaca paper credentials | BLOCKED | Alpaca paper credentials must be provided through environment variables only. |
| live trading endpoint guard | PASS | No live Alpaca trading endpoint is configured for paper trading. |
| paper order execution opt-in | BLOCKED | Set PHASE17_ENABLE_PAPER_ORDERS=true to permit the validator to submit Alpaca paper orders. |

