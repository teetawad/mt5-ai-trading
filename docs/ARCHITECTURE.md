# ARCHITECTURE.md

## Overview

This is a **paper trading platform** with human-in-the-loop approval for every simulated trade.
No real-money execution is present or permitted in this codebase.

---

## System Components

```
┌──────────────────────────────────────────────────────────────────────┐
│                         BROWSER (Nuxt/Vue)                          │
│  Dashboard · Proposals · Orders · Positions · Portfolio · Audit     │
│                   [PAPER TRADING banner always visible]             │
└─────────────────────────────┬────────────────────────────────────────┘
                              │ HTTPS / REST
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     apps/api  (Node/Express/TS)                     │
│                                                                     │
│  Auth Layer → Route Handlers → Service Layer → Repository Layer    │
│                                    │                                │
│                               Domain Services:                      │
│                               · ProposalService                    │
│                               · ApprovalService                    │
│                               · ExecutionService                   │
│                               · RiskService (calls engine)         │
│                               · PortfolioService                   │
│                               · AuditService                       │
│                               · KillSwitchService                  │
└──────────┬────────────────────────────────────────────┬─────────────┘
           │ HTTP (internal)                            │ SQL
           ▼                                            ▼
┌──────────────────────────┐              ┌─────────────────────────┐
│  services/trading-engine │              │      PostgreSQL 16       │
│  (Python/FastAPI)        │              │                         │
│                          │              │  users                  │
│  · MarketDataProvider    │              │  strategies             │
│  · StrategyEngine        │              │  signals                │
│  · RiskEngine            │              │  risk_checks            │
│  · PaperBrokerAdapter    │              │  trade_proposals        │
│  · PortfolioAccounting   │              │  trade_approvals        │
│                          │              │  executions             │
│  Exposes internal API:   │              │  orders                 │
│  /signals/generate       │              │  fills                  │
│  /risk/evaluate          │              │  positions              │
│  /broker/execute         │              │  portfolio_snapshots    │
│  /broker/orders/:id      │              │  audit_logs             │
│  /market-data/snapshot   │              │  system_settings        │
└──────────────────────────┘              └─────────────────────────┘
```

---

## Service Boundaries

### apps/web (Nuxt 3)
- Renders UI only.
- Calls `apps/api` via REST.
- Never calls `trading-engine` directly.
- Never sends trading parameters during approval (sends proposal ID only).
- Always shows PAPER TRADING indicator.

### apps/api (Node/Express)
- Single source of truth for business logic orchestration.
- Owns authentication, authorization, and session management.
- Calls `trading-engine` internal API for: signals, risk evaluation, execution.
- Writes all state to PostgreSQL.
- Enforces state machine transitions.
- Manages kill switch.
- Emits audit events.
- Runs the Phase 27 hourly scheduler (`hourly-scheduler.ts`) as an always-on
  background component of the process (started from `index.ts`, never from
  `app.ts`) — the only in-process background timer in this codebase. See
  "Request Flow: Hourly Scanner" below.

### services/trading-engine (Python/FastAPI)
- **Internal service only** — not exposed to the internet.
- Contains: strategy logic, risk engine, paper broker, market data providers.
- Stateless per request; persistent state stored in PostgreSQL via `apps/api`.
- Never called by the frontend.

### PostgreSQL
- Single authoritative persistent store.
- Enforces constraints (unique execution keys, status enums, FK relationships).
- Transactions used for critical multi-step operations.

---

## Request Flow: Signal → Trade Proposal

```
1. trading-engine generates Signal (scheduled or manually triggered)
2. api receives Signal from trading-engine
3. api calls trading-engine /risk/evaluate with signal + portfolio snapshot
4. If RISK PASS: api creates TradeProposal in DB (status=PENDING_APPROVAL)
5. If RISK FAIL: api records risk_check result, no proposal created
6. api emits audit events for SIGNAL_CREATED, RISK_CHECKED, PROPOSAL_CREATED
```

## Request Flow: Owner Approval → Execution

```
1. Owner views proposal in dashboard
2. Owner clicks APPROVE (sends POST /trade-proposals/:id/approve with auth)
3. api validates authentication and authorization
4. api loads proposal from DB (SELECT FOR UPDATE)
5. api checks proposal is in PENDING_APPROVAL state
6. api checks proposal has not expired
7. api checks kill switch is enabled
8. api fetches fresh market snapshot
9. api fetches current portfolio snapshot
10. api calls trading-engine /risk/evaluate (SECOND risk check)
11. api checks price drift from proposal reference price
12. If any check fails: proposal → RISK_REJECTED_AFTER_APPROVAL or EXPIRED
13. If all pass: api creates Execution record with idempotency key
14. api calls trading-engine /broker/execute
15. trading-engine PaperBroker simulates fill
16. api records Fill, updates Order, updates Position, updates Portfolio
17. api transitions proposal to FILLED
18. api emits full audit trail
19. All DB writes in single transaction; execution idempotency key prevents doubles
```

## Request Flow: Hourly Scanner (Phase 27)

```
1. hourly-scheduler.ts ticks on a plain setInterval (default every 60s)
2. For each ENABLED hourly_watchlist symbol (skipped entirely if the
   phase27_hourly_mode_enabled master toggle is off):
   a. Fetch the latest 1H bar from trading-engine's historical-bars endpoint
   b. Confirm the bar's close time (open + 1h) is <= now (no-look-ahead guard)
   c. Compare against the last-processed candle for that symbol
3. If the candle is new: INSERT INTO hourly_candle_processing
   (symbol, candle_timestamp) — the UNIQUE(symbol, candle_timestamp)
   constraint is the entire "exactly once per candle, restart-safe"
   guarantee; only the caller whose INSERT succeeds proceeds
4. On a successful claim: run the identical Signal → Trade Proposal flow
   above (createHourlyDecisionAndProposal → createSignalAndProposal),
   using a system ActorContext (no human user) for the audit trail
5. Mark the claim row ANALYZED or ERROR; one symbol's failure never blocks
   the others or the timer itself
```

This is the only entry point into the proposal pipeline that is not
triggered by an owner clicking something in the browser — everything
downstream of step 4 (risk evaluation, `PENDING_APPROVAL`, owner approval,
execution) is identical to every other signal source. See
`docs/PHASE_27_HOURLY_TRADING.md`.

---

## Separation of Concerns — Strict Rules

| Layer | Can it read market data? | Can it call the broker? | Can it access DB? |
|---|---|---|---|
| Strategy | Yes (read-only, via provider) | **NO** | No |
| Risk Engine | Yes (read-only, via snapshot) | **NO** | No (result persisted by api) |
| Approval Service (api) | Yes (fetches fresh snapshot) | No (delegates) | Yes |
| Execution Service (api) | No | Yes (via PaperBrokerAdapter only) | Yes |
| Frontend | No | **NO** | **NO** |

---

## Key Architectural Decisions

### Decision 1: Split api vs trading-engine
**Reason:** Python ecosystem is superior for quantitative finance (pandas, numpy, scipy).
Node is better for web API, auth, session management, and real-time UI.
The split keeps quant code independent and testable without web concerns.

### Decision 2: PostgreSQL as the only database
**Reason:** ACID transactions are non-negotiable for financial state.
PostgreSQL's `SELECT FOR UPDATE` prevents race conditions during approval.
Avoiding eventual-consistency systems reduces complexity and failure modes.

### Decision 3: No message queue in Phase 0–10
**Reason:** A message queue adds complexity and new failure modes.
For paper trading at low throughput, synchronous HTTP between api and trading-engine
is sufficient. A queue can be introduced later if needed.
This still holds as of Phase 27: the hourly scheduler is a plain
`setInterval` timer, not a queue — its "exactly once" guarantee comes from a
database `UNIQUE` constraint, not from any message-broker semantics.

### Decision 4: BrokerAdapter interface designed now
**Reason:** Prepares clean seam for future live broker without touching execution logic.
PaperBrokerAdapter is the only implementation. LiveBrokerAdapter is explicitly forbidden now.

### Decision 5: Risk engine called twice
**Reason:** Market conditions change between proposal creation and owner approval.
A stale risk check must not be the basis for execution.

---

## Environment Topology

```
Development:
  - PostgreSQL runs in Docker Compose
  - trading-engine runs locally (uvicorn --reload)
  - api runs locally (ts-node-dev or tsx watch)
  - web runs locally (nuxt dev)

Production (future):
  - All services containerized
  - Secrets managed via environment variables or vault
  - PostgreSQL on managed service
```

---

## Technology Versions (target)

| Technology | Target Version |
|---|---|
| Node.js | 20 LTS |
| TypeScript | 5.x |
| Python | 3.12 |
| PostgreSQL | 16 |
| Nuxt | 3.x |
| FastAPI | 0.11x |
| Vue | 3.x |
| Tailwind | 3.x |
