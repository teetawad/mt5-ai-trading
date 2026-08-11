ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS bracket_order_ids JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS exit_reason TEXT CHECK (
        exit_reason IS NULL OR exit_reason IN ('TAKE_PROFIT', 'STOP_LOSS', 'MANUAL', 'OTHER')
    );

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
        IF OLD.symbol              IS DISTINCT FROM NEW.symbol              OR
           OLD.side                IS DISTINCT FROM NEW.side                OR
           OLD.quantity            IS DISTINCT FROM NEW.quantity            OR
           OLD.order_type          IS DISTINCT FROM NEW.order_type          OR
           OLD.reference_price     IS DISTINCT FROM NEW.reference_price     OR
           OLD.limit_price         IS DISTINCT FROM NEW.limit_price         OR
           OLD.estimated_notional  IS DISTINCT FROM NEW.estimated_notional  OR
           OLD.risk_snapshot       IS DISTINCT FROM NEW.risk_snapshot
        THEN
            RAISE EXCEPTION
                'Cannot modify approved trading plan of proposal % after it reached status %',
                OLD.id, OLD.status;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
