CREATE TABLE IF NOT EXISTS fills (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id        UUID NOT NULL REFERENCES orders(id),
    quantity        NUMERIC(18,8) NOT NULL CHECK (quantity > 0),
    price           NUMERIC(18,8) NOT NULL CHECK (price > 0),
    fee             NUMERIC(18,8) NOT NULL DEFAULT 0 CHECK (fee >= 0),
    fill_type       TEXT NOT NULL CHECK (fill_type IN ('FULL', 'PARTIAL')),
    broker_fill_id  TEXT,
    filled_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS fills_order_id_idx ON fills(order_id);
CREATE INDEX IF NOT EXISTS fills_filled_at_idx ON fills(filled_at DESC);
