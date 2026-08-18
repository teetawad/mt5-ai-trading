-- Replaces the ambiguous, catch-all "WAIT" with four explicit,
-- server-computed actions (decision-policy.ts): ENTER_NOW, WAIT_FOR_ENTRY,
-- WATCH, NO_TRADE. Additive only — plan.decision (BUY/SELL/WAIT, the AI's
-- own directional thesis) and every existing column are unchanged; `action`
-- is a separate, deterministic classification of what to actually DO about
-- that thesis, computed from Trade Score + confidence + market/data status +
-- the (unchanged, still-authoritative) Risk Engine result.

ALTER TABLE ai_analysis_runs ADD COLUMN IF NOT EXISTS action TEXT
  CHECK (action IN ('ENTER_NOW','WAIT_FOR_ENTRY','WATCH','NO_TRADE'));
ALTER TABLE ai_analysis_runs ADD COLUMN IF NOT EXISTS action_reason TEXT;

ALTER TABLE ai_trade_plans ADD COLUMN IF NOT EXISTS action TEXT
  CHECK (action IN ('ENTER_NOW','WAIT_FOR_ENTRY','WATCH','NO_TRADE'));
ALTER TABLE ai_trade_plans ADD COLUMN IF NOT EXISTS action_reason TEXT;

CREATE INDEX IF NOT EXISTS ai_analysis_runs_action_idx
  ON ai_analysis_runs(action, created_at DESC) WHERE action IS NOT NULL;

CREATE INDEX IF NOT EXISTS ai_trade_plans_action_idx
  ON ai_trade_plans(action, created_at DESC) WHERE action IS NOT NULL;
