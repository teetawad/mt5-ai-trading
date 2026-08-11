-- Resolves the circular FK between risk_checks and trade_proposals.
-- trade_proposals was created in 0005; now we can add the FK from risk_checks.proposal_id.

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'risk_checks_proposal_id_fkey'
    ) THEN
        ALTER TABLE risk_checks
            ADD CONSTRAINT risk_checks_proposal_id_fkey
            FOREIGN KEY (proposal_id) REFERENCES trade_proposals(id);
    END IF;
END $$;
