-- Phase 27: per-symbol, per-candle claim table. The hourly scheduler
-- INSERTs a row here before analyzing a newly closed 1H candle; the
-- UNIQUE(symbol, candle_timestamp) constraint is the actual dedup
-- mechanism — only the caller whose INSERT succeeds may proceed, and a
-- process restart is safe by construction because the claim lives in the
-- database, not in scheduler memory. A row stuck in CLAIMED past its
-- candle (crash mid-analysis) is intentionally never retried automatically
-- — one forfeited candle is preferred over any risk of double-processing.

CREATE TABLE IF NOT EXISTS hourly_candle_processing (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    symbol            TEXT NOT NULL,
    candle_timestamp  TIMESTAMPTZ NOT NULL,
    status            TEXT NOT NULL DEFAULT 'CLAIMED' CHECK (status IN ('CLAIMED', 'ANALYZED', 'ERROR')),
    signal_id         UUID REFERENCES signals(id),
    error_message     TEXT,
    claimed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at      TIMESTAMPTZ,
    UNIQUE (symbol, candle_timestamp)
);

CREATE INDEX IF NOT EXISTS hourly_candle_processing_symbol_idx
    ON hourly_candle_processing(symbol, candle_timestamp DESC);
