-- V3 architecture pivot: a real Trading-Specialist AI becomes the primary
-- brain instead of the deterministic BASELINE_MT5_H1_V1 strategy.
-- Additive only: nothing from the MT5 AI DEMO Lab (instruments, watchlists,
-- ai_decisions, mt5_entry_plans, trade_outcomes, risk_evaluations,
-- ai_models/model_versions) is dropped or altered destructively.
-- BASELINE_MT5_H1_V1 keeps running exactly as-is (mt5-hourly-scheduler.ts +
-- mt5_entry_plans + the existing EntryPlanWatcher) as a benchmark/challenger
-- pipeline; the tables below are a parallel, independent lifecycle for the
-- new AI so neither can destabilize the other.

-- Every AI analysis request/response, even WAIT decisions, is stored for the
-- learning/evaluation dataset (never just the executed ones).
CREATE TABLE IF NOT EXISTS ai_analysis_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol TEXT NOT NULL,
  asset_class TEXT NOT NULL DEFAULT 'OTHER',
  ai_provider TEXT NOT NULL,
  ai_model TEXT NOT NULL,
  ai_prompt_version TEXT NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  latency_ms INTEGER,
  market_analysis_package JSONB NOT NULL DEFAULT '{}'::jsonb,
  chart_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  raw_ai_response JSONB,
  decision TEXT CHECK (decision IN ('BUY','SELL','WAIT')),
  confidence NUMERIC(8,4),
  opportunity_score NUMERIC(10,4),
  validation_error TEXT,
  provider_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_analysis_runs_symbol_idx
  ON ai_analysis_runs(symbol, created_at DESC);

-- The AI's trade plan lifecycle (spec section 13). Deliberately distinct
-- from mt5_entry_plans: an AI trade plan can materialize as a REAL MT5
-- pending order (BUY_LIMIT/SELL_LIMIT/BUY_STOP/SELL_STOP) that the broker
-- itself waits on, not a plan the backend polls price against.
CREATE TABLE IF NOT EXISTS ai_trade_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_run_id UUID REFERENCES ai_analysis_runs(id),
  symbol TEXT NOT NULL,
  asset_class TEXT NOT NULL DEFAULT 'OTHER',
  ai_provider TEXT NOT NULL,
  ai_model TEXT NOT NULL,
  ai_prompt_version TEXT NOT NULL,

  decision TEXT NOT NULL CHECK (decision IN ('BUY','SELL','WAIT')),
  confidence NUMERIC(8,4) NOT NULL DEFAULT 0,
  opportunity_score NUMERIC(10,4) NOT NULL DEFAULT 0,
  trend TEXT CHECK (trend IN ('BULLISH','BEARISH','RANGE','UNCLEAR')),

  entry_type TEXT NOT NULL CHECK (entry_type IN ('MARKET_NOW','PULLBACK','BREAKOUT','NO_ENTRY')),
  entry_price NUMERIC(18,8),
  entry_zone_low NUMERIC(18,8),
  entry_zone_high NUMERIC(18,8),
  trigger_price NUMERIC(18,8),
  pending_order_type TEXT NOT NULL DEFAULT 'NONE'
    CHECK (pending_order_type IN ('NONE','BUY_LIMIT','SELL_LIMIT','BUY_STOP','SELL_STOP')),

  stop_loss NUMERIC(18,8),
  take_profit NUMERIC(18,8),
  risk_reward NUMERIC(18,8),

  recommended_volume NUMERIC(18,8),
  final_volume NUMERIC(18,8),
  max_planned_loss NUMERIC(18,8),
  target_profit NUMERIC(18,8),

  expected_holding_minutes INTEGER,
  plan_expiry TIMESTAMPTZ NOT NULL,
  invalidation_reason TEXT,
  reason_summary TEXT,
  reason_details JSONB NOT NULL DEFAULT '[]'::jsonb,

  risk_result TEXT CHECK (risk_result IN ('PASS','REJECT')),
  risk_failed_rules JSONB NOT NULL DEFAULT '[]'::jsonb,
  risk_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,

  status TEXT NOT NULL DEFAULT 'AI_PLAN_CREATED' CHECK (status IN (
    'AI_PLAN_CREATED',
    'WAITING_FOR_APPROVAL',
    'PENDING_ORDER_SUBMITTING',
    'PENDING_ORDER_PLACED',
    'PENDING_ORDER_TRIGGERED',
    'POSITION_OPEN',
    'POSITION_CLOSED',
    'PLAN_EXPIRED',
    'ORDER_CANCELLED',
    'EXECUTION_FAILED',
    'RISK_BLOCKED'
  )),

  mt5_order_ticket TEXT,
  mt5_deal_ticket TEXT,
  mt5_position_ticket TEXT,
  retcode INTEGER,
  actual_entry NUMERIC(18,8),
  execution_key TEXT,

  approved_at TIMESTAMPTZ,
  submitting_at TIMESTAMPTZ,
  placed_at TIMESTAMPTZ,
  triggered_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  expired_at TIMESTAMPTZ,
  blocked_reason TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_trade_plans_status_idx
  ON ai_trade_plans(status, plan_expiry);

CREATE INDEX IF NOT EXISTS ai_trade_plans_symbol_idx
  ON ai_trade_plans(symbol, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS ai_trade_plans_execution_key_uidx
  ON ai_trade_plans(execution_key) WHERE execution_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS ai_trade_plans_pending_ticket_idx
  ON ai_trade_plans(mt5_order_ticket) WHERE status = 'PENDING_ORDER_PLACED';

-- Links a closed/open trade_outcomes row back to the AI V3 plan that created
-- it, alongside (not replacing) the existing entry_plan_id used by the
-- BASELINE_MT5_H1_V1 pipeline, so History/reconciliation stay unified across
-- both origins without guessing which produced a given row.
ALTER TABLE trade_outcomes ADD COLUMN IF NOT EXISTS ai_trade_plan_id UUID REFERENCES ai_trade_plans(id);

CREATE UNIQUE INDEX IF NOT EXISTS trade_outcomes_ai_trade_plan_uidx
  ON trade_outcomes(ai_trade_plan_id) WHERE ai_trade_plan_id IS NOT NULL;

-- Registers the new AI as its own model/version lineage, independent from
-- MT5_H1_BASELINE (which keeps its own CHAMPION row exactly as-is and is
-- never modified here) so Champion/Challenger comparison in AI Lab has real
-- separate lineages to compare instead of overwriting the baseline's.
INSERT INTO ai_models(name, kind)
VALUES ('TRADING_AI_V3', 'CHAMPION')
ON CONFLICT (name) DO NOTHING;

WITH model AS (
  SELECT id FROM ai_models WHERE name = 'TRADING_AI_V3'
), version AS (
  INSERT INTO model_versions(model_id, version, status, parameters)
  SELECT id, 'TRADING_AI_V3_PROMPT_001', 'CHAMPION',
    '{"type":"trading_specialist_ai","multimodal":true}'::jsonb
  FROM model
  ON CONFLICT (model_id, version) DO UPDATE SET status = EXCLUDED.status
  RETURNING id
)
UPDATE ai_models SET active_version_id = (SELECT id FROM version)
WHERE name = 'TRADING_AI_V3';

UPDATE ai_models SET kind = 'BASELINE' WHERE name = 'MT5_H1_BASELINE';

INSERT INTO system_settings(key, value, description)
VALUES
  ('trading_ai_prompt_version', '"TRADING_AI_V3_PROMPT_001"'::jsonb, 'Active Trading AI prompt/schema version (informational; never overwritten on prompt change).'),
  ('ai_trade_plan_valid_minutes', '120'::jsonb, 'Default minutes before an unapproved/unfilled AI trade plan expires.')
ON CONFLICT (key) DO NOTHING;
