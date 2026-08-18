-- "FIND BEST TRADES" scan dataset (spec section 20): persists the ranking
-- context produced by each runOpportunityScan() call, independent of
-- ai_trade_plans' own lifecycle (a plan can later be approved/executed/
-- expired — this table is a frozen snapshot of what the scan ranked at the
-- time it ran, so later we can test whether rank #1-3 actually outperform
-- rank #8-10 in trade_outcomes). One row per TOP-10 result per scan run.

CREATE TABLE IF NOT EXISTS opportunity_scan_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id UUID NOT NULL,
  rank INTEGER NOT NULL,
  ai_trade_plan_id UUID REFERENCES ai_trade_plans(id),
  symbol TEXT NOT NULL,
  asset_class TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('BUY','SELL')),
  action TEXT NOT NULL CHECK (action IN ('ENTER_NOW','WAIT_FOR_ENTRY')),
  profitability_score NUMERIC(8,4),
  tradeability_pct NUMERIC(8,4),
  confidence_pct NUMERIC(8,4),
  entry_price NUMERIC(18,8),
  stop_loss NUMERIC(18,8),
  take_profit NUMERIC(18,8),
  risk_reward NUMERIC(18,8),
  max_loss NUMERIC(18,8),
  target_profit NUMERIC(18,8),
  risk_result TEXT CHECK (risk_result IN ('PASS','REJECT')),
  ai_provider TEXT NOT NULL,
  ai_model TEXT NOT NULL,
  ai_prompt_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS opportunity_scan_results_scan_id_idx
  ON opportunity_scan_results(scan_id, rank);

CREATE INDEX IF NOT EXISTS opportunity_scan_results_symbol_idx
  ON opportunity_scan_results(symbol, created_at DESC);
