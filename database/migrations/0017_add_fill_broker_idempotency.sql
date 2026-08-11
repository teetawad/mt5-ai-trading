CREATE UNIQUE INDEX IF NOT EXISTS fills_broker_fill_id_unique_idx
    ON fills(broker_fill_id)
    WHERE broker_fill_id IS NOT NULL;
