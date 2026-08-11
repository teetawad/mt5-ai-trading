DO $$ BEGIN
    CREATE TYPE order_status AS ENUM (
        'PENDING', 'SUBMITTED', 'PARTIALLY_FILLED', 'FILLED',
        'CANCELLED', 'REJECTED', 'ERROR'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS orders (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    execution_id        UUID NOT NULL REFERENCES executions(id),
    broker_order_id     TEXT UNIQUE,
    symbol              TEXT NOT NULL,
    side                TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
    quantity            NUMERIC(18,8) NOT NULL CHECK (quantity > 0),
    order_type          TEXT NOT NULL CHECK (order_type IN ('MARKET', 'LIMIT')),
    limit_price         NUMERIC(18,8),
    status              order_status NOT NULL DEFAULT 'PENDING',
    filled_quantity     NUMERIC(18,8) NOT NULL DEFAULT 0 CHECK (filled_quantity >= 0),
    average_fill_price  NUMERIC(18,8),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS orders_execution_id_idx ON orders(execution_id);
CREATE INDEX IF NOT EXISTS orders_symbol_idx ON orders(symbol);
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status);
