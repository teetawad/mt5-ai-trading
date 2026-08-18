-- Trade Score: an explicit, auditable "is this worth trading?" quality
-- score, deliberately independent of AI confidence (spec: AI confidence is
-- certainty of analysis; Trade Score is attractiveness of the setup).
-- Additive only.

ALTER TABLE ai_analysis_runs ADD COLUMN IF NOT EXISTS trade_score NUMERIC(5,2);
ALTER TABLE ai_analysis_runs ADD COLUMN IF NOT EXISTS trade_rating TEXT
  CHECK (trade_rating IN ('AVOID','WEAK','FAIR','GOOD','STRONG'));
ALTER TABLE ai_analysis_runs ADD COLUMN IF NOT EXISTS score_breakdown JSONB;

ALTER TABLE ai_trade_plans ADD COLUMN IF NOT EXISTS trade_score NUMERIC(5,2);
ALTER TABLE ai_trade_plans ADD COLUMN IF NOT EXISTS trade_rating TEXT
  CHECK (trade_rating IN ('AVOID','WEAK','FAIR','GOOD','STRONG'));
ALTER TABLE ai_trade_plans ADD COLUMN IF NOT EXISTS score_breakdown JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE ai_trade_plans ADD COLUMN IF NOT EXISTS risks JSONB NOT NULL DEFAULT '[]'::jsonb;

-- ai_trade_plans.opportunity_score (NOT NULL DEFAULT 0) predates Trade Score
-- and is superseded by it for V3 plans; the column is kept as-is (its
-- default already satisfies new inserts that no longer populate it) rather
-- than dropped, since BASELINE_MT5_H1_V1's own data model is untouched here.

CREATE INDEX IF NOT EXISTS ai_trade_plans_trade_score_idx
  ON ai_trade_plans(trade_score DESC) WHERE trade_score IS NOT NULL;

CREATE INDEX IF NOT EXISTS ai_analysis_runs_trade_score_idx
  ON ai_analysis_runs(symbol, trade_score DESC, created_at DESC) WHERE trade_score IS NOT NULL;
