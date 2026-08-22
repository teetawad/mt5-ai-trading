-- M5 Fast Learning Mode (spec sections 1-21): collect trading statistics
-- much faster by triggering the existing V3 Trading AI pipeline once per
-- completed M5 candle instead of only on a manual "FIND BEST TRADES" click,
-- and by automatically simulating every actionable setup as a Shadow Trade
-- (never a real order_send) so outcomes can be tracked to build a future ML
-- Trade Critic dataset. Purely additive: ai_trade_plans/ai_analysis_runs/
-- opportunity_scan_results keep their existing shape and existing callers
-- (analyzeSymbolWithAI, runOpportunityScan, the AI Trade UI) are unaffected.

-- Attributes every AI analysis (even WAIT) to whichever cadence produced it,
-- so the Fast Learning Dashboard can count "M5 decisions today" precisely
-- (spec section 15) instead of guessing from unrelated heuristics.
ALTER TABLE ai_analysis_runs ADD COLUMN IF NOT EXISTS trigger_source TEXT NOT NULL DEFAULT 'MANUAL'
  CHECK (trigger_source IN ('MANUAL','M5_CYCLE'));
ALTER TABLE ai_analysis_runs ADD COLUMN IF NOT EXISTS m5_candle_timestamp TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS ai_analysis_runs_trigger_source_idx
  ON ai_analysis_runs(trigger_source, created_at DESC);

-- Distinguishes an M5-cycle-triggered "FAST FIND BEST TRADES" ranking (spec
-- section 18) from a manual "FIND BEST TRADES" click, while both keep
-- sharing one ranking/dataset table (spec section 20) rather than forking it.
ALTER TABLE opportunity_scan_results ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'MANUAL_SCAN'
  CHECK (source IN ('MANUAL_SCAN','M5_CYCLE'));
ALTER TABLE opportunity_scan_results ADD COLUMN IF NOT EXISTS m5_candle_timestamp TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS opportunity_scan_results_source_idx
  ON opportunity_scan_results(source, created_at DESC);

-- Shadow Trades (spec sections 6-9, 13, 14, 16): an automatic, simulated
-- trade created for every technically-valid actionable AI setup, tracked to
-- a real outcome using subsequent M5 (and, when disambiguating a same-candle
-- TP+SL touch, M1) price data. Deliberately a separate table from
-- ai_trade_plans/trade_outcomes (the REAL DEMO execution lineage) so a
-- shadow trade can structurally never be confused with or mixed into real
-- MT5-confirmed trade history — the shadow lifecycle (this table's own
-- service/watcher) never imports or calls order_send/order_check.
CREATE TABLE IF NOT EXISTS shadow_trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- One shadow trade per AI trade plan: UNIQUE gives free idempotency via
  -- ON CONFLICT (ai_trade_plan_id) DO NOTHING when a cycle is re-processed.
  ai_trade_plan_id UUID NOT NULL UNIQUE REFERENCES ai_trade_plans(id),
  analysis_run_id UUID REFERENCES ai_analysis_runs(id),
  symbol TEXT NOT NULL,
  asset_class TEXT NOT NULL DEFAULT 'OTHER',
  m5_candle_timestamp TIMESTAMPTZ NOT NULL,

  direction TEXT NOT NULL CHECK (direction IN ('BUY','SELL')),
  action TEXT NOT NULL CHECK (action IN ('ENTER_NOW','WAIT_FOR_ENTRY')),
  order_type TEXT NOT NULL CHECK (order_type IN ('MARKET','BUY_LIMIT','SELL_LIMIT','BUY_STOP','SELL_STOP')),

  planned_entry NUMERIC(18,8),
  entry_zone_low NUMERIC(18,8),
  entry_zone_high NUMERIC(18,8),
  trigger_price NUMERIC(18,8),
  stop_loss NUMERIC(18,8) NOT NULL,
  take_profit NUMERIC(18,8) NOT NULL,
  risk_reward NUMERIC(18,8),

  confidence_pct NUMERIC(8,4),
  tradeability_pct NUMERIC(8,4),
  profitability_score NUMERIC(8,4),

  ai_provider TEXT,
  ai_model TEXT,
  ai_prompt_version TEXT,

  -- Learning dataset feature snapshot (spec section 14): per-timeframe
  -- trend/RSI/MACD/ATR, spread/ATR, support/resistance distance, entry/SL/TP
  -- distance, R:R — extracted once at creation time from the same
  -- MarketAnalysisPackage the AI plan itself was built from (no extra MT5
  -- calls). Kept lightweight/derived rather than the full raw package
  -- (already stored once on ai_analysis_runs.market_analysis_package, joined
  -- via analysis_run_id when the full package is ever needed).
  feature_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,

  plan_expiry TIMESTAMPTZ NOT NULL,

  status TEXT NOT NULL DEFAULT 'AWAITING_TRIGGER' CHECK (status IN (
    'AWAITING_TRIGGER',
    'ENTERED',
    'EXPIRED_NOT_TRIGGERED',
    'CLOSED'
  )),
  exit_reason TEXT CHECK (exit_reason IN (
    'TAKE_PROFIT','STOP_LOSS','TIME_EXIT','PLAN_INVALIDATED','OTHER','AMBIGUOUS_OUTCOME'
  )),

  actual_shadow_entry NUMERIC(18,8),
  actual_shadow_exit NUMERIC(18,8),
  entered_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,

  net_result_estimate NUMERIC(18,8),
  r_multiple NUMERIC(10,4),
  holding_minutes INTEGER,
  -- Maximum Favorable/Adverse Excursion while the shadow position was open,
  -- expressed in R-multiples (consistent unit with r_multiple/net_result_estimate
  -- above) rather than raw price, so MFE/MAE stay comparable across symbols
  -- with very different price scales.
  mfe_r NUMERIC(10,4),
  mae_r NUMERIC(10,4),

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS shadow_trades_status_idx ON shadow_trades(status, plan_expiry);
CREATE INDEX IF NOT EXISTS shadow_trades_symbol_idx ON shadow_trades(symbol, created_at DESC);
CREATE INDEX IF NOT EXISTS shadow_trades_created_at_idx ON shadow_trades(created_at DESC);

INSERT INTO system_settings(key, value, description)
VALUES
  ('fast_learning_mode_enabled', 'false'::jsonb, 'M5 Fast Learning Mode: auto-triggers one AI cycle per completed M5 candle and creates Shadow Trades (never real orders). Server-side flag only — never authorized by a frontend toggle.')
ON CONFLICT (key) DO NOTHING;
