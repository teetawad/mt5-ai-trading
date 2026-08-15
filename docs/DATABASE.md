# DATABASE.md

## Overview

PostgreSQL 16 is the single authoritative data store.
All financial values use `NUMERIC(18,8)` — never `FLOAT` or `DOUBLE PRECISION`.
All timestamps are `TIMESTAMPTZ` (UTC).
UUIDs are used for primary keys to prevent enumeration attacks.

---

## Entity Relationship Summary

```
users
  └─ trade_approvals (approved_by → users.id)

strategies
  └─ signals (strategy_id → strategies.id)
       └─ trade_proposals (signal_id → signals.id)
            ├─ risk_checks (proposal_id → trade_proposals.id)
            ├─ trade_approvals (proposal_id → trade_proposals.id)
            └─ executions (proposal_id → trade_proposals.id)
                 └─ orders (execution_id → executions.id)
                      └─ fills (order_id → orders.id)

positions (current state — updated on fill)
portfolio_snapshots (point-in-time snapshots)
audit_logs (append-only)
system_settings (key-value)

hourly_watchlist (Phase 27 — symbols the hourly scheduler evaluates)
hourly_candle_processing (Phase 27 — per-candle claim, signal_id → signals.id)
```

---

## Table Definitions

### users

```sql
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           TEXT NOT NULL UNIQUE,
    display_name    TEXT NOT NULL,
    password_hash   TEXT NOT NULL,         -- argon2id hash
    role            TEXT NOT NULL DEFAULT 'owner',
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_login_at   TIMESTAMPTZ
);
```

Notes:
- `password_hash` stores argon2id output only. Never plaintext.
- Only one `role='owner'` user exists in paper trading phase.

---

### strategies

```sql
CREATE TABLE strategies (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL UNIQUE,
    description     TEXT,
    version         TEXT NOT NULL,
    parameters      JSONB NOT NULL DEFAULT '{}',
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

---

### signals

```sql
CREATE TYPE signal_status AS ENUM (
    'CREATED', 'RISK_PASS', 'RISK_FAIL', 'EXPIRED'
);

CREATE TABLE signals (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    strategy_id         UUID NOT NULL REFERENCES strategies(id),
    symbol              TEXT NOT NULL,
    asset_class         TEXT NOT NULL DEFAULT 'STOCK' CHECK (asset_class IN ('STOCK', 'CRYPTO')), -- Phase 26
    side                TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
    reference_price     NUMERIC(18,8) NOT NULL,
    reason              TEXT NOT NULL,
    strategy_version    TEXT NOT NULL,
    confidence          NUMERIC(5,4),              -- optional, 0.0000 to 1.0000
    market_snapshot     JSONB NOT NULL,
    status              signal_status NOT NULL DEFAULT 'CREATED',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at          TIMESTAMPTZ NOT NULL
);

CREATE INDEX signals_strategy_id_idx ON signals(strategy_id);
CREATE INDEX signals_created_at_idx ON signals(created_at DESC);
```

---

### risk_checks

```sql
CREATE TYPE risk_result AS ENUM ('PASS', 'REJECT');
CREATE TYPE risk_check_stage AS ENUM ('PRE_PROPOSAL', 'PRE_EXECUTION');

CREATE TABLE risk_checks (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    signal_id           UUID REFERENCES signals(id),
    proposal_id         UUID REFERENCES trade_proposals(id),
    stage               risk_check_stage NOT NULL,
    result              risk_result NOT NULL,
    rules_checked       JSONB NOT NULL,             -- array of rule names
    failed_rules        JSONB NOT NULL DEFAULT '[]',
    reason              TEXT,
    market_snapshot     JSONB NOT NULL,
    portfolio_snapshot  JSONB NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX risk_checks_proposal_id_idx ON risk_checks(proposal_id);
```

Notes:
- Every risk evaluation is recorded, both passes and failures.
- `market_snapshot` and `portfolio_snapshot` are point-in-time copies for audit.

---

### trade_proposals

```sql
CREATE TYPE proposal_status AS ENUM (
    'RISK_CHECKING',
    'RISK_REJECTED',
    'PENDING_APPROVAL',
    'OWNER_REJECTED',
    'EXPIRED',
    'APPROVED',
    'REVALIDATING',
    'RISK_REJECTED_AFTER_APPROVAL',
    'SUBMITTING',
    'SUBMITTED',
    'PARTIALLY_FILLED',
    'FILLED',
    'CANCEL_PENDING',
    'CANCELLED',
    'EXECUTION_REJECTED',
    'EXECUTION_ERROR'
);

CREATE TABLE trade_proposals (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    signal_id               UUID NOT NULL REFERENCES signals(id),
    strategy_id             UUID NOT NULL REFERENCES strategies(id),

    -- Trading parameters: IMMUTABLE after status reaches PENDING_APPROVAL
    symbol                  TEXT NOT NULL,
    asset_class             TEXT NOT NULL DEFAULT 'STOCK' CHECK (asset_class IN ('STOCK', 'CRYPTO')), -- Phase 26
    side                    TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
    quantity                NUMERIC(18,8) NOT NULL CHECK (quantity > 0),
    order_type              TEXT NOT NULL CHECK (order_type IN ('MARKET', 'LIMIT')),
    reference_price         NUMERIC(18,8) NOT NULL,
    limit_price             NUMERIC(18,8),           -- required if order_type='LIMIT'
    estimated_notional      NUMERIC(18,8) NOT NULL,

    -- Risk snapshot at proposal creation time
    risk_check_id           UUID REFERENCES risk_checks(id),
    risk_snapshot           JSONB NOT NULL,
    portfolio_snapshot      JSONB NOT NULL,

    -- Status
    status                  proposal_status NOT NULL DEFAULT 'RISK_CHECKING',

    -- Timestamps
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    pending_approval_at     TIMESTAMPTZ,
    expires_at              TIMESTAMPTZ NOT NULL,
    approved_at             TIMESTAMPTZ,
    rejected_at             TIMESTAMPTZ,
    filled_at               TIMESTAMPTZ,
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Metadata
    notes                   TEXT
);

CREATE INDEX trade_proposals_signal_id_idx ON trade_proposals(signal_id);
CREATE INDEX trade_proposals_status_idx ON trade_proposals(status);
CREATE INDEX trade_proposals_expires_at_idx ON trade_proposals(expires_at);
```

Notes:
- A trigger prevents updates to `symbol`, `side`, `quantity`, `order_type`,
  `reference_price`, `limit_price`, `estimated_notional` when status is
  `PENDING_APPROVAL` or any later state.

---

### trade_approvals

```sql
CREATE TABLE trade_approvals (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    proposal_id     UUID NOT NULL REFERENCES trade_proposals(id),
    approved_by     UUID NOT NULL REFERENCES users(id),
    action          TEXT NOT NULL CHECK (action IN ('APPROVE', 'REJECT')),
    reason          TEXT,
    request_id      TEXT NOT NULL,                  -- idempotency / correlation
    ip_address      INET,
    user_agent      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (proposal_id, request_id)               -- prevent duplicate approval submissions
);

CREATE INDEX trade_approvals_proposal_id_idx ON trade_approvals(proposal_id);
```

---

### executions

```sql
CREATE TYPE execution_status AS ENUM (
    'CREATED', 'SUBMITTED', 'PARTIALLY_FILLED', 'FILLED',
    'CANCELLED', 'REJECTED', 'ERROR'
);

CREATE TABLE executions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    proposal_id         UUID NOT NULL REFERENCES trade_proposals(id),
    idempotency_key     TEXT NOT NULL UNIQUE,       -- prevents duplicate execution
    broker_order_id     TEXT,                       -- PaperBroker assigned ID
    status              execution_status NOT NULL DEFAULT 'CREATED',
    attempt_number      INTEGER NOT NULL DEFAULT 1,
    error_message       TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    submitted_at        TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX executions_proposal_id_idx ON executions(proposal_id);
```

Notes:
- `idempotency_key` = `proposal_id || ':' || attempt_number`.
- On retry, the same key is reused; `INSERT ... ON CONFLICT DO NOTHING` returns existing row.

---

### orders

```sql
CREATE TYPE order_status AS ENUM (
    'PENDING', 'SUBMITTED', 'PARTIALLY_FILLED', 'FILLED',
    'CANCELLED', 'REJECTED', 'ERROR'
);

CREATE TABLE orders (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    execution_id        UUID NOT NULL REFERENCES executions(id),
    broker_order_id     TEXT UNIQUE,
    symbol              TEXT NOT NULL,
    asset_class         TEXT NOT NULL DEFAULT 'STOCK' CHECK (asset_class IN ('STOCK', 'CRYPTO')), -- Phase 26
    side                TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
    quantity            NUMERIC(18,8) NOT NULL,
    order_type          TEXT NOT NULL,
    limit_price         NUMERIC(18,8),
    status              order_status NOT NULL DEFAULT 'PENDING',
    filled_quantity     NUMERIC(18,8) NOT NULL DEFAULT 0,
    average_fill_price  NUMERIC(18,8),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX orders_execution_id_idx ON orders(execution_id);
```

---

### fills

```sql
CREATE TABLE fills (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id        UUID NOT NULL REFERENCES orders(id),
    quantity        NUMERIC(18,8) NOT NULL CHECK (quantity > 0),
    price           NUMERIC(18,8) NOT NULL CHECK (price > 0),
    fee             NUMERIC(18,8) NOT NULL DEFAULT 0,
    fill_type       TEXT NOT NULL CHECK (fill_type IN ('FULL', 'PARTIAL')),
    broker_fill_id  TEXT,
    filled_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX fills_order_id_idx ON fills(order_id);
```

---

### positions

```sql
CREATE TABLE positions (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    symbol                  TEXT NOT NULL UNIQUE,   -- one row per symbol
    asset_class             TEXT NOT NULL DEFAULT 'STOCK' CHECK (asset_class IN ('STOCK', 'CRYPTO')), -- Phase 26
    quantity                NUMERIC(18,8) NOT NULL DEFAULT 0,
    average_entry_price     NUMERIC(18,8),
    realized_pnl            NUMERIC(18,8) NOT NULL DEFAULT 0,
    unrealized_pnl          NUMERIC(18,8) NOT NULL DEFAULT 0,
    last_price              NUMERIC(18,8),
    last_price_at           TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Notes:
- `quantity = 0` means the position is closed (row kept for history).
- Unrealized P&L is recalculated on every market data update.

---

### portfolio_snapshots

```sql
CREATE TABLE portfolio_snapshots (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cash_balance        NUMERIC(18,8) NOT NULL,
    portfolio_equity    NUMERIC(18,8) NOT NULL,
    open_positions      JSONB NOT NULL DEFAULT '[]',
    pending_orders      JSONB NOT NULL DEFAULT '[]',
    realized_pnl        NUMERIC(18,8) NOT NULL DEFAULT 0,
    unrealized_pnl      NUMERIC(18,8) NOT NULL DEFAULT 0,
    daily_pnl           NUMERIC(18,8) NOT NULL DEFAULT 0,
    snapshot_reason     TEXT NOT NULL,              -- e.g. 'PRE_RISK_CHECK', 'POST_FILL'
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX portfolio_snapshots_created_at_idx ON portfolio_snapshots(created_at DESC);
```

---

### audit_logs

```sql
CREATE TABLE audit_logs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type      TEXT NOT NULL,
    actor_id        UUID REFERENCES users(id),
    actor_email     TEXT,
    entity_type     TEXT,
    entity_id       UUID,
    action          TEXT NOT NULL,
    before_data     JSONB,
    after_data      JSONB,
    request_id      TEXT,
    ip_address      INET,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Append-only: no UPDATE or DELETE permitted on this table (enforced by trigger)
CREATE INDEX audit_logs_entity_id_idx ON audit_logs(entity_id);
CREATE INDEX audit_logs_event_type_idx ON audit_logs(event_type);
CREATE INDEX audit_logs_created_at_idx ON audit_logs(created_at DESC);
```

Notes:
- A trigger `BEFORE UPDATE OR DELETE` on `audit_logs` raises an exception to
  prevent any modification to audit records.

---

### system_settings

```sql
CREATE TABLE system_settings (
    key         TEXT PRIMARY KEY,
    value       JSONB NOT NULL,
    description TEXT,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by  UUID REFERENCES users(id)
);

-- Seed required settings
INSERT INTO system_settings (key, value, description) VALUES
    ('trading_kill_switch_enabled', 'true', 'When false, no proposals can proceed to execution'),
    ('trading_mode', '"PAPER"', 'Must always be PAPER in this codebase'),
    ('max_order_notional_usd', '10000', 'Maximum USD notional per order — CONFIGURE BEFORE USE'),
    ('max_position_size_usd', '50000', 'Maximum USD position size per symbol — CONFIGURE BEFORE USE'),
    ('max_portfolio_concentration_pct', '0.20', 'Max % of portfolio in one symbol — CONFIGURE BEFORE USE'),
    ('max_open_positions', '10', 'Maximum number of concurrent open positions — CONFIGURE BEFORE USE'),
    ('max_daily_loss_usd', '1000', 'Maximum daily loss before kill switch triggers — CONFIGURE BEFORE USE'),
    ('proposal_ttl_seconds', '300', 'Seconds before a proposal expires — CONFIGURE BEFORE USE'),
    ('price_drift_threshold_pct', '0.02', 'Max allowed price drift from reference (2%) — CONFIGURE BEFORE USE'),
    ('market_data_staleness_seconds', '60', 'Seconds before market data is considered stale — CONFIGURE BEFORE USE');
```

---

### hourly_watchlist (Phase 27)

```sql
CREATE TABLE hourly_watchlist (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    symbol        TEXT NOT NULL UNIQUE,
    enabled       BOOLEAN NOT NULL DEFAULT true,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by    UUID REFERENCES users(id)
);

CREATE INDEX hourly_watchlist_enabled_idx ON hourly_watchlist(enabled);
```

Notes:
- The set of US stock symbols the Phase 27 hourly scheduler evaluates —
  intentionally not the entire market. Seeded with `AAPL` only.
- A `enabled = false` row is skipped by the scheduler entirely; no analysis
  call is made for it on any tick.

---

### hourly_candle_processing (Phase 27)

```sql
CREATE TABLE hourly_candle_processing (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    symbol            TEXT NOT NULL,
    candle_timestamp  TIMESTAMPTZ NOT NULL, -- open-time of the closed 1H bar (UTC)
    status            TEXT NOT NULL DEFAULT 'CLAIMED' CHECK (status IN ('CLAIMED', 'ANALYZED', 'ERROR')),
    signal_id         UUID REFERENCES signals(id),
    error_message     TEXT,
    claimed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at      TIMESTAMPTZ,
    UNIQUE (symbol, candle_timestamp)
);

CREATE INDEX hourly_candle_processing_symbol_idx
    ON hourly_candle_processing(symbol, candle_timestamp DESC);
```

Notes:
- `UNIQUE (symbol, candle_timestamp)` is the entire "one signal max per
  symbol per completed 1H candle, restart-safe" guarantee. The scheduler
  does `INSERT ... ON CONFLICT (symbol, candle_timestamp) DO NOTHING
  RETURNING id`; only the caller whose `INSERT` succeeds may analyze that
  candle. State lives here, not in any scheduler process's memory, so a
  restart is safe by construction.
- A row stuck in `CLAIMED` (process died mid-analysis) is never retried
  automatically — one forfeited candle is accepted in exchange for never
  risking a duplicate signal.
- `phase27_*` system settings (EMA windows, ATR multiples, session bounds,
  risk thresholds — ~27 keys) are listed in full in
  `database/migrations/0025_phase27_hourly_settings.sql`, following the same
  key/value `system_settings` pattern as every other phase.

---

## Migration Strategy

- Migrations are numbered sequentially: `0001_create_users.sql`, `0002_create_strategies.sql`, etc.
- Run using a migration tool (e.g. `node-pg-migrate` or `flyway`).
- Migrations are one-way (no automatic rollback in production).
- Each migration file is idempotent where possible (`CREATE TABLE IF NOT EXISTS`, `IF NOT EXISTS` for indexes).
- All migrations run inside a transaction.

---

## Decimal Precision Rules

| Value type | PostgreSQL type | Application type |
|---|---|---|
| Price | `NUMERIC(18,8)` | Python `Decimal`, Node `string` → `Decimal.js` |
| Quantity | `NUMERIC(18,8)` | Same |
| P&L | `NUMERIC(18,8)` | Same |
| Percentage | `NUMERIC(5,4)` | Same |
| Fee | `NUMERIC(18,8)` | Same |

**Rule:** Monetary and quantity values are NEVER stored as or computed in `float` or `double`.
All arithmetic uses exact decimal types. Rounding is applied only at display time, using `ROUND_HALF_UP`.
