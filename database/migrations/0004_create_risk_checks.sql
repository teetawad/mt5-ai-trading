-- risk_checks.proposal_id FK is deferred to 0006 to break the circular dependency
-- with trade_proposals (trade_proposals.risk_check_id → risk_checks).

DO $$ BEGIN
    CREATE TYPE risk_result AS ENUM ('PASS', 'REJECT');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE risk_check_stage AS ENUM ('PRE_PROPOSAL', 'PRE_EXECUTION');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS risk_checks (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    signal_id           UUID REFERENCES signals(id),
    proposal_id         UUID,           -- FK added in 0006 after trade_proposals exists
    stage               risk_check_stage NOT NULL,
    result              risk_result NOT NULL,
    rules_checked       JSONB NOT NULL,
    failed_rules        JSONB NOT NULL DEFAULT '[]',
    reason              TEXT,
    market_snapshot     JSONB NOT NULL,
    portfolio_snapshot  JSONB NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS risk_checks_signal_id_idx ON risk_checks(signal_id);
CREATE INDEX IF NOT EXISTS risk_checks_proposal_id_idx ON risk_checks(proposal_id);
CREATE INDEX IF NOT EXISTS risk_checks_result_idx ON risk_checks(result);
