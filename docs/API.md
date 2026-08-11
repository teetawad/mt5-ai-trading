# API.md

## Overview

The `apps/api` service (Node/Express/TypeScript) is the only API the frontend calls.
The `services/trading-engine` (Python/FastAPI) is an **internal** API only.

All responses use `Content-Type: application/json`.
All timestamps are ISO 8601 UTC (`2024-01-15T10:30:00.000Z`).
All monetary values are returned as strings (not numbers) to preserve decimal precision.

---

## Authentication

All endpoints except `/health` and `/auth/login` require a valid session.

```
POST   /auth/login          — authenticate owner
POST   /auth/logout         — invalidate session
GET    /auth/me             — current authenticated user
```

### POST /auth/login

Request:
```json
{
  "email": "owner@example.com",
  "password": "..."
}
```

Response 200:
```json
{
  "user": { "id": "...", "email": "...", "displayName": "..." },
  "sessionToken": "..."
}
```

Response 401:
```json
{ "error": "INVALID_CREDENTIALS" }
```

Notes:
- Password is hashed with argon2id. Never returned or logged.
- Session token is an opaque signed JWT or server-side session ID.
- Failed login attempts are audit logged (no password in log).
- Rate limiting applies.

---

## Health

```
GET /health     — returns 200 if API is up
GET /health/db  — returns 200 if DB is reachable
```

---

## System Settings

```
GET  /settings                  — list all system settings
PUT  /settings/:key             — update a setting (owner only)
GET  /settings/kill-switch      — current kill switch state
PUT  /settings/kill-switch      — { "enabled": true|false } (owner only)
```

### PUT /settings/kill-switch

Request:
```json
{ "enabled": false }
```

Response 200:
```json
{
  "key": "trading_kill_switch_enabled",
  "value": false,
  "updatedAt": "2024-01-15T10:30:00.000Z"
}
```

Note: Audit logged. Kill switch change takes effect immediately on the server.

---

## Market Data

```
GET /market-data/snapshot/:symbol   — current snapshot for a symbol
GET /market-data/snapshots          — all tracked symbols
```

Additional Phase 14 market data routes:

```
GET /market-data/symbols            - tracked symbol list
GET /market-data/bars/:symbol       - historical bars
GET /market-data/quote/:symbol      - latest quote
GET /market-data/trade/:symbol      - latest trade
```

### GET /market-data/snapshot/:symbol

Response 200:
```json
{
  "symbol": "AAPL",
  "price": "150.25",
  "bid": "150.24",
  "ask": "150.26",
  "volume": 1234567,
  "timestamp": "2024-01-15T10:30:00.000Z",
  "isStale": false
}
```

Response 404: Symbol not found.
Response 200 with `"isStale": true`: Data older than `market_data_staleness_seconds`.

### GET /market-data/bars/:symbol

Query params:
- `timeframe`: Alpaca timeframe such as `1Min`, `5Min`, `1Hour`, or `1Day`
- `start`: ISO 8601 start timestamp
- `end`: optional ISO 8601 end timestamp
- `limit`: optional, 1 to 10000, default 100

Response 200:
```json
[
  {
    "symbol": "AAPL",
    "open": "190.00000000",
    "high": "192.00000000",
    "low": "189.00000000",
    "close": "191.00000000",
    "volume": 1000,
    "timestamp": "2026-08-10T13:30:00Z",
    "tradeCount": 42,
    "vwap": "190.75000000"
  }
]
```

### GET /market-data/quote/:symbol

Response 200:
```json
{
  "symbol": "AAPL",
  "bid": "191.20000000",
  "ask": "191.30000000",
  "bidSize": 100,
  "askSize": 200,
  "timestamp": "2026-08-10T13:30:01Z",
  "isStale": false
}
```

### GET /market-data/trade/:symbol

Response 200:
```json
{
  "symbol": "AAPL",
  "price": "191.25000000",
  "size": 50,
  "timestamp": "2026-08-10T13:30:02Z",
  "exchange": "V",
  "tradeId": 123,
  "isStale": false
}
```

Alpaca-backed requests may return `429 RATE_LIMITED`. Providers that do not
support historical bars, quotes, or trades return `501 NOT_SUPPORTED`.

---

## Strategies

```
GET  /strategies        — list all strategies
GET  /strategies/:id    — strategy detail
POST /strategies/:id/run  — manually trigger signal generation (owner only)
```

---

## Signals

```
GET /signals            — list recent signals (paginated)
GET /signals/:id        — signal detail
POST /signals           — create a signal and run pre-proposal risk (owner only)
```

### POST /signals

Request:
```json
{
  "strategyId": "...",
  "symbol": "AAPL",
  "side": "BUY",
  "quantity": "10.00000000",
  "orderType": "MARKET",
  "referencePrice": "150.25",
  "reason": "Manual paper-trading signal"
}
```

Response 201:
```json
{
  "signal": { "id": "...", "status": "RISK_PASS" },
  "riskCheck": { "id": "...", "result": "PASS" },
  "riskResult": { "result": "PASS", "failed_rules": [] },
  "proposal": { "id": "...", "status": "PENDING_APPROVAL" }
}
```

Notes:
- The API persists the signal, calls the internal risk engine, persists the risk
  evaluation, and creates a trade proposal.
- Risk `PASS` transitions the proposal to `PENDING_APPROVAL` and updates the
  signal to `RISK_PASS`.
- Risk `REJECT` records a `RISK_REJECTED` proposal and updates the signal to
  `RISK_FAIL`.
- This endpoint does not execute trades and does not approve proposals.

### GET /signals

Query params: `status`, `strategyId`, `symbol`, `limit`, `offset`

Response 200:
```json
{
  "signals": [
    {
      "id": "...",
      "strategyId": "...",
      "symbol": "AAPL",
      "side": "BUY",
      "referencePrice": "150.25",
      "reason": "MA(10) crossed above MA(50)",
      "status": "RISK_PASS",
      "createdAt": "..."
    }
  ],
  "total": 42,
  "limit": 20,
  "offset": 0
}
```

---

## Risk

```
GET /risk/settings         — current risk rule parameters
PUT /risk/settings/:key    — update a risk parameter (owner only)
GET /risk/kill-switch      — current kill switch state
PUT /risk/kill-switch      — enable or disable paper trading approvals (owner only)
GET /risk/checks           — list risk evaluations (paginated)
GET /risk/checks/:id       — specific risk check detail
```

### PUT /risk/settings/:key

Only risk threshold/session keys are writable here. `trading_mode` is read-only
and must remain `PAPER`.

Request:
```json
{ "value": "10000.00" }
```

Integer settings use JSON numbers. Decimal settings use strings to preserve
precision. Session settings use `"HH:MM"` UTC or `null`.

### PUT /risk/kill-switch

Request:
```json
{ "enabled": false }
```

Response 200:
```json
{
  "enabled": false,
  "updatedAt": "2024-01-15T10:30:00.000Z"
}
```

Kill switch changes are owner-only and audit logged.

### GET /risk/checks/:id

Response 200:
```json
{
  "id": "...",
  "stage": "PRE_PROPOSAL",
  "result": "REJECT",
  "rulesChecked": ["KILL_SWITCH", "TRADING_MODE", "MAX_ORDER_NOTIONAL", "MAX_DAILY_LOSS"],
  "failedRules": ["MAX_DAILY_LOSS"],
  "reason": "Daily loss limit exceeded",
  "marketSnapshot": { ... },
  "portfolioSnapshot": { ... },
  "createdAt": "..."
}
```

---

## Trade Proposals

```
GET  /trade-proposals              — list proposals (paginated, filterable)
GET  /trade-proposals/:id          — proposal detail
PATCH /trade-proposals/:id/cancel  — cancel a pre-approval proposal (owner only)
POST /trade-proposals/:id/approve  — owner approves and risk-revalidates a proposal
POST /trade-proposals/:id/reject   — owner rejects a proposal
POST /trade-proposals/:id/execute  — submit an approved proposal to the paper broker
```

### GET /trade-proposals/:id

Response 200:
```json
{
  "id": "...",
  "signalId": "...",
  "strategyId": "...",
  "symbol": "AAPL",
  "side": "BUY",
  "quantity": "100",
  "orderType": "MARKET",
  "referencePrice": "150.25",
  "limitPrice": null,
  "estimatedNotional": "15025.00",
  "riskResult": "PASS",
  "riskSnapshot": { ... },
  "portfolioSnapshot": { ... },
  "status": "PENDING_APPROVAL",
  "createdAt": "...",
  "expiresAt": "...",
  "approvedAt": null,
  "rejectedAt": null,
  "filledAt": null,
  "currentPrice": "150.40",
  "priceDriftPct": "0.001",
  "isExpired": false,
  "timeToExpirySeconds": 243
}
```

Note: `currentPrice` and `priceDriftPct` are fetched fresh on each GET for display.

### PATCH /trade-proposals/:id/cancel

Response 200:
```json
{
  "id": "...",
  "status": "CANCELLED"
}
```

Response 409:
```json
{ "error": "INVALID_STATE", "currentStatus": "RISK_REJECTED" }
```

Response 410:
```json
{ "error": "PROPOSAL_EXPIRED", "expiredAt": "..." }
```

### POST /trade-proposals/:id/approve

Request:
```json
{
  "requestId": "client-generated-uuid"
}
```

Response 200:
```json
{
  "proposal": { "id": "...", "status": "APPROVED" },
  "approval": { "action": "APPROVE", "requestId": "client-generated-uuid" },
  "riskCheck": { "stage": "PRE_EXECUTION", "result": "PASS" },
  "riskResult": { "result": "PASS", "failed_rules": [] },
  "idempotent": false
}
```

Response 422:
```json
{
  "error": "RISK_REVALIDATION_FAILED",
  "proposal": { "id": "...", "status": "RISK_REJECTED_AFTER_APPROVAL" },
  "failedRules": ["PRICE_DRIFT"],
  "reason": "Price drifted beyond threshold"
}
```

Notes:
- The request accepts only `requestId`; trading parameters are loaded from the
  immutable proposal row.
- Approval locks the proposal row, records the owner action, and performs
  `PRE_EXECUTION` risk revalidation with current market and portfolio data.
- A successful Phase 9 approval stops at `APPROVED`. Paper execution is Phase 10.

### POST /trade-proposals/:id/reject

Request:
```json
{
  "requestId": "client-generated-uuid",
  "reason": "Market conditions changed"
}
```

Response 200:
```json
{
  "proposal": { "id": "...", "status": "OWNER_REJECTED" },
  "approval": { "action": "REJECT", "requestId": "client-generated-uuid" },
  "idempotent": false
}
```

### POST /trade-proposals/:id/execute

Request:
```json
{
  "requestId": "client-generated-uuid"
}
```

Response 200:
```json
{
  "proposal": { "id": "...", "status": "FILLED" },
  "execution": {
    "status": "FILLED",
    "idempotencyKey": "proposal:{proposalId}:attempt:1",
    "brokerOrderId": "paper-..."
  },
  "order": { "status": "FILLED", "filledQuantity": "10.00000000" },
  "fills": [{ "quantity": "10.00000000", "price": "150.25" }],
  "position": { "symbol": "AAPL", "quantity": "10.00000000" },
  "idempotent": false
}
```

Response 422:
```json
{
  "error": "EXECUTION_REJECTED",
  "proposal": { "id": "...", "status": "EXECUTION_REJECTED" },
  "execution": { "status": "REJECTED", "errorMessage": "Insufficient paper funds" }
}
```

Response 503:
```json
{
  "error": "EXECUTION_ERROR",
  "proposal": { "id": "...", "status": "EXECUTION_ERROR" },
  "execution": { "status": "ERROR", "errorMessage": "Paper broker unavailable" }
}
```

Notes:
- The endpoint accepts no trading parameters. It loads the immutable proposal,
  derives the execution idempotency key, and submits only to the paper broker.
- Retrying the same proposal reuses the same execution key and cannot create a
  duplicate broker order or duplicate fill records.
- Filled orders update positions and create a portfolio snapshot for
  reconciliation.

---

## Executions

```
GET /executions         — list executions (paginated)
GET /executions/:id     — execution detail
```

---

## Orders

```
GET /orders                     — list orders (paginated)
GET /orders/:id                 — order detail
POST /orders/:id/cancel         — request order cancellation (owner only)
```

---

## Positions

```
GET /positions          — current open positions
GET /positions/:symbol  — position for a specific symbol
```

---

## Portfolio

```
GET /portfolio                  — current portfolio summary
GET /portfolio/snapshots        — historical portfolio snapshots (paginated)
GET /portfolio/pnl              — P&L summary (daily, total)
```

### GET /portfolio

Response 200:
```json
{
  "cashBalance": "50000.00",
  "portfolioEquity": "65000.00",
  "realizedPnl": "500.00",
  "unrealizedPnl": "1500.00",
  "dailyPnl": "-200.00",
  "openPositions": [
    {
      "symbol": "AAPL",
      "quantity": "100",
      "averageEntryPrice": "148.00",
      "currentPrice": "150.25",
      "marketValue": "15025.00",
      "unrealizedPnl": "225.00"
    }
  ],
  "pendingOrders": 1,
  "lastUpdatedAt": "..."
}
```

---

## Audit Log

```
GET /audit-logs         — list audit events (paginated, filterable)
GET /audit-logs/:id     — specific audit event
```

Query params: `eventType`, `entityId`, `actorId`, `from`, `to`, `limit`, `offset`

---

## Error Response Format

All errors use a consistent format:

```json
{
  "error": "ERROR_CODE",
  "message": "Human-readable description",
  "requestId": "...",
  "timestamp": "..."
}
```

Common error codes:
| Code | HTTP Status | Description |
|---|---|---|
| `UNAUTHENTICATED` | 401 | No valid session |
| `FORBIDDEN` | 403 | Authenticated but not authorized |
| `NOT_FOUND` | 404 | Resource does not exist |
| `INVALID_STATE` | 409 | State machine transition rejected |
| `PROPOSAL_EXPIRED` | 410 | Proposal TTL elapsed |
| `RISK_REVALIDATION_FAILED` | 422 | Second risk check failed |
| `VALIDATION_ERROR` | 422 | Request body failed validation |
| `RATE_LIMITED` | 429 | Too many requests |
| `INTERNAL_ERROR` | 500 | Unexpected server error |

---

## Internal API: trading-engine

These endpoints are called by `apps/api` only.

```
POST /signals/generate              — run a strategy and return a signal
POST /risk/evaluate                 — evaluate risk for a signal/proposal
POST /broker/orders                 — submit paper order
GET  /broker/orders/:id             — get paper order status
POST /broker/orders/:id/cancel      — cancel paper order
GET  /broker/paper-portfolio        — current simulated cash/positions
GET  /market-data/snapshot/:symbol  — current market snapshot
GET  /health                        — trading engine health
```

All internal API calls include:
- `X-Request-ID: {requestId}` header for distributed tracing
- `X-Internal-Token: {secret}` header for service-to-service auth

The internal token is set via environment variable, not hardcoded.
