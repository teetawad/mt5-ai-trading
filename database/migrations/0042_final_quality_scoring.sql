-- Final Quality Score / TOP 5 REAL DEMO candidates (owner spec: "Upgrade ...
-- so the Trading AI becomes more selective for REAL DEMO trades ... use TOP
-- 5 REAL DEMO candidates per completed M5 cycle"). Purely additive columns
-- on opportunity_scan_results (spec section 23's dataset) so existing rows
-- and every other reader of this table (fast-learning-dashboard.ts's rank
-- comparison, History) are unaffected.

ALTER TABLE opportunity_scan_results ADD COLUMN IF NOT EXISTS multi_timeframe_alignment_score NUMERIC(8,4);
ALTER TABLE opportunity_scan_results ADD COLUMN IF NOT EXISTS historical_performance_score NUMERIC(8,4);
ALTER TABLE opportunity_scan_results ADD COLUMN IF NOT EXISTS historical_adjustment NUMERIC(8,4) NOT NULL DEFAULT 0;
ALTER TABLE opportunity_scan_results ADD COLUMN IF NOT EXISTS historical_adjustment_reason TEXT;
ALTER TABLE opportunity_scan_results ADD COLUMN IF NOT EXISTS final_quality_score NUMERIC(8,4);

-- HIGH (score >= QUALITY_TIER_HIGH_MIN_SCORE, larger planned max loss),
-- NORMAL (score >= QUALITY_TIER_NORMAL_MIN_SCORE / REAL_DEMO_MIN_FINAL_SCORE),
-- or SHADOW_ONLY (below the REAL DEMO eligibility threshold, or valid but
-- outside this cycle's TOP 5 slots). Never a real order authorization on its
-- own — only ever a ranking/sizing label.
ALTER TABLE opportunity_scan_results ADD COLUMN IF NOT EXISTS risk_tier TEXT
  CHECK (risk_tier IN ('HIGH','NORMAL','SHADOW_ONLY'));

-- True only for the (at most REAL_DEMO_TOP_CANDIDATES) rows that qualified
-- AND were selected for this cycle's REAL DEMO TOP N — never simply "score
-- >= threshold", since a qualifying row beyond the TOP N cap is still
-- SHADOW LEARNING ONLY (spec section 21/22: "TOP 5 means the maximum 5
-- strongest REAL DEMO-eligible candidates... does NOT mean automatically
-- place 5 trades").
ALTER TABLE opportunity_scan_results ADD COLUMN IF NOT EXISTS real_demo_eligible BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE opportunity_scan_results ADD COLUMN IF NOT EXISTS shadow_only_reason TEXT;

CREATE INDEX IF NOT EXISTS opportunity_scan_results_cycle_quality_idx
  ON opportunity_scan_results(source, m5_candle_timestamp, final_quality_score DESC);
