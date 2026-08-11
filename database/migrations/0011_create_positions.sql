CREATE TABLE IF NOT EXISTS positions (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    symbol                  TEXT NOT NULL UNIQUE,
    quantity                NUMERIC(18,8) NOT NULL DEFAULT 0,
    average_entry_price     NUMERIC(18,8),
    realized_pnl            NUMERIC(18,8) NOT NULL DEFAULT 0,
    unrealized_pnl          NUMERIC(18,8) NOT NULL DEFAULT 0,
    last_price              NUMERIC(18,8),
    last_price_at           TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
