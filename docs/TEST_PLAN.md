# TEST_PLAN.md

## Test Strategy

Testing is layered:

| Layer | Tools | What it tests |
|---|---|---|
| Unit (Node) | Vitest | Individual functions, state machine, services |
| Unit (Python) | pytest | Risk rules, strategy logic, paper broker |
| Integration (Node) | Vitest + Supertest + real DB | API endpoints, DB transactions, auth |
| Integration (Python) | pytest + real DB | Trading engine service methods |
| End-to-end | Playwright (future, Phase 12) | Full browser flows |

---

## Required Test Scenarios (from project spec)

All 20 required scenarios must have automated tests before Paper MVP is declared complete.

### Scenario 1: Valid proposal creation
- Trigger a strategy signal for a valid symbol.
- Risk check passes.
- Verify proposal created with status `PENDING_APPROVAL`.
- Verify all fields are populated correctly.
- Verify audit event `TRADE_PROPOSAL_CREATED` emitted.

### Scenario 2: Risk-rejected proposal
- Trigger a signal that violates `MAX_ORDER_NOTIONAL`.
- Verify no proposal is created.
- Verify risk_check record exists with `result=REJECT` and correct `failedRules`.
- Verify `TRADE_PROPOSAL_CREATED` audit data records the rejected proposal state and reason.

### Scenario 3: Expired proposal cannot be approved
- Create a proposal with `expires_at = NOW() - 1 second`.
- Attempt to approve it.
- Verify HTTP 410 response with `PROPOSAL_EXPIRED`.
- Verify proposal status transitions to `EXPIRED`.

### Scenario 4: Stale market data cannot execute
- Create a valid approved proposal.
- Set market data timestamp to `NOW() - (staleness_threshold + 60 seconds)`.
- Attempt execution.
- Verify rejection with `MARKET_DATA_FRESHNESS` failed rule.

### Scenario 5: Excessive price drift prevents execution
- Create proposal with reference price $100.
- Update market price to $103 (exceeds 2% threshold).
- Approve proposal.
- Verify risk revalidation fails with `PRICE_DRIFT` failed rule.

### Scenario 6: Portfolio changed after proposal creation
- Create proposal when cash = $50,000.
- Drain paper cash to $0 via another fill.
- Attempt to approve original proposal.
- Verify `AVAILABLE_CASH` rule fails during revalidation.

### Scenario 7: Risk passes initially but fails during approval revalidation
- Create a proposal that passes initial risk check.
- Simulate daily loss reaching limit between proposal creation and approval.
- Attempt approval.
- Verify `MAX_DAILY_LOSS` fails in PRE_EXECUTION check.
- Verify proposal transitions to `RISK_REJECTED_AFTER_APPROVAL`.

### Scenario 8: Double-click Approve
- Create a `PENDING_APPROVAL` proposal.
- Send two concurrent POST requests to `/trade-proposals/:id/approve`.
- Verify exactly one approval record is created for the same `requestId`.
- Verify no execution or fill is created by approval alone.
- Verify the duplicate request returns the original approval result (idempotent).

### Scenario 9: Two simultaneous approval requests (different requestIds)
- Create a `PENDING_APPROVAL` proposal.
- Send two concurrent approval requests with different `requestId` values.
- Verify only one approval succeeds; the other gets `INVALID_STATE` (409).
- Verify execution remains a separate Phase 10 action.
- Verify the proposal is not approved twice.

### Scenario 10: Duplicate execution retry
- Create an execution with `idempotency_key = 'test-key-1'`.
- Simulate execution succeeds and creates a fill.
- Retry with the same `idempotency_key`.
- Verify no second fill is created.
- Verify the original fill record is returned.

### Scenario 11: Database rollback
- During proposal approval transaction, inject a DB error after risk check but before execution.
- Verify proposal remains in `PENDING_APPROVAL` (transaction rolled back).
- Verify no execution record created.
- Verify no fill created.
- Verify audit log has no partial events for this attempt.

### Scenario 12: PaperBroker rejection
- Configure PaperBroker to inject a rejection for the next order.
- Approve a valid proposal.
- Verify proposal transitions to `EXECUTION_REJECTED`.
- Verify no fill created.
- Verify `TRADE_EXECUTED` audit data records the broker rejection.

### Scenario 13: Partial fill
- Configure PaperBroker to inject a 50% partial fill.
- Approve a BUY 100 proposal.
- Verify order status is `PARTIALLY_FILLED`.
- Verify fill record for 50 shares created.
- Verify portfolio position updated to 50 shares.
- Verify remaining quantity tracked.

### Scenario 14: Order cancellation
- Create a `PARTIALLY_FILLED` order.
- Submit cancellation request.
- Verify order transitions to `CANCEL_PENDING` then `CANCELLED`.
- Verify portfolio position reflects only the partial fill.
- Verify audit events emitted.

### Scenario 15: Kill switch prevents execution
- Disable kill switch via API.
- Approve a valid proposal.
- Verify approval risk revalidation fails with `KILL_SWITCH` failed rule.
- Verify proposal transitions to `RISK_REJECTED_AFTER_APPROVAL`.
- Verify `TRADE_PROPOSAL_APPROVAL_RISK_REJECTED` audit data records the blocked approval.

### Scenario 16: Unauthorized user cannot approve
- Authenticate as a non-owner user (or unauthenticated).
- Attempt to POST to `/trade-proposals/:id/approve`.
- Verify HTTP 403 Forbidden.
- Verify no state change on the proposal.
- Verify audit event `UNAUTHORIZED_APPROVAL_ATTEMPT` emitted.

### Scenario 17: Proposal fields cannot be modified after PENDING_APPROVAL
- Create a proposal in `PENDING_APPROVAL`.
- Attempt to UPDATE the proposal's symbol/quantity/price via SQL directly.
- Verify the DB trigger rejects the update.
- Verify via API that no tampering endpoint exists.

### Scenario 18: Restart/recovery while execution is in progress
- Create an execution in `SUBMITTING` state (simulating a crash mid-execution).
- Restart the application.
- Verify a recovery mechanism detects the stuck execution.
- Verify the execution is retried with the same idempotency key.
- Verify no duplicate fill is created.

### Scenario 19: Audit events are generated correctly
- Execute a complete happy-path flow: signal → proposal → approve → fill.
- Verify audit log contains, in order:
  - `TRADE_PROPOSAL_CREATED`
  - `TRADE_PROPOSAL_APPROVED`
  - `TRADE_EXECUTED`
- Verify each event has: `event_type`, `actor_id`, `entity_id`, `request_id`, `timestamp`.
- Verify persisted risk checks, execution rows, order rows, and fill rows provide the detailed event trail between audit records.
- Verify no audit record is missing.

### Scenario 20: Strategy cannot bypass Risk Engine and Approval layer
- Inspect strategy module imports — verify no import of broker, execution, or approval modules.
- Write a test that calls the strategy directly and verifies:
  - Return value is a `Signal` object only.
  - No side effects on `orders`, `executions`, `fills`, or `trade_proposals` tables.
  - Strategy cannot be used to trigger execution directly.

---

## Phase 27 Hourly Trading Test Scenarios

Covers the CLAUDE.md/Phase 27 requirement list specifically. See
`docs/PHASE_27_HOURLY_TRADING.md` for full architecture context.

### Scenario 21: One signal max per symbol per completed 1H candle
- Call `tick()` against a watchlist symbol with a newly closed 1H candle.
- Verify exactly one `hourly_candle_processing` row and one proposal are
  created for that `(symbol, candle_timestamp)`.
- Location: `apps/api/src/__tests__/hourly-scheduler.test.ts`,
  `services/trading-engine/tests/test_hourly.py`.

### Scenario 22: Restart does not duplicate candle processing
- Call `tick()` twice against the same latest closed candle (no in-memory
  state carries over between calls — this simulates a process restart).
- Verify the second call claims nothing new and creates no second proposal.
- Location: `apps/api/src/__tests__/hourly-scheduler.test.ts`.

### Scenario 23: Incomplete candle cannot trigger
- Present a bar whose close time (`open + 1h`) is in the future.
- Verify the scheduler never claims it, and `analyze_hourly` never uses a
  bar timestamped after `now` (no-look-ahead).
- Location: `apps/api/src/__tests__/hourly-scheduler.test.ts`,
  `services/trading-engine/tests/test_hourly.py`.

### Scenario 24: BUY / SELL / HOLD decisions
- Confirmed uptrend with no open position → `BUY` with an ATR bracket.
- Confirmed downtrend with an open position → `SELL`, no bracket.
- Flat/unconfirmed series → `HOLD`.
- Location: `services/trading-engine/tests/test_hourly.py`,
  `apps/api/src/__tests__/hourly.test.ts`.

### Scenario 25: Risk rejection overrides the AI decision
- Mock a `BUY` analysis with a session status other than
  `OPEN_FOR_ENTRIES`.
- Verify the proposal transitions to `RISK_REJECTED` with
  `PHASE27_SESSION_STATUS` in `failedRules`, despite the AI decision.
- Location: `apps/api/src/__tests__/hourly.test.ts`.

### Scenario 26: Owner approval required
- Verify a `BUY`/`SELL` decision always creates a `PENDING_APPROVAL`
  proposal, never an executed order, and that
  `POST /trade-proposals/:id/approve` requires `role='owner'`.
- Location: `apps/api/src/__tests__/hourly.test.ts` (reuses the generic
  approval-authorization tests already covering every proposal source).

### Scenario 27: Duplicate approval protection
- Approve the same proposal twice with the same `requestId`.
- Verify the second call is idempotent (same result, no second broker
  order submitted).
- Location: `apps/api/src/__tests__/hourly.test.ts`.

### Scenario 28: Bracket take-profit / stop-loss
- Approve a `BUY` proposal; verify the submitted order carries
  `bracket: {stop_loss_price, take_profit_price}` matching the Phase 27
  risk snapshot, with no `fractionable`/`fee_bps` fields (whole shares, not
  crypto).
- Location: `apps/api/src/__tests__/hourly.test.ts`.

### Scenario 29: Max daily loss
- Verify `PHASE27_MAX_DAILY_LOSS` (Node) and the shared Python
  `MAX_DAILY_LOSS` rule both gate hourly proposals identically to every
  other phase.
- Location: `apps/api/src/__tests__/hourly.test.ts` (reuses the generic
  daily-loss mechanism already tested by `trade-proposals.test.ts`).

### Scenario 30: Cooldown
- Approve and fill a `BUY` proposal for a symbol, then immediately attempt
  another hourly decision for the same symbol.
- Verify `PHASE27_COOLDOWN` blocks it (default `phase27_cooldown_seconds_
  per_symbol` = 3600s, one candle).
- Location: `apps/api/src/__tests__/hourly.test.ts`.

### Scenario 31: Max trades per day
- Reach `phase27_max_trades_per_symbol_per_day`, then attempt one more.
- Verify `PHASE27_MAX_TRADES_PER_SYMBOL_PER_DAY` rejects it.
- Location: `apps/api/src/__tests__/hourly.test.ts`.

### Scenario 32: Pending order blocking
- With an active (non-terminal-status) order already open for a symbol,
  attempt a new hourly decision for that symbol.
- Verify `PHASE27_DUPLICATE_PENDING_ORDER` rejects it (shared mechanism,
  `findActiveOrdersBySymbol`, already exercised by Phase 22/25/26 tests).

### Scenario 33: End-of-day behavior
- Fast-forward an open hourly position's `created_at` past
  `phase27_max_holding_hours`, or move `now` into the session's
  `FORCE_CLOSE_WINDOW`/`CLOSED` state.
- Verify `reconcileHourlyTimeExits` closes the position with exit reason
  `MAX_HOLDING_TIME` or `END_OF_DAY`, cancelling the pending bracket first,
  with no new owner approval required, and that a second pass is a no-op.
- Location: `apps/api/src/__tests__/hourly.test.ts`, following the
  `UPDATE orders SET created_at = NOW() - INTERVAL '...'` time-fast-forward
  pattern already used in `intraday.test.ts`.

### Scenario 34: Accounting/reconciliation unchanged
- Run the existing `position-accounting.test.ts` suite unmodified against
  hourly fills — weighted-average cost, realized/unrealized P&L, and fee
  handling are asset/phase-agnostic and required zero changes for this
  phase.

---

## Additional Test Areas

### State Machine Tests
For every (from_state, event) pair in the state machine:
- Valid transition → succeeds.
- Invalid transition → raises `InvalidStateTransitionError` and does not persist.

### Risk Rule Unit Tests
For each of the 15 risk rules:
- Passing case (values just under threshold).
- Failing case (values just over threshold).
- Boundary case (values at exactly the threshold).
- Rule returns correct `failedRules` name in output.

### Authentication Tests
- Login with correct credentials → 200, session token.
- Login with wrong password → 401, audit logged.
- Login with unknown email → 401 (same error, no user enumeration).
- Access protected route without token → 401.
- Access protected route with expired token → 401.
- Access owner route as non-owner → 403.
- Logout invalidates session → subsequent requests → 401.

### Proposal Immutability Tests
- Trading parameters cannot be changed after `PENDING_APPROVAL`.
- Verify via DB trigger and API.

### Decimal Precision Tests
- P&L calculations use exact decimal arithmetic.
- No floating-point rounding errors in fill price × quantity.
- Fee calculations round consistently (ROUND_HALF_UP).

---

## Test Database Strategy

- Integration tests use a dedicated test PostgreSQL database.
- Each test suite runs migrations from scratch (or uses a shared test DB with transaction rollback).
- Preferred: wrap each test in a transaction that is rolled back after the test.
- Seed data is applied via fixtures, not manual SQL.
- CI runs tests against a real PostgreSQL container (not SQLite or mock).

---

## Test Coverage Targets

| Area | Target |
|---|---|
| Risk engine rules | 100% of rules tested |
| State machine transitions | 100% of valid and invalid transitions |
| API endpoints (happy path) | 100% |
| API endpoints (error cases) | All documented error codes |
| Required scenarios (1–20) | 100% |
| Concurrency scenarios (8, 9) | Must use concurrent requests, not sequential |

---

## Test File Locations

```
apps/api/
  src/
    __tests__/
      auth.test.ts
      proposals.test.ts
      approval.test.ts
      execution.test.ts
      risk.test.ts
      state-machine.test.ts
      portfolio.test.ts
      audit.test.ts
      concurrent-approval.test.ts
      idempotency.test.ts

services/trading-engine/
  tests/
    test_risk_engine.py
    test_paper_broker.py
    test_strategy.py
    test_market_data.py
    test_portfolio.py
    test_state_machine.py
```

---

## Continuous Integration

On every PR / push to main:
1. Run `npm run lint` and `npm run typecheck` (apps/api, apps/web).
2. Run `ruff check` and `mypy` (services/trading-engine).
3. Run all Node tests (`vitest run`).
4. Run all Python tests (`pytest`).
5. Fail PR if any test fails.
6. Fail PR if coverage drops below targets.

No test may be weakened or skipped to achieve a pass.
