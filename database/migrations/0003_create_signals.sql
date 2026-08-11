DO $$ BEGIN
    CREATE TYPE signal_status AS ENUM ('CREATED', 'RISK_PASS', 'RISK_FAIL', 'EXPIRED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS signals (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    strategy_id         UUID NOT NULL REFERENCES strategies(id),
    symbol              TEXT NOT NULL,
    side                TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
    reference_price     NUMERIC(18,8) NOT NULL,
    reason              TEXT NOT NULL,
    strategy_version    TEXT NOT NULL,
    confidence          NUMERIC(5,4) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    market_snapshot     JSONB NOT NULL,
    status              signal_status NOT NULL DEFAULT 'CREATED',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at          TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS signals_strategy_id_idx ON signals(strategy_id);
CREATE INDEX IF NOT EXISTS signals_created_at_idx ON signals(created_at DESC);
CREATE INDEX IF NOT EXISTS signals_status_idx ON signals(status);
