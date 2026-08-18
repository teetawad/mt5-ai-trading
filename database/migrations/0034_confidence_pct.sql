-- Fixes the "AI Confidence: 1%" bug end-to-end.
--
-- Root cause: OpenAI (and potentially other providers) returned "confidence"
-- as a 0-1 probability (e.g. 0.74) despite being asked for a 0-100 value.
-- That silently passed the old loose "number between 0 and 100" check, was
-- stored as-is, and the frontend then did Math.round(0.74) === 1, displaying
-- "1%" for nearly every analysis. Confirmed empirically: every existing row
-- in ai_trade_plans/ai_analysis_runs holds a value in [0,1], never a
-- genuinely-canonical 2..100 integer.
--
-- Fix: rename the column to confidence_pct (the new, unambiguous canonical
-- contract — see apps/api/src/services/trading-ai/confidence.ts) and
-- normalize existing data with the SAME heuristic as the new application
-- code: only values already within [0,1] are scaled up (0.74 -> 74); a
-- genuinely-canonical value (e.g. a future 48 or 100) is left untouched
-- (never turned into 4800).

UPDATE ai_trade_plans
SET confidence = ROUND(confidence * 100)
WHERE confidence >= 0 AND confidence <= 1;

UPDATE ai_analysis_runs
SET confidence = ROUND(confidence * 100)
WHERE confidence >= 0 AND confidence <= 1;

ALTER TABLE ai_trade_plans RENAME COLUMN confidence TO confidence_pct;
ALTER TABLE ai_analysis_runs RENAME COLUMN confidence TO confidence_pct;
