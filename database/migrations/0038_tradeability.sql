-- "ALL VALID SETUPS ARE DEMO-ACTIONABLE": adds the AI's own tradeability_pct
-- (descriptive setup-quality rating, independent of confidence_pct — see
-- tradeability.ts) and widens the `action` CHECK constraint to the new
-- three-action model (ENTER_NOW/WAIT_FOR_ENTRY/NO_EXECUTION replaces the
-- old WATCH/NO_TRADE pair). WATCH/NO_TRADE are kept in the allowed set
-- purely so historical rows written before this refactor remain valid —
-- they are simply excluded from current-model statistics (action-stats.ts).
-- Additive only: plan.decision, trade_score/trade_rating (kept as a
-- secondary dataset-comparison diagnostic — see trade-score.ts), and every
-- other existing column are unchanged.

ALTER TABLE ai_analysis_runs ADD COLUMN IF NOT EXISTS tradeability_pct NUMERIC(8,4);
ALTER TABLE ai_trade_plans ADD COLUMN IF NOT EXISTS tradeability_pct NUMERIC(8,4);
ALTER TABLE ai_trade_plans ADD COLUMN IF NOT EXISTS tradeability_rating TEXT
  CHECK (tradeability_rating IN ('STRONG','GOOD','FAIR','LOW','VERY_LOW'));

ALTER TABLE ai_analysis_runs DROP CONSTRAINT IF EXISTS ai_analysis_runs_action_check;
ALTER TABLE ai_analysis_runs ADD CONSTRAINT ai_analysis_runs_action_check
  CHECK (action IN ('ENTER_NOW','WAIT_FOR_ENTRY','NO_EXECUTION','WATCH','NO_TRADE'));

ALTER TABLE ai_trade_plans DROP CONSTRAINT IF EXISTS ai_trade_plans_action_check;
ALTER TABLE ai_trade_plans ADD CONSTRAINT ai_trade_plans_action_check
  CHECK (action IN ('ENTER_NOW','WAIT_FOR_ENTRY','NO_EXECUTION','WATCH','NO_TRADE'));
