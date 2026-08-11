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

- [ ] Migration tooling selected and configured
- [ ] `users` table + migration
- [ ] `strategies` table + migration
- [ ] `signals` table + migration
- [ ] `risk_checks` table + migration
- [ ] `trade_proposals` table + migration
- [ ] `trade_approvals` table + migration
- [ ] `executions` table + migration
- [ ] `orders` table + migration
- [ ] `fills` table + migration
- [ ] `positions` table + migration
- [ ] `portfolio_snapshots` table + migration
- [ ] `audit_logs` table + migration
- [ ] `system_settings` table + migration
- [ ] Indexes and constraints
- [ ] Repository layer (Node)
- [ ] Repository layer (Python)
- [ ] Database tests
- [ ] Owner review

---

## Phase 3 — Authentication

- [ ] Single owner account bootstrap
- [ ] POST /auth/login
- [ ] POST /auth/logout
- [ ] GET /auth/me
- [ ] Secure password hashing (bcrypt/argon2)
- [ ] JWT or session tokens
- [ ] Protected API middleware
- [ ] Authorization layer
- [ ] Audit events (LOGIN, LOGOUT, FAILED_LOGIN)
- [ ] Authentication tests
- [ ] Security tests
- [ ] Owner review

---

## Phase 4 — Market Data

- [ ] `MarketDataProvider` interface
- [ ] `SyntheticMarketDataProvider` implementation
- [ ] `CSVMarketDataProvider` implementation
- [ ] Freshness validation (staleness threshold configurable)
- [ ] Market snapshot schema
- [ ] API endpoints for current market data
- [ ] Tests
- [ ] Owner review

---

## Phase 5 — Paper Broker

- [ ] `BrokerAdapter` interface defined
- [ ] `PaperBrokerAdapter` implementation
- [ ] Market order simulation
- [ ] Limit order simulation
- [ ] Pending order queue
- [ ] Fill simulation
- [ ] Partial fill simulation
- [ ] Order cancellation
- [ ] Rejection simulation
- [ ] Configurable simulated fees
- [ ] Configurable slippage
- [ ] Insufficient funds simulation
- [ ] Deterministic test mode (seeded)
- [ ] Tests
- [ ] Owner review

---

## Phase 6 — Strategy Engine

- [ ] `Strategy` interface
- [ ] `Signal` schema
- [ ] Example deterministic strategy (`MovingAverageCrossover` or similar)
- [ ] Strategy registry
- [ ] Strategy → Signal only (no execution access)
- [ ] Architectural boundary tests (strategy cannot reach broker)
- [ ] Tests
- [ ] Owner review

---

## Phase 7 — Risk Engine

- [ ] `RiskEngine` interface
- [ ] Risk rule: maximum order notional
- [ ] Risk rule: maximum position size
- [ ] Risk rule: maximum portfolio concentration
- [ ] Risk rule: maximum open positions
- [ ] Risk rule: maximum daily loss
- [ ] Risk rule: available cash
- [ ] Risk rule: duplicate/existing exposure
- [ ] Risk rule: market data freshness
- [ ] Risk rule: proposal expiration
- [ ] Risk rule: price drift
- [ ] Risk rule: kill switch
- [ ] Risk rule: trading session status
- [ ] Risk rule: cooldown between trades
- [ ] Structured risk result output
- [ ] Persist every risk evaluation
- [ ] Kill switch implementation (server-side)
- [ ] Risk configuration API
- [ ] Extensive tests
- [ ] Owner review

---

## Phase 8 — Trade Proposals

- [ ] Signal → Risk Check → Trade Proposal workflow
- [ ] Proposal state machine enforcement
- [ ] Proposal expiration
- [ ] Immutability after PENDING_APPROVAL
- [ ] POST /signals (create signal)
- [ ] GET /trade-proposals
- [ ] GET /trade-proposals/:id
- [ ] PATCH /trade-proposals/:id/cancel
- [ ] Tests
- [ ] Owner review

---

## Phase 9 — Owner Approval

- [ ] POST /trade-proposals/:id/approve
- [ ] POST /trade-proposals/:id/reject
- [ ] Authorization check
- [ ] Risk revalidation on approval
- [ ] Price drift check
- [ ] Expiration check
- [ ] Concurrency protection (SELECT FOR UPDATE)
- [ ] Database locking
- [ ] Audit events
- [ ] Simultaneous approval tests
- [ ] Unauthorized approval tests
- [ ] Owner review

---

## Phase 10 — Paper Execution

- [ ] Execution workflow
- [ ] Idempotency (unique execution key + DB constraint)
- [ ] PaperBroker submission
- [ ] Order state updates
- [ ] Fill recording
- [ ] Portfolio updates
- [ ] P&L calculation
- [ ] Reconciliation logic
- [ ] Failure recovery
- [ ] Duplicate/retry tests
- [ ] Owner review

---

## Phase 11 — Dashboard

- [ ] Dashboard page (portfolio summary, kill switch status)
- [ ] Trade Proposals page (list + detail + approve/reject)
- [ ] Orders page
- [ ] Positions page
- [ ] Portfolio page (equity, cash, P&L)
- [ ] Risk page (rules, current status)
- [ ] Strategy Signals page
- [ ] Audit Log page
- [ ] Settings page (kill switch toggle, risk parameters)
- [ ] PAPER TRADING banner on all screens
- [ ] Approval flow (calls secure API, no parameter injection)
- [ ] Owner review

---

## Phase 12 — Failure Testing

- [ ] Network timeout simulation
- [ ] Duplicate request test
- [ ] Database error test
- [ ] PaperBroker unavailable test
- [ ] Partial fill test
- [ ] Application restart test
- [ ] Simultaneous approval test
- [ ] Stale market data test
- [ ] Price movement test
- [ ] Daily loss limit test
- [ ] Kill switch test
- [ ] All 20 required test scenarios pass
- [ ] Final documentation review
- [ ] Owner MVP sign-off

---

## Paper MVP Definition of Done

- [ ] All automated tests pass
- [ ] Paper trading only (no real broker)
- [ ] Strategy cannot execute trades
- [ ] Risk checks cannot be bypassed
- [ ] Owner approval cannot be bypassed
- [ ] Approval performs risk revalidation
- [ ] Duplicate approval cannot duplicate an order
- [ ] Execution retry cannot duplicate an order
- [ ] Proposal expiration works
- [ ] Price drift validation works
- [ ] Kill switch works
- [ ] Paper portfolio and P&L reconcile correctly
- [ ] Audit history complete
- [ ] Failure/recovery tests pass
- [ ] Documentation matches implementation
