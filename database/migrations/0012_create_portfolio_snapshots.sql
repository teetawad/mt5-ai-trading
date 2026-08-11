CREATE TABLE IF NOT EXISTS portfolio_snapshots (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cash_balance        NUMERIC(18,8) NOT NULL,
    portfolio_equity    NUMERIC(18,8) NOT NULL,
    open_positions      JSONB NOT NULL DEFAULT '[]',
    pending_orders      JSONB NOT NULL DEFAULT '[]',
    realized_pnl        NUMERIC(18,8) NOT NULL DEFAULT 0,
    unrealized_pnl      NUMERIC(18,8) NOT NULL DEFAULT 0,
    daily_pnl           NUMERIC(18,8) NOT NULL DEFAULT 0,
    snapshot_reason     TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS portfolio_snapshots_created_at_idx ON portfolio_snapshots(created_at DESC);
