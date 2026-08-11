# DESIGN_DECISIONS.md — Phase 0 Design Decisions

This file records architectural decisions made during Phase 0 and the reasoning behind them.
Update this file whenever a significant design decision is made.

---

## DD-001: Monorepo with apps/ and services/ split

**Decision:** Single Git repo with `apps/web`, `apps/api`, and `services/trading-engine`.

**Rationale:**
- Atomic commits across frontend, API, and trading engine are important for correctness.
- Shared `docs/` and `database/migrations/` are easier to co-locate.
- Language split (TypeScript / Python) is maintained clearly within the monorepo structure.

**Rejected alternatives:**
- Separate repos: harder to keep in sync; migrations and docs drift.
- Full Python API: loses Node.js ecosystem advantages for web APIs (Nuxt SSR, WebSockets).

---

## DD-002: Node/Express for the public API, Python for quantitative logic

**Decision:** `apps/api` (Node/Express/TypeScript) is the external-facing API.
`services/trading-engine` (Python/FastAPI) handles strategy, risk, and paper broker.

**Rationale:**
- Python has pandas, numpy, scipy — essential for financial computation.
- Node.js is better for authentication, session management, request routing.
- Keeps quant code independently testable without web framework overhead.
- Risk engine unit tests are faster in Python without HTTP overhead.

**Trade-offs:**
- Two services to run locally (mitigated by simple startup commands).
- Internal HTTP communication adds latency (acceptable for paper trading).
- Internal service auth required (mitigated by shared secret token).

---

## DD-003: PostgreSQL as the only database

**Decision:** Single PostgreSQL 16 instance for all persistent state.

**Rationale:**
- ACID transactions are essential for financial state (proposals, fills, portfolio).
- `SELECT FOR UPDATE` prevents race conditions during concurrent approvals.
- No eventual consistency issues with a single authoritative store.
- Audit log `BEFORE DELETE` trigger can be enforced at DB level.
- JSON columns (`JSONB`) handle flexible snapshots without extra tables.

**Rejected alternatives:**
- Redis for caching: unnecessary complexity for paper trading throughput.
- Separate databases per service: two-phase commit complexity far outweighs benefits.
- SQLite: lacks row-level locking, concurrent write safety.

---

## DD-004: No message queue in MVP

**Decision:** Synchronous HTTP between `apps/api` and `services/trading-engine`.

**Rationale:**
- Message queues (RabbitMQ, Kafka) add infrastructure complexity and new failure modes.
- Paper trading throughput is very low (human-in-the-loop by design).
- Synchronous HTTP is easier to test, debug, and reason about.
- If a signal or risk check fails, the error propagates synchronously — no polling needed.

**Future consideration:** If strategy runs on a schedule or needs fan-out, a queue may be added.
Decision is deferred until concrete need is demonstrated.

---

## DD-005: Two-phase risk validation (not one)

**Decision:** Risk is evaluated twice — at proposal creation and again at execution.

**Rationale:**
- Market conditions change between when a signal is generated and when the owner approves.
- Price drift, cash balance, daily P&L can all change in minutes.
- A single risk check at proposal time gives a false sense of safety.
- The second check catches proposals that were safe when created but are no longer.

**Cost:** Extra latency on the approval path (one additional internal HTTP call).
Acceptable for paper trading. Required for correctness.

---

## DD-006: Approval accepts only proposalId, no trading parameters

**Decision:** `POST /trade-proposals/:id/approve` body contains only `{ requestId }`.
All trading parameters are loaded from the database.

**Rationale:**
- Eliminates parameter tampering attacks entirely.
- Owner approves what was proposed — nothing can change between click and execution.
- Frontend cannot accidentally or maliciously inject different quantities/prices.

**Consequence:** The approval UI must display the proposal parameters from the server.
It cannot edit them. This is by design.

---

## DD-007: Proposal trading parameters immutable after PENDING_APPROVAL

**Decision:** A database trigger prevents updates to `symbol`, `side`, `quantity`, `order_type`,
`reference_price`, `limit_price`, `estimated_notional` once status reaches `PENDING_APPROVAL`.

**Rationale:**
- Prevents any path (code bug, admin action) from silently changing what the owner will approve.
- Enforced at the database layer, not just application layer.

---

## DD-008: argon2id for password hashing

**Decision:** Use argon2id (winner of Password Hashing Competition, 2015) for owner password.

**Rationale:**
- Recommended by OWASP as first choice for password hashing (2024).
- Memory-hard, resistant to GPU and ASIC attacks.
- bcrypt is acceptable but has 72-byte truncation vulnerability and lower memory hardness.
- scrypt is acceptable but argon2id tuning is more straightforward.

---

## DD-009: Execution idempotency via database unique constraint

**Decision:** `executions.idempotency_key` has a `UNIQUE` constraint.
Key format: `{proposal_id}:{attempt_number}`. Retries reuse the same key.

**Rationale:**
- Database constraint is the strongest available guarantee — application bugs cannot bypass it.
- `INSERT ... ON CONFLICT DO NOTHING` + return existing row enables safe retry.
- Simpler than distributed locking or two-phase commit.

---

## DD-010: Decimal precision — NUMERIC(18,8) everywhere

**Decision:** All monetary and quantity values use PostgreSQL `NUMERIC(18,8)`.
Application layer uses `Decimal.js` (Node) and Python `decimal.Decimal`.

**Rationale:**
- Binary floating-point (IEEE 754) cannot represent most decimal fractions exactly.
- A price of $150.25 stored as `float` may calculate to $150.24999999999 or $150.25000000001.
- Financial systems must use exact decimal arithmetic.
- `NUMERIC(18,8)` supports up to 10 digits before the decimal and 8 after —
  sufficient for assets priced from $0.00000001 (crypto) to $999,999,999.

**Rounding rule:** `ROUND_HALF_UP` applied only at display time, never during intermediate calculation.

---

## Unresolved Decisions Requiring Owner Input

| ID | Question | Default (Placeholder) | Where Used |
|---|---|---|---|
| UD-001 | Initial paper cash balance | $100,000 | `system_settings.initial_paper_cash` |
| UD-002 | Proposal TTL | 5 minutes | `system_settings.proposal_ttl_seconds` |
| UD-003 | Price drift threshold | 2% | `system_settings.price_drift_threshold_pct` |
| UD-004 | Max order notional | $10,000 | `system_settings.max_order_notional_usd` |
| UD-005 | Max position size | $50,000 | `system_settings.max_position_size_usd` |
| UD-006 | Max portfolio concentration | 20% | `system_settings.max_portfolio_concentration_pct` |
| UD-007 | Max open positions | 10 | `system_settings.max_open_positions` |
| UD-008 | Max daily loss | $1,000 | `system_settings.max_daily_loss_usd` |
| UD-009 | Trading session hours | All hours (no restriction) | `system_settings.trading_session_*` |
| UD-010 | Paper broker fee model | $0.005/share, min $1.00 | `PaperBrokerConfig` |
| UD-011 | Paper broker slippage | 5 bps | `PaperBrokerConfig.slippage_bps` |
| UD-012 | Market data staleness threshold | 60 seconds | `system_settings.market_data_staleness_seconds` |
| UD-013 | Session TTL | 1 hour | `SESSION_TTL_SECONDS` |
| UD-014 | Daily loss reset time | Midnight UTC | `RiskEngine.reset_daily_pnl()` |
