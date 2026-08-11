# Phase 12 Failure Test Report

Phase 12 validates the Paper MVP failure paths across the Node API and Python
trading engine. DB-backed Node integration scenarios use `TEST_DATABASE_URL`
and skip when that environment variable is not configured, following the
existing project test convention.

## Required Scenario Coverage

| # | Scenario | Automated Coverage |
|---|---|---|
| 1 | Valid proposal creation | `apps/api/src/__tests__/trade-proposals.test.ts` |
| 2 | Risk-rejected proposal | `apps/api/src/__tests__/trade-proposals.test.ts`, `services/trading-engine/tests/test_risk.py` |
| 3 | Expired proposal cannot be approved | `apps/api/src/__tests__/trade-proposals.test.ts` |
| 4 | Stale market data cannot execute | `services/trading-engine/tests/test_risk.py` |
| 5 | Excessive price drift prevents execution | `apps/api/src/__tests__/trade-proposals.test.ts`, `services/trading-engine/tests/test_risk.py` |
| 6 | Portfolio changed after proposal creation | `services/trading-engine/tests/test_risk.py` |
| 7 | Risk passes initially but fails during approval revalidation | `apps/api/src/__tests__/trade-proposals.test.ts`, `services/trading-engine/tests/test_risk.py` |
| 8 | Double-click approve / duplicate request | `apps/api/src/__tests__/trade-proposals.test.ts` |
| 9 | Simultaneous approval requests with different request IDs | `apps/api/src/__tests__/trade-proposals.test.ts` |
| 10 | Duplicate execution retry | `apps/api/src/__tests__/trade-proposals.test.ts`, `services/trading-engine/tests/test_broker.py` |
| 11 | Database rollback | DB-backed transaction tests in `apps/api/src/__tests__/trade-proposals.test.ts` exercise rollback on failed execution submission. |
| 12 | PaperBroker rejection | `apps/api/src/__tests__/trade-proposals.test.ts`, `services/trading-engine/tests/test_broker.py` |
| 13 | Partial fill | `apps/api/src/__tests__/trade-proposals.test.ts`, `services/trading-engine/tests/test_broker.py` |
| 14 | Order cancellation | `services/trading-engine/tests/test_broker.py` |
| 15 | Kill switch prevents execution | `services/trading-engine/tests/test_risk.py`, `apps/api/src/__tests__/risk.test.ts` |
| 16 | Unauthorized user cannot approve | `apps/api/src/__tests__/trade-proposals.test.ts`, auth middleware tests |
| 17 | Proposal fields cannot be modified after `PENDING_APPROVAL` | `apps/api/src/__tests__/db/triggers.test.ts` |
| 18 | Restart/recovery while execution is in progress | `apps/api/src/__tests__/trade-proposals.test.ts` |
| 19 | Audit events generated correctly | Audit assertions are distributed across auth, proposal, approval, execution, and settings tests. |
| 20 | Strategy cannot bypass risk/approval/execution | `services/trading-engine/tests/test_strategy.py` |

## Phase 12 Checklist Mapping

| Checklist Item | Coverage |
|---|---|
| Network timeout simulation | `apps/api/src/__tests__/trading-engine-client.test.ts` |
| Duplicate request test | Approval and execution idempotency tests in `trade-proposals.test.ts` |
| Database error test | Transaction rollback expectations in DB-backed Node integration tests |
| PaperBroker unavailable test | `trading-engine-client.test.ts`, `test_broker.py`, execution recovery test |
| Partial fill test | Node execution partial-fill test and Python broker partial-fill tests |
| Application restart test | Node execution retry through a fresh Express app instance |
| Simultaneous approval test | Competing approval test in `trade-proposals.test.ts` |
| Stale market data test | Python risk freshness tests |
| Price movement test | Python risk price-drift tests and Node approval revalidation test |
| Daily loss limit test | Python risk daily-loss tests |
| Kill switch test | Python risk kill-switch tests and Node risk route tests |

## Final Review Notes

- The API remains paper-trading only; there is no live broker adapter.
- Strategy code emits signals only and has static boundary tests preventing
  broker/router imports.
- Owner approval and execution are separate API calls. This matches the Phase 9
  and Phase 10 implementation where approval stops at `APPROVED`.
- The frontend approval flow sends only a generated `requestId` and optional
  rejection reason; trading parameters are loaded from immutable proposal rows.
