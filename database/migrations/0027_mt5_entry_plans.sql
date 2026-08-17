-- MT5 AI entry timing plans.
-- Additive only: preserves existing MT5 decisions/trade history and stores
-- whether the AI wanted immediate entry, a pullback, a breakout, or no entry.

CREATE TABLE IF NOT EXISTS mt5_entry_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ai_decision_id UUID REFERENCES ai_decisions(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY','SELL','NONE')),
  entry_strategy TEXT NOT NULL CHECK (entry_strategy IN ('MARKET_NOW','PULLBACK','BREAKOUT','NO_ENTRY')),
  status TEXT NOT NULL CHECK (status IN ('WAITING','READY','TRIGGERED','EXPIRED','CANCELLED','BLOCKED','EXECUTED')),
  current_bid NUMERIC(18,8),
  current_ask NUMERIC(18,8),
  current_price NUMERIC(18,8),
  entry_zone_low NUMERIC(18,8),
  entry_zone_high NUMERIC(18,8),
  trigger_price NUMERIC(18,8),
  reference_entry NUMERIC(18,8),
  stop_loss NUMERIC(18,8),
  take_profit NUMERIC(18,8),
  risk_reward NUMERIC(18,8),
  recommended_volume NUMERIC(18,8),
  max_planned_loss NUMERIC(18,8),
  confidence NUMERIC(8,4) NOT NULL DEFAULT 0,
  opportunity_score NUMERIC(10,4) NOT NULL DEFAULT 0,
  entry_reason TEXT,
  signal_candle_timestamp TIMESTAMPTZ NOT NULL,
  valid_until TIMESTAMPTZ NOT NULL,
  triggered_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  executed_at TIMESTAMPTZ,
  expired_at TIMESTAMPTZ,
  reached_trigger BOOLEAN,
  time_to_trigger_seconds INTEGER,
  post_trigger_outcome JSONB NOT NULL DEFAULT '{}'::jsonb,
  mfe NUMERIC(18,8),
  mae NUMERIC(18,8),
  sl_tp_outcome TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ai_decision_id)
);

CREATE INDEX IF NOT EXISTS mt5_entry_plans_status_idx
  ON mt5_entry_plans(status, valid_until);

CREATE INDEX IF NOT EXISTS mt5_entry_plans_symbol_idx
  ON mt5_entry_plans(symbol, created_at DESC);

INSERT INTO system_settings(key, value, description)
VALUES
  ('mt5_entry_plan_valid_hours', '2'::jsonb, 'Hours after the H1 signal candle that a pending MT5 entry plan remains valid.')
ON CONFLICT (key) DO UPDATE
SET description = EXCLUDED.description,
    updated_at = now();
