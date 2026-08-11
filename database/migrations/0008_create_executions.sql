DO $$ BEGIN
    CREATE TYPE execution_status AS ENUM (
        'CREATED', 'SUBMITTED', 'PARTIALLY_FILLED', 'FILLED',
        'CANCELLED', 'REJECTED', 'ERROR'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS executions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    proposal_id         UUID NOT NULL REFERENCES trade_proposals(id),
    idempotency_key     TEXT NOT NULL UNIQUE,
    broker_order_id     TEXT,
    status              execution_status NOT NULL DEFAULT 'CREATED',
    attempt_number      INTEGER NOT NULL DEFAULT 1,
    error_message       TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    submitted_at        TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS executions_proposal_id_idx ON executions(proposal_id);
CREATE INDEX IF NOT EXISTS executions_status_idx ON executions(status);
