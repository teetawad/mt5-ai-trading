-- Phase 26: Crypto PAPER trading (BTC/USD, ETH/USD) alongside existing US Stocks.
--
-- asset_class is denormalized onto signals/trade_proposals/orders/positions,
-- matching this schema's existing convention of denormalizing `symbol` onto
-- every trade-lifecycle table rather than normalizing into a shared table.
-- Defaulting to 'STOCK' is backward-compatible: every existing row and every
-- existing STOCK code path is unaffected.

ALTER TABLE signals ADD COLUMN IF NOT EXISTS asset_class TEXT NOT NULL DEFAULT 'STOCK';
ALTER TABLE signals DROP CONSTRAINT IF EXISTS signals_asset_class_check;
ALTER TABLE signals ADD CONSTRAINT signals_asset_class_check CHECK (asset_class IN ('STOCK', 'CRYPTO'));

ALTER TABLE trade_proposals ADD COLUMN IF NOT EXISTS asset_class TEXT NOT NULL DEFAULT 'STOCK';
ALTER TABLE trade_proposals DROP CONSTRAINT IF EXISTS trade_proposals_asset_class_check;
ALTER TABLE trade_proposals ADD CONSTRAINT trade_proposals_asset_class_check CHECK (asset_class IN ('STOCK', 'CRYPTO'));

ALTER TABLE orders ADD COLUMN IF NOT EXISTS asset_class TEXT NOT NULL DEFAULT 'STOCK';
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_asset_class_check;
ALTER TABLE orders ADD CONSTRAINT orders_asset_class_check CHECK (asset_class IN ('STOCK', 'CRYPTO'));

ALTER TABLE positions ADD COLUMN IF NOT EXISTS asset_class TEXT NOT NULL DEFAULT 'STOCK';
ALTER TABLE positions DROP CONSTRAINT IF EXISTS positions_asset_class_check;
ALTER TABLE positions ADD CONSTRAINT positions_asset_class_check CHECK (asset_class IN ('STOCK', 'CRYPTO'));

CREATE INDEX IF NOT EXISTS signals_asset_class_idx ON signals(asset_class);
CREATE INDEX IF NOT EXISTS trade_proposals_asset_class_idx ON trade_proposals(asset_class);
CREATE INDEX IF NOT EXISTS orders_asset_class_idx ON orders(asset_class);
CREATE INDEX IF NOT EXISTS positions_asset_class_idx ON positions(asset_class);

-- Phase 26 crypto trading settings, mirroring the Phase 25 intraday settings
-- pattern (system_settings key/value, JSONB values). Master toggle defaults
-- to disabled — an owner must explicitly opt in, same as phase25.
INSERT INTO system_settings (key, value, description)
VALUES
    ('phase26_crypto_trading_enabled',        'false', 'Phase 26 master toggle for crypto PAPER trading'),
    ('phase26_supported_symbols',             '["BTC/USD", "ETH/USD"]', 'Phase 26 crypto symbols supported for PAPER trading'),
    ('phase26_trend_ema_fast',                '8',    'Phase 26 fast EMA period (1h trend)'),
    ('phase26_trend_ema_slow',                '21',   'Phase 26 slow EMA period (1h trend)'),
    ('phase26_setup_momentum_window',         '6',    'Phase 26 momentum lookback bars (15m setup)'),
    ('phase26_setup_volume_window',           '20',   'Phase 26 volume average lookback bars (15m setup)'),
    ('phase26_entry_momentum_window',         '3',    'Phase 26 momentum lookback bars (5m entry)'),
    ('phase26_entry_volume_window',           '20',   'Phase 26 volume average lookback bars (5m entry)'),
    ('phase26_atr_window',                    '14',   'Phase 26 ATR period used for stop/target sizing'),
    ('phase26_stop_atr_multiple',             '1.5',  'Phase 26 stop-loss distance as a multiple of ATR'),
    ('phase26_take_profit_atr_multiple',      '3.0',  'Phase 26 take-profit distance as a multiple of ATR'),
    ('phase26_min_risk_reward',               '1.5',  'Phase 26 minimum acceptable reward/risk ratio'),
    ('phase26_min_volume_ratio',              '1.0',  'Phase 26 minimum volume-confirmation ratio (setup and entry)'),
    ('phase26_max_spread_pct',                '0.75', 'Phase 26 maximum acceptable bid/ask spread percentage (crypto is wider than equities)'),
    ('phase26_estimated_slippage_pct',        '0.10', 'Phase 26 estimated PAPER slippage percentage used in sizing and checks'),
    ('phase26_max_estimated_slippage_pct',    '0.50', 'Phase 26 maximum acceptable estimated PAPER slippage percentage'),
    ('phase26_fee_bps',                       '10',   'Phase 26 simulated PAPER trading fee in basis points of notional (percentage-based, unlike the per-share stock fee)'),
    ('phase26_default_quantity',              '0.01', 'Phase 26 default requested quantity before risk-based sizing'),
    ('phase26_max_loss_per_trade_usd',        '100',  'Phase 26 maximum PAPER risk budget per crypto trade'),
    ('phase26_max_daily_loss_usd',            '300',  'Phase 26 additional crypto-specific daily-loss gate, layered on top of the platform-wide daily-loss kill switch'),
    ('phase26_max_trades_per_symbol_per_day', '5',    'Phase 26 maximum crypto trades for a single symbol per day'),
    ('phase26_max_trades_per_day_total',      '15',   'Phase 26 maximum total crypto trades per day, all symbols combined'),
    ('phase26_cooldown_seconds_per_symbol',   '900',  'Phase 26 per-symbol cooldown between crypto trades, in seconds')
ON CONFLICT (key) DO NOTHING;
