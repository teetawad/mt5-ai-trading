# PHASES.md — Project Phase Checklist

Track completion of each phase here. Update status as work progresses.

Legend: `[ ]` not started · `[~]` in progress · `[x]` complete · `[!]` blocked

---

## Phase 0 — Design & Architecture

- [x] Architecture document (`docs/ARCHITECTURE.md`)
- [x] Directory structure defined
- [x] Database entity model (`docs/DATABASE.md`)
- [x] Trade state machine (`docs/ORDER_STATE_MACHINE.md`)
- [x] API design (`docs/API.md`)
- [x] Risk engine design (`docs/RISK_ENGINE.md`)
- [x] Paper broker design (`docs/PAPER_BROKER.md`)
- [x] Threat model (`docs/THREAT_MODEL.md`)
- [x] Test strategy (`docs/TEST_PLAN.md`)
- [x] Development guide stub (`docs/DEVELOPMENT.md`)
- [x] Future live trading requirements (`docs/FUTURE_LIVE_TRADING_REQUIREMENTS.md`)
- [x] CLAUDE.md created
- [x] PHASES.md created
- [ ] Owner review and sign-off

---

## Phase 1 — Project Scaffold

- [x] Nuxt 3 frontend initialized (`apps/web/`)
- [x] Node/Express API initialized (`apps/api/`)
- [x] Python FastAPI trading engine initialized (`services/trading-engine/`)
- [x] Docker Compose for PostgreSQL
- [x] ESLint + Prettier (Node/TS)
- [x] Ruff + mypy (Python)
- [x] Vitest configured (Node)
- [x] pytest configured (Python)
- [x] Environment configuration (`.env.example`)
- [x] Health check endpoints on all services
- [x] All services start cleanly
- [x] Tests pass (empty/smoke)
- [ ] Owner review

---

## Phase 2 — Database

- [x] Migration tooling selected and configured
- [x] `users` table + migration
- [x] `strategies` table + migration
- [x] `signals` table + migration
- [x] `risk_checks` table + migration
- [x] `trade_proposals` table + migration
- [x] `trade_approvals` table + migration
- [x] `executions` table + migration
- [x] `orders` table + migration
- [x] `fills` table + migration
- [x] `positions` table + migration
- [x] `portfolio_snapshots` table + migration
- [x] `audit_logs` table + migration
- [x] `system_settings` table + migration
- [x] Indexes and constraints
- [x] DB-level triggers (audit immutability, proposal field immutability)
- [x] System settings seeded (12 defaults)
- [x] Repository layer (Node) — 13 repositories
- [x] Repository layer (Python) — asyncpg pool + system_settings
- [x] Database tests (skip gracefully without TEST_DATABASE_URL)
- [ ] Owner review

---

## Phase 3 — Authentication

- [x] Single owner account bootstrap (`npm run bootstrap:owner`)
- [x] POST /auth/login
- [x] POST /auth/logout
- [x] GET /auth/me
- [x] Secure password hashing (argon2id, 64 MiB memory cost)
- [x] JWT session tokens (HttpOnly cookie + Bearer header)
- [x] Server-side logout denylist (JTI-based, memory-resident)
- [x] Protected API middleware (`requireAuth`, `requireOwner`)
- [x] Authorization layer (role-based, owner-only guard)
- [x] Audit events (LOGIN_SUCCESS, LOGIN_FAILED, LOGOUT)
- [x] Rate limiting on /auth/login (skipped in test mode)
- [x] Authentication unit tests (tokens, denylist, middleware)
- [x] Authentication integration tests (routes, audit events; skip without DB)
- [ ] Owner review

---

## Phase 4 — Market Data

- [x] `MarketDataProvider` abstract interface (Python ABC)
- [x] `SyntheticMarketDataProvider` — geometric random walk, configurable volatility, deterministic seed for tests
- [x] `CSVMarketDataProvider` — replays historical CSV rows, loops at end
- [x] Freshness validation — `is_stale` flag computed against `MARKET_DATA_STALENESS_SECONDS`
- [x] `MarketSnapshot` Pydantic schema (Decimal fields serialised as strings)
- [x] Module-level registry with `MARKET_DATA_PROVIDER` env var switching
- [x] `X-Internal-Token` validation on trading-engine endpoints
- [x] Trading engine endpoints: `GET /market-data/snapshot/:symbol`, `/snapshots`, `/symbols`
- [x] `TradingEngineClient` (Node) — internal HTTP client with 5s timeout
- [x] Node API routes: `GET /market-data/snapshot/:symbol`, `/snapshots`, `/symbols` (auth-protected)
- [x] Sample CSV data file (`data/market_data/AAPL.csv`)
- [x] Python tests: synthetic provider, CSV provider, registry, FastAPI endpoints (26 pass)
- [x] Node tests: all routes with mocked engine client (10 pass)
- [ ] Owner review

---

## Phase 5 — Paper Broker

- [x] `BrokerAdapter` interface defined
- [x] `PaperBrokerAdapter` implementation
- [x] Market order simulation
- [x] Limit order simulation
- [x] Pending order queue
- [x] Fill simulation
- [x] Partial fill simulation
- [x] Order cancellation
- [x] Rejection simulation
- [x] Configurable simulated fees
- [x] Configurable slippage
- [x] Insufficient funds simulation
- [x] Deterministic test mode (seeded)
- [x] Tests (60 Python pass; Node client extended)
- [ ] Owner review

---

## Phase 6 — Strategy Engine

- [x] `Strategy` interface
- [x] `Signal` schema
- [x] Example deterministic strategy (`MovingAverageCrossover` or similar)
- [x] Strategy registry
- [x] Strategy → Signal only (no execution access)
- [x] Architectural boundary tests (strategy cannot reach broker)
- [x] Tests (37 Python pass; Node client extended)
- [ ] Owner review

---

## Phase 7 — Risk Engine

- [x] `RiskEngine` interface
- [x] Risk rule: maximum order notional
- [x] Risk rule: maximum position size
- [x] Risk rule: maximum portfolio concentration
- [x] Risk rule: maximum open positions
- [x] Risk rule: maximum daily loss
- [x] Risk rule: available cash
- [x] Risk rule: duplicate/existing exposure
- [x] Risk rule: market data freshness
- [x] Risk rule: proposal expiration
- [x] Risk rule: price drift
- [x] Risk rule: kill switch
- [x] Risk rule: trading session status
- [x] Risk rule: cooldown between trades
- [x] Structured risk result output
- [x] Persist every risk evaluation
- [x] Kill switch implementation (server-side)
- [x] Risk configuration API
- [x] Extensive tests
- [ ] Owner review

---

## Phase 8 — Trade Proposals

- [x] Signal → Risk Check → Trade Proposal workflow
- [x] Proposal state machine enforcement
- [x] Proposal expiration
- [x] Immutability after PENDING_APPROVAL
- [x] POST /signals (create signal)
- [x] GET /trade-proposals
- [x] GET /trade-proposals/:id
- [x] PATCH /trade-proposals/:id/cancel
- [x] Tests
- [ ] Owner review

---

## Phase 9 — Owner Approval

- [x] POST /trade-proposals/:id/approve
- [x] POST /trade-proposals/:id/reject
- [x] Authorization check
- [x] Risk revalidation on approval
- [x] Price drift check
- [x] Expiration check
- [x] Concurrency protection (SELECT FOR UPDATE)
- [x] Database locking
- [x] Audit events
- [x] Simultaneous approval tests
- [x] Unauthorized approval tests
- [ ] Owner review

---

## Phase 10 — Paper Execution

- [x] Execution workflow
- [x] Idempotency (unique execution key + DB constraint)
- [x] PaperBroker submission
- [x] Order state updates
- [x] Fill recording
- [x] Portfolio updates
- [x] P&L calculation
- [x] Reconciliation logic
- [x] Failure recovery
- [x] Duplicate/retry tests
- [ ] Owner review

---

## Phase 11 — Dashboard

- [x] Dashboard page (portfolio summary, kill switch status)
- [x] Trade Proposals page (list + detail + approve/reject)
- [x] Orders page
- [x] Positions page
- [x] Portfolio page (equity, cash, P&L)
- [x] Risk page (rules, current status)
- [x] Strategy Signals page
- [x] Audit Log page
- [x] Settings page (kill switch toggle, risk parameters)
- [x] PAPER TRADING banner on all screens
- [x] Approval flow (calls secure API, no parameter injection)
- [ ] Owner review

---

## Phase 12 — Failure Testing

- [x] Network timeout simulation
- [x] Duplicate request test
- [x] Database error test
- [x] PaperBroker unavailable test
- [x] Partial fill test
- [x] Application restart test
- [x] Simultaneous approval test
- [x] Stale market data test
- [x] Price movement test
- [x] Daily loss limit test
- [x] Kill switch test
- [x] All 20 required test scenarios pass
- [x] Final documentation review
- [ ] Owner MVP sign-off

---

## Phase 13 — Paper MVP Audit

- [x] Architecture audit
- [x] Security audit
- [x] Phase 9 approval audit
- [x] Phase 10 execution audit
- [x] Risk control audit
- [x] Concurrency and idempotency audit
- [x] Accounting and recovery audit
- [x] Execution-time paper safety gate
- [x] Complete test suite run
- [ ] Owner review

---

## Phase 14 — US Stocks Market Data

- [x] Alpaca Market Data provider
- [x] Historical bars
- [x] Latest quotes
- [x] Latest trades
- [x] Real-time WebSocket support
- [x] Timestamp parsing and freshness checks
- [x] Reconnect and error handling
- [x] Rate-limit handling
- [x] Synthetic and CSV providers preserved
- [x] Tests
- [ ] Owner review

---

## Phase 15 — Backtesting and Strategy Evaluation

- [x] Historical-data backtesting
- [x] Train/test time split
- [x] Walk-forward validation
- [x] Transaction fees and slippage
- [x] Benchmark comparison
- [x] Metrics: return, max drawdown, Sharpe ratio, win rate, profit factor
- [x] Strategy parameter configuration
- [x] Look-ahead bias prevention
- [x] Data leakage prevention
- [x] Reproducible tests
- [x] PAPER execution boundary preserved
- [ ] Owner review

---

## Phase 16 — Alpaca Paper Trading

- [x] AlpacaPaperBrokerAdapter
- [x] Alpaca paper trading endpoints only
- [x] Local PaperBrokerAdapter preserved for tests/fallback
- [x] Account synchronization
- [x] Positions synchronization
- [x] Orders synchronization
- [x] Submit paper orders
- [x] Cancel paper orders
- [x] Broker state mapping
- [x] `client_order_id` idempotency
- [x] Reconciliation and retry handling
- [x] Credentials only from environment variables
- [x] Mocked Alpaca response tests
- [x] Live trading endpoint guard
- [ ] Owner review

---

## Phase 16.5 — Alpaca Paper Dashboard Integration

- [x] Dashboard API aggregation for PAPER TRADING state
- [x] Alpaca paper account connection status
- [x] Paper buying power and cash
- [x] Current US stock prices
- [x] Pending trade proposals
- [x] Risk results
- [x] Approve/reject actions
- [x] Alpaca paper orders and order status
- [x] Fills
- [x] Positions
- [x] Realized and unrealized P&L
- [x] Market data freshness
- [x] Reconciliation status
- [x] Kill switch control
- [x] No live trading or real-money execution
- [ ] Owner review

---

## Phase 17 — Long-Run Alpaca PAPER Validation

- [x] Paper-only validation harness
- [x] Monitoring samples for broker and market-data reads
- [x] Validation report generation
- [x] Live trading endpoint guard
- [x] Credentials restricted to environment variables
- [x] Blocked report generated for missing local runtime configuration
- [ ] Real Alpaca PAPER long-run run: blocked until `DATABASE_URL`, `TRADING_ENGINE_URL`, `BROKER_PROVIDER=alpaca_paper`, `MARKET_DATA_PROVIDER=alpaca`, Alpaca paper credentials, and `PHASE17_ENABLE_PAPER_ORDERS=true` are configured
- [ ] Owner review

---

## Phase 18 — US Stock Strategy Layer

- [x] Trend factor
- [x] Momentum factor
- [x] Volatility factor
- [x] Volume factor
- [x] Moving-average confirmation
- [x] Configurable entry rules
- [x] Configurable exit rules
- [x] Factor strategy backtesting
- [x] Walk-forward validation preserved
- [x] Risk-adjusted parameter selection
- [x] Benchmark comparison preserved
- [x] Look-ahead bias prevention
- [x] Data leakage prevention
- [x] PAPER execution boundary preserved
- [ ] Owner review

---

## Phase 19 — PAPER Strategy Performance Evaluation

- [x] Total return comparison
- [x] Annualized return comparison
- [x] Maximum drawdown comparison
- [x] Sharpe ratio comparison
- [x] Win rate comparison
- [x] Profit factor comparison
- [x] Average win/loss comparison
- [x] Trade count comparison
- [x] Exposure comparison
- [x] Benchmark performance comparison
- [x] Stability across walk-forward out-of-sample folds
- [x] Overfitting and instability flags
- [x] PAPER-only performance report
- [x] Recommendation for continued PAPER testing
- [ ] Owner review

---

## Phase 20 โ€” Security and Production Readiness

- [x] Authentication and authorization review
- [x] Owner approval security review
- [x] API validation review
- [x] Secrets and environment variables review
- [x] CSRF/XSS/session risk review
- [x] Replay and duplicate request review
- [x] Race condition review
- [x] Idempotency review
- [x] Database transaction review
- [x] Audit log review
- [x] Kill switch review
- [x] Broker reconciliation review
- [x] Market-data failure handling review
- [x] Logging and monitoring review
- [x] Dependency/security review
- [x] Backup/recovery review
- [x] Critical/high-risk CSRF issue fixed
- [x] Critical/high dependency audit issue fixed
- [x] Full tests, lint, typecheck, dependency audit, and production builds run
- [x] Production-readiness report (`docs/PHASE_20_PRODUCTION_READINESS.md`)
- [ ] Owner review

---

## Paper MVP Definition of Done

- [x] All automated tests pass
- [x] Paper trading only (no real broker)
- [x] Strategy cannot execute trades
- [x] Risk checks cannot be bypassed
- [x] Owner approval cannot be bypassed
- [x] Approval performs risk revalidation
- [x] Duplicate approval cannot duplicate an order
- [x] Execution retry cannot duplicate an order
- [x] Proposal expiration works
- [x] Price drift validation works
- [x] Kill switch works
- [x] Paper portfolio and P&L reconcile correctly
- [x] Audit history complete
- [x] Failure/recovery tests pass
- [x] Documentation matches implementation
