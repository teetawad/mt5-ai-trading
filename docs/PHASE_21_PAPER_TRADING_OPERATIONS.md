# Phase 21 PAPER Trading Operations Checklist

Date: 2026-08-11

Scope: Alpaca PAPER trading with US stocks only. Do not configure live trading endpoints, live broker adapters, or real-money execution.

## Required Environment

- `TRADING_MODE=PAPER`
- `LIVE_BROKER_ENABLED=false`
- `BROKER_PROVIDER=alpaca_paper`
- `MARKET_DATA_PROVIDER=alpaca`
- `ALPACA_PAPER_API_KEY_ID` or `APCA_API_KEY_ID`
- `ALPACA_PAPER_API_SECRET_KEY` or `APCA_API_SECRET_KEY`
- `ALPACA_PAPER_TRADING_BASE_URL=https://paper-api.alpaca.markets` or unset
- `ALPACA_DATA_BASE_URL=https://data.alpaca.markets` or unset
- `DATABASE_URL` points to the operational paper database
- `TRADING_ENGINE_URL` points to the running trading engine
- `PHASE21_API_URL` points to the running API, for example `http://localhost:4000`
- `PHASE21_OWNER_BEARER_TOKEN` contains an owner JWT for dashboard validation
- `PHASE21_ENABLE_PAPER_ORDERS=true` is set only when the operator intentionally permits one PAPER validation order

## Pre-Run

- Confirm the Alpaca account is a PAPER account.
- Confirm no environment variable points to `https://api.alpaca.markets`.
- Run all database migrations against the target paper database.
- Confirm at least one active owner user exists.
- Confirm at least one active strategy exists.
- Review risk settings marked `CONFIGURE BEFORE USE`.
- Confirm `trading_kill_switch_enabled=true` before the validation run.
- Start the trading engine with Alpaca market data and Alpaca PAPER broker enabled.
- Start the API and dashboard.
- Confirm the dashboard banner says PAPER trading only.

## Phase 21 Validation Command

Run from the repository root:

```powershell
npm.cmd run validate:phase21 --workspace=apps/api
```

Expected generated files:

- `docs/reports/phase21-paper-operations-latest.json`
- `docs/reports/PHASE_21_PAPER_TRADING_RUN_REPORT.md`

## Acceptance Criteria

- Real US stock market data returns a current Alpaca snapshot for the configured symbol.
- Alpaca PAPER broker health and account endpoints connect.
- Dashboard `/dashboard/paper` matches broker cash, buying power, PAPER mode, and market snapshot data.
- Signal creation, risk evaluation, proposal creation, owner approval, and PAPER order submission complete end-to-end.
- Duplicate approval and duplicate execution retries are idempotent.
- Orders, fills, positions, and P&L reconcile without drift.
- Kill switch disabled state is rejected by risk evaluation, and the original state is restored.
- Audit logs include proposal creation, approval, and execution events.
- The report overall status is `PASS`.

## Stop Conditions

- Any live Alpaca trading endpoint is configured.
- Alpaca PAPER credentials are missing.
- The dashboard cannot be validated against the running API.
- The paper account cannot be read.
- Market data is unavailable or stale beyond the configured tolerance.
- Risk rejects the validation proposal.
- Order, fill, position, or P&L drift is detected.
- Audit logs are missing for the validation proposal.
- The kill switch test cannot restore the original setting.

## Post-Run

- Review the JSON report evidence for the validation proposal ID and broker order ID.
- Confirm any open validation order state in Alpaca PAPER.
- Confirm portfolio snapshots were created after execution.
- Archive the markdown run report with operational logs for the same time window.
- Leave the system in PAPER mode.
- Stop after Phase 21.
