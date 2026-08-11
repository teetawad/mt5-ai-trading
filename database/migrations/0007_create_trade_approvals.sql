CREATE TABLE IF NOT EXISTS trade_approvals (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    proposal_id     UUID NOT NULL REFERENCES trade_proposals(id),
    approved_by     UUID NOT NULL REFERENCES users(id),
    action          TEXT NOT NULL CHECK (action IN ('APPROVE', 'REJECT')),
    reason          TEXT,
    request_id      TEXT NOT NULL,
    ip_address      INET,
    user_agent      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (proposal_id, request_id)
);

CREATE INDEX IF NOT EXISTS trade_approvals_proposal_id_idx ON trade_approvals(proposal_id);
CREATE INDEX IF NOT EXISTS trade_approvals_approved_by_idx ON trade_approvals(approved_by);
