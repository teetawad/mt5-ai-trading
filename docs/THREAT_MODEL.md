# THREAT_MODEL.md

## Scope

This threat model covers the Paper Trading Platform MVP.
Real-money trading is not in scope because this system does not connect to a live broker.
The primary risk is unauthorized use of the approval workflow, data tampering, and loss of audit integrity.

---

## Assets to Protect

| Asset | Sensitivity | Impact of Compromise |
|---|---|---|
| Owner authentication credentials | Critical | Full system takeover |
| Trade approval mechanism | Critical | Unauthorized order execution |
| Audit log integrity | High | Loss of accountability |
| Portfolio state (paper) | Medium | Incorrect P&L, bad risk decisions |
| Risk engine configuration | Medium | Risk controls bypassed |
| Kill switch state | High | Orders execute when should be blocked |
| Session tokens | High | Account takeover without credentials |
| Internal service auth token | High | Bypass API layer |
| Database connection string | Critical | Direct DB access, data destruction |

---

## Threat Actors

| Actor | Motivation | Capability |
|---|---|---|
| External attacker | Curiosity, practice, harm | Moderate — web scanning, OWASP attacks |
| Compromised browser session | Stolen cookie/token | Can act as the owner |
| Malicious script / XSS | Run code in owner's browser | Same-origin requests as owner |
| Insider (if multi-user ever added) | Unauthorized trading | Full API access |
| Automated bot | Replay attacks, brute force | High volume, fast |

---

## Threat Analysis

### T1: Stolen Browser Session
**Attack:** Attacker obtains the owner's session cookie (via XSS, network sniff, shoulder-surf).
**Impact:** Full access to approval workflow, settings, kill switch.
**Mitigations:**
- `HttpOnly` cookie flag prevents JS access.
- `Secure` flag prevents transmission over plain HTTP.
- `SameSite=Strict` prevents CSRF with cookies.
- Short session TTL (configurable, e.g. 1 hour).
- Session invalidation on logout (server-side).
- Audit log on every login, suspicious activity.

---

### T2: CSRF (Cross-Site Request Forgery)
**Attack:** Malicious site tricks owner's browser into submitting an approval request.
**Impact:** Proposal approved without owner intent.
**Mitigations:**
- `SameSite=Strict` on session cookie.
- CSRF token required on all state-changing endpoints.
- `Origin`/`Referer` header validation.
- JSON-only request bodies (form-based CSRF less effective).

---

### T3: XSS (Cross-Site Scripting)
**Attack:** Injected script runs in owner's browser, exfiltrates session, submits approvals.
**Impact:** Account takeover, unauthorized trades.
**Mitigations:**
- Content Security Policy (CSP) header restricts script sources.
- All user-generated content escaped in Vue templates (default in Vue 3).
- No `v-html` with untrusted content.
- Input sanitization on all string fields.
- `HttpOnly` cookie prevents session theft via JS.

---

### T4: Parameter Tampering During Approval
**Attack:** Attacker modifies the approval request to include different trading parameters
(e.g., change quantity, symbol, or price in the request body).
**Impact:** Execute a different trade than the owner approved.
**Mitigations (critical design choice):**
- `POST /trade-proposals/:id/approve` accepts **only** `{ requestId }`.
- All trading parameters are loaded from the database using the proposal ID.
- Server ignores any trading parameters in the approval request body.
- Validation rejects unexpected fields.

---

### T5: Replay Attack on Approval
**Attack:** Attacker captures a valid approval request and replays it later.
**Impact:** Approve a proposal that has expired or already been acted on.
**Mitigations:**
- `requestId` is a client-generated UUID stored in `trade_approvals`.
- `UNIQUE (proposal_id, request_id)` constraint prevents duplicates.
- Proposal state machine prevents re-approval (only `PENDING_APPROVAL` can be approved).
- Proposal expiration enforced server-side.

---

### T6: Double-Click / Duplicate Approval
**Attack:** Owner double-clicks Approve; two concurrent approval requests arrive.
**Impact:** Duplicate order execution (buy twice).
**Mitigations:**
- `SELECT ... FOR UPDATE` on the proposal row serializes concurrent access.
- State check inside the lock: only `PENDING_APPROVAL` can transition.
- Idempotency key on execution prevents duplicate paper orders.
- Frontend disables button after first click (defense-in-depth only, not relied upon).

---

### T7: Duplicate Execution Retry
**Attack:** Network failure causes API to retry the execution request; paper broker executes twice.
**Impact:** Double fill, corrupted portfolio.
**Mitigations:**
- `executions.idempotency_key` has a `UNIQUE` constraint.
- `INSERT ... ON CONFLICT DO NOTHING` returns the existing execution.
- `PaperBrokerAdapter.submit_order` is idempotent by `idempotency_key`.

---

### T8: Stale Proposals
**Attack:** Owner approves a proposal created hours ago at a materially different price.
**Impact:** Execution at bad price; risk controls may no longer apply.
**Mitigations:**
- Proposal TTL enforced at approval time.
- Price drift check at approval time.
- Market data freshness check at approval time.
- Second full risk evaluation at approval time.

---

### T9: Malicious Approval Request (Unauthorized User)
**Attack:** Someone other than the owner submits an approval request.
**Impact:** Unauthorized trade.
**Mitigations:**
- All approval endpoints require authentication.
- Role check: only `role='owner'` may approve.
- Audit log records who approved, from what IP.

---

### T10: Risk Engine Bypass
**Attack:** A strategy or external caller submits a proposal directly to the execution layer,
bypassing the risk engine.
**Impact:** Unvalidated trade execution.
**Mitigations:**
- Strategy code cannot import execution module (enforced by module structure).
- Execution endpoints require a valid proposal ID in `APPROVED` state.
- Risk revalidation is mandatory immediately before execution.
- Test 20 (strategy cannot bypass risk engine) is part of the required test suite.

---

### T11: Kill Switch Bypass
**Attack:** Attacker disables kill switch check in code, or sends a request that bypasses it.
**Impact:** Execution proceeds when globally blocked.
**Mitigations:**
- Kill switch loaded from database on every execution, not cached in memory.
- RISK_CHECKING rule 1 is KILL_SWITCH; failure is immediate REJECT.
- Frontend kill switch display is read-only informational; never trusted server-side.

---

### T12: Audit Log Tampering
**Attack:** Someone modifies or deletes audit records to hide unauthorized activity.
**Impact:** Loss of accountability and incident investigation capability.
**Mitigations:**
- Database trigger prevents UPDATE or DELETE on `audit_logs`.
- Application layer never issues UPDATE/DELETE on audit_logs.
- Audit log access is read-only via API (no modification endpoints).
- Future: write-ahead log or external audit export.

---

### T13: Leaked API Keys / Secrets
**Attack:** Internal service token or DB credentials exposed in code, logs, or error messages.
**Impact:** Service impersonation, direct DB access.
**Mitigations:**
- Secrets managed via environment variables only.
- `.env` files in `.gitignore`.
- `.env.example` contains only placeholder values.
- Error responses never include stack traces or internal details in production.
- Logs scrubbed of credentials.

---

### T14: SQL Injection
**Attack:** Malicious input exploits string interpolation in SQL queries.
**Impact:** Data exfiltration, modification, or deletion.
**Mitigations:**
- Parameterized queries used exclusively.
- No string concatenation in SQL.
- ORM or query builder used with strict input types.

---

### T15: Dependency Compromise
**Attack:** A malicious npm/pip package in the dependency tree.
**Impact:** Arbitrary code execution, data exfiltration.
**Mitigations:**
- Lock files committed (`package-lock.json`, `requirements.txt` with pinned versions).
- Dependency audit in CI (`npm audit`, `pip-audit`).
- Minimal dependency surface.
- No automatic dependency updates without review.

---

### T16: Unauthorized Database Access
**Attack:** Attacker accesses PostgreSQL directly, bypassing application layer.
**Impact:** Read all trades, modify state, disable controls.
**Mitigations:**
- DB not exposed on public network (Docker Compose, no public port in prod).
- Dedicated application DB user with minimal required permissions.
- Strong unique DB password in environment variable.
- `audit_logs` trigger enforced at DB level.

---

## Controls Summary

| Category | Control |
|---|---|
| Authentication | argon2id hashing, session tokens, rate limiting |
| Authorization | Role-based, checked on every request |
| CSRF | SameSite cookie, CSRF token, Origin validation |
| XSS | CSP, Vue template escaping, no v-html |
| Parameter tampering | Approval accepts ID only; parameters loaded from DB |
| Replay | requestId uniqueness constraint |
| Concurrency | SELECT FOR UPDATE, idempotency keys |
| Audit | Append-only audit log, DB trigger protection |
| Secrets | Env vars, no hardcoding, scrubbed logs |
| SQL injection | Parameterized queries only |
| Dependencies | Locked versions, audit tooling |

---

## Out of Scope (Paper Trading Phase)

- Physical security of the host machine.
- TLS certificate management (assumed terminated at reverse proxy).
- DDoS mitigation (assumed handled at network layer).
- Live broker credential theft (no live broker in this phase).

---

## Residual Risks

- The `apps/api` ↔ `trading-engine` internal HTTP communication currently has no mTLS.
  Mitigation: internal network only, shared secret token. Future: add mTLS.
- Single-factor authentication. Future: WebAuthn / MFA.
- Limit order queue is in-memory; restart loses pending limits.
  Acceptable for paper trading MVP.
