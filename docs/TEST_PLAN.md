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
