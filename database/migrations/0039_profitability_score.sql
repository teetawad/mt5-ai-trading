-- "FIND BEST TRADES" AI Profitability Score (spec sections 6-10): adds the
-- AI's own risk-adjusted profitability_score (0-100), independent of both
-- confidence_pct and tradeability_pct — see profitability.ts. This is the
-- field opportunity-scan.ts's TOP 10 ranking is primarily sorted by.
-- Additive only.

ALTER TABLE ai_analysis_runs ADD COLUMN IF NOT EXISTS profitability_score NUMERIC(8,4);
ALTER TABLE ai_trade_plans ADD COLUMN IF NOT EXISTS profitability_score NUMERIC(8,4);
