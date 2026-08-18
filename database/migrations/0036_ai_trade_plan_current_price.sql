-- Trading AI V3: the AI's structured plan now always reports current_price
-- for actionable BUY/SELL plans (see types.ts / schema.ts) so that
-- PULLBACK/BREAKOUT entries can be validated for directional sanity against
-- the real market price at analysis time, and so broker-aware stop-distance
-- checks (broker-price.ts) have a real anchor to measure from at approval
-- time. Additive only.
ALTER TABLE ai_trade_plans ADD COLUMN IF NOT EXISTS current_price NUMERIC(18,8);
