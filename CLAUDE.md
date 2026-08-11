# CLAUDE.md — Permanent Project Rules

This file is loaded into every Claude Code session for this repository.
Do not delete or modify the SAFETY RULES section without explicit owner approval.

---

## PROJECT IDENTITY

**Paper Trading Platform** — human-in-the-loop trading simulator.

Current phase: Paper Trading ONLY. No live broker integration exists or is permitted.

---

## CRITICAL SAFETY RULES (NON-NEGOTIABLE)

These rules apply in every phase unless explicitly superseded by a documented architecture decision signed off by the owner.

1. **No real-money trades.** This system must never submit an order to a real broker.
2. **No live broker SDK.** Do not install or import any live brokerage SDK (Alpaca, Interactive Brokers, TD Ameritrade, etc.) without explicit written approval from the owner.
3. **No live broker credentials.** Never request, store, or reference real broker API keys in code or environment files.
4. **No live trading endpoints.** Do not create HTTP routes that forward orders to an external broker.
5. **No hidden execution paths.** Every order execution path must route through `PaperBrokerAdapter` only.
6. **Strategy isolation.** Strategy code must never import or call any execution layer code.
7. **Owner approval required.** Every simulated trade proposal must wait in `PENDING_APPROVAL` state until the authenticated owner explicitly approves it via the secure API endpoint.
8. **Server-side risk only.** Risk decisions are computed on the server. Frontend values are never trusted.
9. **Kill switch enforced server-side.** A disabled kill switch must be checked on every execution path on the server.
10. **Immutable proposals.** Trading parameters (symbol, side, quantity, price) become immutable once a proposal reaches `PENDING_APPROVAL`.

Violations of these rules must be reverted immediately.

---

## TECHNOLOGY STACK

| Layer | Technology |
|---|---|
| Frontend | Nuxt 3, Vue 3, TypeScript, Tailwind CSS |
| API | Node.js, Express, TypeScript |
| Trading Engine | Python 3.12+, FastAPI |
| Database | PostgreSQL 16 |
| Node testing | Vitest, Supertest |
| Python testing | pytest |
| Containerization | Docker Compose (DB + dev services only) |

---

## MONOREPO STRUCTURE

```
apps/
  web/          — Nuxt frontend
  api/          — Node/Express API (TypeScript)
services/
  trading-engine/  — Python FastAPI trading/quant engine
database/
  migrations/      — SQL migration files (ordered, numbered)
docs/              — Architecture and design documentation
planning/          — Phase checklists and design work
tests/             — Integration and cross-service tests
docker-compose.yml
.env.example
CLAUDE.md
README.md
PHASES.md
```

---

## REQUIRED DOCUMENTATION

These files must stay current and match the actual implementation:

- `docs/ARCHITECTURE.md`
- `docs/ORDER_STATE_MACHINE.md`
- `docs/RISK_ENGINE.md`
- `docs/PAPER_BROKER.md`
- `docs/THREAT_MODEL.md`
- `docs/DATABASE.md`
- `docs/API.md`
- `docs/TEST_PLAN.md`
- `docs/DEVELOPMENT.md`
- `docs/FUTURE_LIVE_TRADING_REQUIREMENTS.md`

---

## WORKING STYLE

Before changing code:
1. Inspect the existing code in the affected area.
2. Identify all affected components.
3. Briefly explain the planned change.

After each phase:
1. Run tests (`npm test` / `pytest`).
2. Run lint and typecheck.
3. Report failures; fix them; rerun.
4. Summarize changed files.
5. Explain important architectural decisions.
6. Identify remaining risks.

Rules:
- Do not silently ignore failing tests.
- Do not weaken tests to make them pass.
- Do not remove safety controls to simplify implementation.
- Do not proceed to the next phase when the current phase is broken.
- When uncertain about financially sensitive behavior, choose the safer implementation and document the unresolved decision.

---

## DISPLAY REQUIREMENT

Every user-facing screen must visibly display:

```
PAPER TRADING
```

Never display "LIVE" in any trading context.

---

## DECIMAL PRECISION

Use `decimal` / `numeric(18,8)` for all monetary and quantity values.
Never use binary floating-point (`float`, `double`) for financial calculations.
Document rounding rules wherever rounding decisions are made.

---

## AUDIT LOG

Every critical operation must emit an audit event before the operation completes.
Audit events are append-only. Never delete or update audit records.
Never include passwords, tokens, or secrets in audit events.

---

## SECRETS

Secrets live in `.env` files (not committed).
`.env.example` documents required variable names with placeholder values only.
Never hardcode credentials in source files.
Never log credentials, tokens, or session data.
