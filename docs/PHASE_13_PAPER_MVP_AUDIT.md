# Phase 13 Paper MVP Audit

Phase 13 reviewed the completed Paper MVP across architecture, security,
approval, execution, risk controls, concurrency, idempotency, accounting, and
recovery. No live trading or real-money features were added.

## Audit Result

One correctness and safety issue was found and fixed:

- Execution was a separate API call after owner approval, but the execution
  path did not recheck the persisted paper safety settings before submitting to
  the paper broker. If the kill switch was disabled after approval but before
  execution, an approved proposal could still be submitted.

The fix adds an execution-time gate that blocks broker submission unless:

- `trading_mode` is `PAPER`
- `trading_kill_switch_enabled` is `true`

Blocked execution leaves the proposal in `APPROVED`, creates no execution row,
and does not call the broker, so the owner can retry after restoring safe
settings.

## Reviewed Areas

| Area | Result |
|---|---|
| Architecture | Strategy remains signal-only. API owns approval and execution orchestration. Trading engine exposes only paper broker execution. |
| Security | Approval, rejection, execution, kill-switch, and risk-setting mutations require owner auth. Internal engine calls use service-token headers. |
| Phase 9 approval | Approval uses immutable proposal rows, owner-only auth, request IDs, row locking, risk revalidation, expiration checks, and audit logs. |
| Phase 10 execution | Execution uses approved proposal rows, a stable idempotency key, row locking, paper broker submission only, order/fill persistence, and retry after transient errors. |
| Risk controls | Risk engine rejects disabled kill switch, non-PAPER mode, stale data, price drift, insufficient cash/position, exposure, concentration, daily loss, sessions, and cooldown. |
| Concurrency | Proposal approval and execution acquire `SELECT FOR UPDATE` locks. DB uniqueness protects duplicate approvals, executions, and broker fill IDs. |
| Accounting | Fills update paper positions with Decimal arithmetic. Portfolio snapshots are written after execution outcomes. |
| Recovery | Failed broker submission records `EXECUTION_ERROR`; retry reuses the same execution and idempotency key. |

## Validation

- Node test suite passed.
- Node lint passed.
- Node typecheck passed.
- Python pytest passed.
- Python ruff passed.
- Python mypy passed.

DB-backed integration tests continue to skip when `TEST_DATABASE_URL` is not
configured, following the existing test convention.
