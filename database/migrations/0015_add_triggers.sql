-- ─────────────────────────────────────────────────────────────────────────────
-- Trigger 1: audit_logs is append-only
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION prevent_audit_log_modification()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'audit_logs records are immutable and cannot be modified or deleted';
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS enforce_audit_log_immutability ON audit_logs;
CREATE TRIGGER enforce_audit_log_immutability
    BEFORE UPDATE OR DELETE ON audit_logs
    FOR EACH ROW
    EXECUTE FUNCTION prevent_audit_log_modification();


-- ─────────────────────────────────────────────────────────────────────────────
-- Trigger 2: trade_proposals trading parameters are immutable after
--            the proposal reaches PENDING_APPROVAL or any later status.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION prevent_proposal_field_changes()
RETURNS TRIGGER AS $$
DECLARE
    locked_statuses TEXT[] := ARRAY[
        'PENDING_APPROVAL', 'OWNER_REJECTED', 'EXPIRED', 'APPROVED',
        'REVALIDATING', 'RISK_REJECTED_AFTER_APPROVAL', 'SUBMITTING',
        'SUBMITTED', 'PARTIALLY_FILLED', 'FILLED', 'CANCEL_PENDING',
        'CANCELLED', 'EXECUTION_REJECTED', 'EXECUTION_ERROR'
    ];
BEGIN
    IF OLD.status::TEXT = ANY(locked_statuses) THEN
        IF OLD.symbol            IS DISTINCT FROM NEW.symbol            OR
           OLD.side              IS DISTINCT FROM NEW.side              OR
           OLD.quantity          IS DISTINCT FROM NEW.quantity          OR
           OLD.order_type        IS DISTINCT FROM NEW.order_type        OR
           OLD.reference_price   IS DISTINCT FROM NEW.reference_price   OR
           OLD.limit_price       IS DISTINCT FROM NEW.limit_price       OR
           OLD.estimated_notional IS DISTINCT FROM NEW.estimated_notional
        THEN
            RAISE EXCEPTION
                'Cannot modify trading parameters of proposal % after it reached status %',
                OLD.id, OLD.status;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS enforce_proposal_immutability ON trade_proposals;
CREATE TRIGGER enforce_proposal_immutability
    BEFORE UPDATE ON trade_proposals
    FOR EACH ROW
    EXECUTE FUNCTION prevent_proposal_field_changes();
