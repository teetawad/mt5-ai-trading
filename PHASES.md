# PHASES.md - MT5 Rewrite Status

## Active Architecture

- [x] MT5Adapter wrapper over official MetaTrader5 package
- [x] DemoExecutionGateway centralized order path
- [x] MT5 demo verification before execution
- [x] MT5-native database migration
- [x] Baseline H1 strategy interface
- [x] Scanner and AI decision persistence
- [x] Server-side MT5 risk engine
- [x] Assisted analysis route
- [x] AUTO-DEMO route, default off
- [x] MT5 dashboard rewrite
- [x] Alpaca startup path deactivated

## Required Operational Validation

- [ ] Configure local MT5 demo terminal
- [ ] Sync broker instruments
- [ ] Enable owner watchlist rows
- [ ] Run full live DEMO connectivity check
- [ ] Run full tests/lint/typecheck/build in the configured environment
