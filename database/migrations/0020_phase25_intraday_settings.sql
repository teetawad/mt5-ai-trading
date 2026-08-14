-- Phase 25: intraday trading mode settings and new automatic-exit reasons.

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_exit_reason_check;
ALTER TABLE orders ADD CONSTRAINT orders_exit_reason_check CHECK (
    exit_reason IS NULL OR exit_reason IN (
        'TAKE_PROFIT', 'STOP_LOSS', 'MANUAL', 'OTHER',
        'MAX_HOLDING_TIME', 'END_OF_DAY'
    )
);

INSERT INTO system_settings (key, value, description)
VALUES
    ('phase25_intraday_mode_enabled', 'false', 'Phase 25 master toggle for intraday trading mode'),
    ('phase25_trend_ema_fast', '8', 'Phase 25 fast EMA period (1h trend)'),
    ('phase25_trend_ema_slow', '21', 'Phase 25 slow EMA period (1h trend)'),
    ('phase25_setup_momentum_window', '6', 'Phase 25 momentum lookback bars (15m setup)'),
    ('phase25_setup_volume_window', '20', 'Phase 25 volume average lookback bars (15m setup)'),
    ('phase25_entry_momentum_window', '3', 'Phase 25 momentum lookback bars (5m entry)'),
    ('phase25_entry_volume_window', '20', 'Phase 25 volume average lookback bars (5m entry)'),
    ('phase25_atr_window', '14', 'Phase 25 ATR period used for stop/target sizing'),
    ('phase25_stop_atr_multiple', '1.5', 'Phase 25 stop-loss distance as a multiple of ATR'),
    ('phase25_take_profit_atr_multiple', '3.0', 'Phase 25 take-profit distance as a multiple of ATR'),
    ('phase25_min_risk_reward', '1.5', 'Phase 25 minimum acceptable reward/risk ratio'),
    ('phase25_max_spread_pct', '0.5', 'Phase 25 maximum acceptable bid/ask spread percentage'),
    ('phase25_min_volume_ratio', '1.0', 'Phase 25 minimum volume-confirmation ratio (setup and entry)'),
    ('phase25_max_holding_minutes', '120', 'Phase 25 maximum minutes an intraday position may stay open'),
    ('phase25_default_quantity', '1', 'Phase 25 default requested quantity before risk-based sizing'),
    ('phase25_max_loss_per_trade_usd', '100', 'Phase 25 maximum PAPER risk budget per intraday trade'),
    ('phase25_max_trades_per_symbol_per_day', '3', 'Phase 25 maximum intraday trades for a single symbol per day'),
    ('phase25_max_trades_per_day_total', '10', 'Phase 25 maximum total intraday trades per day, all symbols combined'),
    ('phase25_cooldown_seconds_per_symbol', '900', 'Phase 25 per-symbol cooldown between intraday trades, in seconds'),
    ('phase25_session_market_open', '"13:30"', 'Phase 25 regular US market open time (UTC, HH:MM)'),
    ('phase25_session_market_close', '"20:00"', 'Phase 25 regular US market close time (UTC, HH:MM)'),
    ('phase25_no_new_trades_minutes_before_close', '15', 'Phase 25 minutes before close after which no new intraday trades open'),
    ('phase25_force_close_before_close_minutes', '5', 'Phase 25 minutes before close at which open intraday positions are force-closed'),
    ('phase25_force_close_enabled', 'true', 'Phase 25 whether open intraday positions are automatically force-closed before market close')
ON CONFLICT (key) DO NOTHING;
