-- MT5 AI DEMO Trading Lab.
-- Additive migration: preserves owner/auth/audit/history while introducing a
-- broker-neutral MT5 DEMO architecture and deprecating Alpaca-era settings.

CREATE TABLE IF NOT EXISTS mt5_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  login BIGINT NOT NULL,
  server TEXT NOT NULL,
  broker TEXT,
  currency TEXT,
  trade_mode TEXT NOT NULL CHECK (trade_mode = 'DEMO'),
  balance NUMERIC(18,8) NOT NULL DEFAULT 0,
  equity NUMERIC(18,8) NOT NULL DEFAULT 0,
  margin NUMERIC(18,8) NOT NULL DEFAULT 0,
  free_margin NUMERIC(18,8) NOT NULL DEFAULT 0,
  terminal_trade_allowed BOOLEAN NOT NULL DEFAULT false,
  demo_verified BOOLEAN NOT NULL DEFAULT false,
  last_verified_at TIMESTAMPTZ,
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (login, server)
);

CREATE TABLE IF NOT EXISTS instruments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol TEXT NOT NULL UNIQUE,
  broker_symbol TEXT NOT NULL,
  asset_class TEXT NOT NULL DEFAULT 'OTHER',
  description TEXT,
  currency_base TEXT,
  currency_profit TEXT,
  point NUMERIC(18,8),
  trade_tick_size NUMERIC(18,8),
  trade_tick_value NUMERIC(18,8),
  volume_min NUMERIC(18,8),
  volume_max NUMERIC(18,8),
  volume_step NUMERIC(18,8),
  trade_stops_level INTEGER,
  visible BOOLEAN NOT NULL DEFAULT true,
  enabled BOOLEAN NOT NULL DEFAULT false,
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS watchlists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL DEFAULT 'Owner MT5 Demo Watchlist',
  symbol TEXT NOT NULL REFERENCES instruments(symbol) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT true,
  rank INTEGER NOT NULL DEFAULT 100,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (name, symbol)
);

CREATE TABLE IF NOT EXISTS market_bars (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  opened_at TIMESTAMPTZ NOT NULL,
  open NUMERIC(18,8) NOT NULL,
  high NUMERIC(18,8) NOT NULL,
  low NUMERIC(18,8) NOT NULL,
  close NUMERIC(18,8) NOT NULL,
  tick_volume NUMERIC(18,8) NOT NULL DEFAULT 0,
  spread NUMERIC(18,8),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (symbol, timeframe, opened_at)
);

CREATE TABLE IF NOT EXISTS ai_models (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('BASELINE','CHAMPION','CHALLENGER')),
  active_version_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS model_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id UUID NOT NULL REFERENCES ai_models(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('CHAMPION','CHALLENGER','REJECTED','ARCHIVED')),
  parameters JSONB NOT NULL DEFAULT '{}'::jsonb,
  promoted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (model_id, version)
);

ALTER TABLE ai_models
  ADD CONSTRAINT ai_models_active_version_fk
  FOREIGN KEY (active_version_id) REFERENCES model_versions(id);

CREATE TABLE IF NOT EXISTS feature_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  signal_candle_timestamp TIMESTAMPTZ NOT NULL,
  features JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (symbol, timeframe, signal_candle_timestamp)
);

CREATE TABLE IF NOT EXISTS ai_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_snapshot_id UUID REFERENCES feature_snapshots(id),
  symbol TEXT NOT NULL,
  asset_class TEXT NOT NULL,
  timeframe TEXT NOT NULL DEFAULT 'H1',
  decision TEXT NOT NULL CHECK (decision IN ('BUY','SELL','HOLD','NO_TRADE','RISK_REJECTED')),
  confidence NUMERIC(8,4) NOT NULL DEFAULT 0,
  opportunity_score NUMERIC(10,4) NOT NULL DEFAULT 0,
  reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  reference_entry NUMERIC(18,8),
  stop_loss NUMERIC(18,8),
  take_profit NUMERIC(18,8),
  risk_reward NUMERIC(18,8),
  expected_holding_hours INTEGER,
  signal_candle_timestamp TIMESTAMPTZ NOT NULL,
  model_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (symbol, timeframe, signal_candle_timestamp, model_version)
);

CREATE TABLE IF NOT EXISTS scanner_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'RUNNING',
  symbols_scanned INTEGER NOT NULL DEFAULT 0,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS risk_evaluations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ai_decision_id UUID REFERENCES ai_decisions(id),
  symbol TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('PASS','REJECT')),
  failed_rules JSONB NOT NULL DEFAULT '[]'::jsonb,
  reason TEXT,
  snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS trade_outcomes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol TEXT NOT NULL,
  ai_decision_id UUID REFERENCES ai_decisions(id),
  order_ticket TEXT,
  side TEXT NOT NULL,
  volume NUMERIC(18,8) NOT NULL,
  expected_entry NUMERIC(18,8),
  actual_entry NUMERIC(18,8),
  stop_loss NUMERIC(18,8),
  take_profit NUMERIC(18,8),
  risk_amount NUMERIC(18,8),
  risk_reward NUMERIC(18,8),
  spread NUMERIC(18,8),
  slippage NUMERIC(18,8),
  exit_reason TEXT CHECK (exit_reason IN ('STOP_LOSS','TAKE_PROFIT','MANUAL_CLOSE','TIME_EXIT','RISK_EXIT','BROKER_CLOSE','OTHER')),
  realized_pnl NUMERIC(18,8),
  fees NUMERIC(18,8),
  mfe NUMERIC(18,8),
  mae NUMERIC(18,8),
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS training_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_name TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL,
  train_start TIMESTAMPTZ,
  train_end TIMESTAMPTZ,
  validation_start TIMESTAMPTZ,
  validation_end TIMESTAMPTZ,
  test_start TIMESTAMPTZ,
  test_end TIMESTAMPTZ,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS backtest_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_version TEXT NOT NULL,
  symbol_set JSONB NOT NULL DEFAULT '[]'::jsonb,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  assumptions JSONB NOT NULL DEFAULT '{}'::jsonb,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS model_evaluations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  champion_version TEXT NOT NULL,
  challenger_version TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('PROMOTED','REJECTED')),
  promotion_reason TEXT,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO system_settings(key, value, description)
VALUES
  ('trading_mode', '"MT5_DEMO"'::jsonb, 'Only MT5 DEMO execution is allowed.'),
  ('mt5_auto_demo_enabled', 'false'::jsonb, 'AUTO-DEMO is default off and owner-controlled.'),
  ('mt5_kill_switch_enabled', 'true'::jsonb, 'When true, blocks new MT5 demo entries.'),
  ('mt5_max_risk_per_trade_pct', '"0.50"'::jsonb, 'Max account-equity risk per trade.'),
  ('mt5_max_loss_per_trade', '"100.00"'::jsonb, 'Max monetary loss per demo trade.'),
  ('mt5_max_daily_loss', '"300.00"'::jsonb, 'Daily loss limit for new entries.'),
  ('mt5_max_drawdown_pct', '"5.00"'::jsonb, 'Max drawdown guard for new entries.'),
  ('mt5_max_simultaneous_positions', '3'::jsonb, 'Max open MT5 demo positions.'),
  ('mt5_max_trades_per_day', '6'::jsonb, 'Max MT5 demo entries per UTC day.'),
  ('mt5_min_risk_reward', '"1.50"'::jsonb, 'Minimum acceptable reward/risk.'),
  ('mt5_max_spread_points', '50'::jsonb, 'Default max spread in symbol points.'),
  ('mt5_quote_staleness_seconds', '10'::jsonb, 'Reject execution on stale MT5 quotes.'),
  ('mt5_allowed_deviation_points', '20'::jsonb, 'Max MT5 order deviation.'),
  ('mt5_cooldown_minutes', '60'::jsonb, 'Per-symbol cooldown between new entries.')
ON CONFLICT (key) DO NOTHING;

INSERT INTO ai_models(name, kind)
VALUES ('MT5_H1_BASELINE', 'BASELINE')
ON CONFLICT (name) DO NOTHING;

WITH model AS (
  SELECT id FROM ai_models WHERE name = 'MT5_H1_BASELINE'
), version AS (
  INSERT INTO model_versions(model_id, version, status, parameters)
  SELECT id, 'BASELINE_MT5_H1_V1', 'CHAMPION', '{"timeframe":"H1","type":"deterministic_baseline"}'::jsonb
  FROM model
  ON CONFLICT (model_id, version) DO UPDATE SET status = EXCLUDED.status
  RETURNING id
)
UPDATE ai_models SET active_version_id = (SELECT id FROM version)
WHERE name = 'MT5_H1_BASELINE';
