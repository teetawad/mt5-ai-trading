-- Phase 27: hourly trading watchlist. Configurable set of US stock symbols
-- the hourly scheduler evaluates once per newly closed 1H candle. Starts
-- with AAPL only (the only symbol actually live-registered in the trading
-- engine today) — an owner enables more via the watchlist admin UI.

CREATE TABLE IF NOT EXISTS hourly_watchlist (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    symbol        TEXT NOT NULL UNIQUE,
    enabled       BOOLEAN NOT NULL DEFAULT true,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by    UUID REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS hourly_watchlist_enabled_idx ON hourly_watchlist(enabled);

INSERT INTO hourly_watchlist (symbol, enabled) VALUES ('AAPL', true)
ON CONFLICT (symbol) DO NOTHING;
