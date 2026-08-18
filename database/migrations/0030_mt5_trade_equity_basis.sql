-- Records the MT5 DEMO account equity at the moment a trade was opened, so
-- History can show a real "% account return" per closed trade computed from
-- the actual equity basis at entry, instead of inventing a return percentage
-- from current/unrelated equity. NULL for trades executed before this
-- column existed — History must show "unavailable" for those, never a
-- fabricated percentage.

ALTER TABLE trade_outcomes ADD COLUMN IF NOT EXISTS account_equity_at_entry NUMERIC(18,8);
