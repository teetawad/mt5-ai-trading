DO $$ BEGIN
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
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS trade_proposals (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    signal_id               UUID NOT NULL REFERENCES signals(id),
    strategy_id             UUID NOT NULL REFERENCES strategies(id),

    -- Trading parameters: IMMUTABLE after status reaches PENDING_APPROVAL (enforced by trigger in 0015)
    symbol                  TEXT NOT NULL,
    side                    TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
    quantity                NUMERIC(18,8) NOT NULL CHECK (quantity > 0),
    order_type              TEXT NOT NULL CHECK (order_type IN ('MARKET', 'LIMIT')),
    reference_price         NUMERIC(18,8) NOT NULL,
    limit_price             NUMERIC(18,8),
    estimated_notional      NUMERIC(18,8) NOT NULL,

    -- Risk snapshot at proposal creation time
    risk_check_id           UUID REFERENCES risk_checks(id),
    risk_snapshot           JSONB NOT NULL,
    portfolio_snapshot      JSONB NOT NULL,

    status                  proposal_status NOT NULL DEFAULT 'RISK_CHECKING',

    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    pending_approval_at     TIMESTAMPTZ,
    expires_at              TIMESTAMPTZ NOT NULL,
    approved_at             TIMESTAMPTZ,
    rejected_at             TIMESTAMPTZ,
    filled_at               TIMESTAMPTZ,
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    notes                   TEXT
);

CREATE INDEX IF NOT EXISTS trade_proposals_signal_id_idx ON trade_proposals(signal_id);
CREATE INDEX IF NOT EXISTS trade_proposals_status_idx ON trade_proposals(status);
CREATE INDEX IF NOT EXISTS trade_proposals_expires_at_idx ON trade_proposals(expires_at);
CREATE INDEX IF NOT EXISTS trade_proposals_symbol_idx ON trade_proposals(symbol);
