# Phase 17 Long-Run PAPER Trading Validation

Phase 17 adds a paper-only validation harness for the completed Alpaca Market
Data and Alpaca PAPER broker integrations. It does not add live trading or
real-money execution.

Run the validator from the repository root:

```powershell
npm.cmd run validate:phase17 --workspace=apps/api
```

The validator refuses to submit paper orders unless all gates are satisfied:

- `DATABASE_URL` points to the paper trading database.
- `TRADING_ENGINE_URL` points to the internal trading engine.
- `BROKER_PROVIDER=alpaca_paper`.
- `MARKET_DATA_PROVIDER=alpaca`.
- Alpaca paper credentials are present in environment variables.
- `ALPACA_PAPER_TRADING_BASE_URL`, if set, is not a live trading URL.
- `PHASE17_ENABLE_PAPER_ORDERS=true`.

When configured, the validator checks:

- signal -> risk -> proposal -> approval -> paper order
- order, fill, and position synchronization
- paper cash and buying power reads
- realized and unrealized P&L snapshot evidence
- duplicate approval and execution retry protection
- stale market data rejection
- kill switch rejection
- repeated broker and market-data reads for recovery monitoring
- audit events for proposal creation, approval, and execution

Reports are written to:

- `docs/reports/PHASE_17_LONG_RUN_PAPER_VALIDATION.md`
- `docs/reports/phase17-paper-validation-latest.json`

In the current local shell, Phase 17 real validation is blocked because the
required runtime environment variables are not configured. The generated report
records that blocked state and no paper order was submitted.
