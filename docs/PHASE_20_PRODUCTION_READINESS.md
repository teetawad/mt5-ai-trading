# Phase 20 Production Readiness Report

Date: 2026-08-11

Scope: PAPER trading system only. This phase reviewed security and production-readiness controls across the API, dashboard, database-backed approval/execution workflow, market-data integration, Alpaca PAPER broker adapter, tests, and dependencies. No live trading or real-money execution was added.

## Executive Summary

The PAPER trading system is structurally production-oriented for paper validation: execution remains paper-only, owner approval remains server-side, risk validation is enforced before approval and execution, proposal/execution writes use database transactions, and duplicate execution is constrained through stable idempotency keys.

Two high-risk issues were fixed:

- Cookie-authenticated state-changing API requests did not require an anti-CSRF token.
- `vitest` carried high/critical development dependency advisories through its nested Vite chain.

Residual production-readiness gaps are operational rather than code-level blockers for PAPER deployment: configure managed secrets, database backups, centralized logs/metrics/alerts, TLS termination, explicit `CORS_ORIGIN`, and the Phase 17 real long-run Alpaca PAPER environment before unattended paper validation.

## Fixes Applied

| Area | Risk | Fix |
| --- | --- | --- |
| CSRF | Browser session cookies could be used on cross-site unsafe requests despite `SameSite=strict` being present. | Added double-submit CSRF protection for `POST`, `PUT`, `PATCH`, and `DELETE` when a `session` cookie is present. Bearer-token API clients remain supported. |
| Dashboard API calls | New CSRF enforcement would otherwise block browser approval/settings actions. | Dashboard API wrapper now reads `csrf_token` and sends `X-CSRF-Token` on unsafe methods. |
| Auth cookies | No CSRF nonce was issued at login. | Login now emits a random `csrf_token` cookie and returns `csrfToken`; logout clears it. |
| Dependency security | `npm audit` reported high/critical advisories through `vitest <3.2.6`. | Upgraded API workspace `vitest` to `^4.1.10`; `npm audit --audit-level=high` now reports zero vulnerabilities. |

## Review Results

| Topic | Status | Notes |
| --- | --- | --- |
| Authentication and authorization | Pass with operational requirements | JWT sessions require `SESSION_SECRET`; owner-only routes use `requireOwner`; login is rate-limited outside tests. Production must set a strong secret and TLS. |
| Owner approval security | Pass | Approval/rejection requires owner role, persists audit events, revalidates risk, and uses row locks for concurrency. |
| API validation | Pass | Routes validate required payloads, symbols, dates, and settings; invalid requests fail closed with 4xx. |
| Secrets and environment variables | Pass with operational requirements | Alpaca PAPER credentials and session/internal tokens are environment-only. No live credential path was added. |
| CSRF/XSS/session risks | Fixed | CSRF protection added for browser-cookie unsafe requests. Helmet remains enabled. Session cookie is `HttpOnly`, `SameSite=strict`, and `Secure` in production. |
| Replay and duplicate requests | Pass | Approval request IDs and execution idempotency keys prevent duplicate state transitions/orders. |
| Race conditions | Pass | Approval/execution paths use DB transactions and `SELECT FOR UPDATE` on proposal rows. |
| Idempotency | Pass | Execution uses stable key `proposal:{proposalId}:attempt:1`; Alpaca PAPER adapter maps it to `client_order_id`. |
| Database transactions | Pass | Critical approval/execution workflows commit or roll back atomically. DB-backed tests skip when `TEST_DATABASE_URL` is not configured. |
| Audit logs | Pass | Login, logout, proposal approval/rejection, settings, and execution events are audited; audit immutability is DB-enforced when migrations are run. |
| Kill switch | Pass | Risk and execution paths check kill switch; dashboard exposes PAPER kill switch state/control. |
| Broker reconciliation | Pass for implemented PAPER scope | Alpaca PAPER adapter supports account/positions/orders synchronization and state mapping; operational long-run reconciliation still depends on Phase 17 environment configuration. |
| Market-data failure handling | Pass | Provider abstraction handles freshness, stale data, rate limit, reconnect/error handling, and API failure mapping. |
| Logging and monitoring | Partial | HTTP logs and validation reports exist. Production PAPER deployment should add centralized log retention, alert thresholds, and metrics dashboards. |
| Dependency/security issues | Fixed | `npm audit --audit-level=high` is clean after Vitest upgrade; `pip check` reports no broken Python requirements. |
| Backup/recovery | Partial | Recovery logic exists for failed execution/retry. Database backups, restore drills, and retention policy remain deployment tasks. |

## Paper-Only Boundary

The review confirmed:

- Alpaca trading adapter defaults to `https://paper-api.alpaca.markets`.
- Live Alpaca trading endpoint URLs are rejected.
- Execution path requires internal PAPER trading mode.
- No live trading endpoint, live broker adapter, or real-money execution feature was added in Phase 20.

## Validation

Commands run:

| Command | Result |
| --- | --- |
| `npm.cmd run test --workspace=apps/api -- src/__tests__/auth/middleware.test.ts` | Pass, 11 tests |
| `npm.cmd run test --workspace=apps/api -- src/__tests__/auth/auth-routes.test.ts` | Pass, 2 run / 12 skipped without DB |
| `npm.cmd run test` | Pass, 61 run / 50 skipped without DB |
| `npm.cmd run lint` | Pass |
| `npm.cmd run typecheck` | Pass |
| `npm.cmd run build --workspace=apps/api` | Pass |
| `NUXT_IGNORE_LOCK=1 npm.cmd run build --workspace=apps/web` | Pass |
| `services/trading-engine/.venv/Scripts/python.exe -m pytest` | Pass, 233 run / 3 skipped |
| `services/trading-engine/.venv/Scripts/python.exe -m ruff check .` | Pass |
| `services/trading-engine/.venv/Scripts/python.exe -m mypy .` | Pass |
| `services/trading-engine/.venv/Scripts/python.exe -m pip check` | Pass |
| `npm.cmd audit --audit-level=high` | Pass, 0 vulnerabilities |

Notes:

- The web build required `NUXT_IGNORE_LOCK=1` because a Nuxt dev server lock already existed for port 3000.
- Python pytest emitted a cache warning about `.pytest_cache`; tests still passed.
- Some DB integration tests remain skipped without `TEST_DATABASE_URL`; this is expected in the local environment and should be run against a dedicated test database before PAPER production operation.

## Production Readiness Decision

Code-level readiness for PAPER trading: ready for controlled PAPER deployment after environment configuration.

Required before unattended or long-running PAPER operation:

- Set strong `SESSION_SECRET`, `INTERNAL_SERVICE_TOKEN`, `DATABASE_URL`, explicit `CORS_ORIGIN`, and Alpaca PAPER credentials through a secret manager or locked-down environment.
- Run migrations and DB integration tests against the target PostgreSQL environment.
- Configure backups, restore testing, log retention, monitoring, and alerts for stale market data, broker reconciliation drift, order errors, and kill switch changes.
- Keep the system labeled and configured as PAPER TRADING only.
