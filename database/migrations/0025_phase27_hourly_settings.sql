-- Phase 27: Hourly Intraday Trading settings. Single 1H-candle primary
-- timeframe (higher-timeframe bars are confirmation-only, never triggering
-- on their own). Master toggle defaults to ENABLED — hourly trading is the
-- platform's primary architecture; phase25_intraday_mode_enabled already
-- defaults to false, so only one active strategy path is reachable by
-- default.

INSERT INTO system_settings (key, value, description)
VALUES
    ('phase27_hourly_mode_enabled',              'true',  'Phase 27 master toggle for hourly trading mode (primary architecture, default ON)'),
    ('phase27_trend_ema_fast',                   '8',     'Phase 27 fast EMA period (1h trend)'),
    ('phase27_trend_ema_slow',                   '21',    'Phase 27 slow EMA period (1h trend)'),
    ('phase27_momentum_window',                  '3',     'Phase 27 1h momentum lookback bars'),
    ('phase27_volume_window',                    '20',    'Phase 27 1h volume-average lookback bars'),
    ('phase27_breakout_lookback_bars',            '20',    'Phase 27 rolling high/low lookback for breakout/pullback structure'),
    ('phase27_min_volume_ratio',                 '1.0',   'Phase 27 minimum volume-confirmation ratio'),
    ('phase27_atr_window',                       '14',    'Phase 27 ATR period used for stop/target sizing'),
    ('phase27_stop_atr_multiple',                '1.5',   'Phase 27 stop-loss distance as a multiple of ATR'),
    ('phase27_take_profit_atr_multiple',         '3.0',   'Phase 27 take-profit distance as a multiple of ATR'),
    ('phase27_min_risk_reward',                  '1.5',   'Phase 27 minimum acceptable reward/risk ratio'),
    ('phase27_higher_tf_bars_per_candle',        '4',     'Phase 27 number of 1h bars resampled into one higher-timeframe confirmation bar (4 = 4H)'),
    ('phase27_higher_tf_confirmation_required',  'true',  'Phase 27 whether higher-timeframe trend must agree with 1h trend (confirmation only, never triggers alone)'),
    ('phase27_max_spread_pct',                   '0.5',   'Phase 27 maximum acceptable bid/ask spread percentage'),
    ('phase27_estimated_slippage_pct',           '0.05',  'Phase 27 estimated PAPER slippage percentage used in sizing and checks'),
    ('phase27_max_estimated_slippage_pct',       '0.25',  'Phase 27 maximum acceptable estimated PAPER slippage percentage'),
    ('phase27_max_holding_hours',                '8',     'Phase 27 maximum hours an hourly position may stay open'),
    ('phase27_default_quantity',                 '1',     'Phase 27 default requested quantity before risk-based sizing'),
    ('phase27_max_loss_per_trade_usd',           '100',   'Phase 27 maximum PAPER risk budget per hourly trade'),
    ('phase27_max_trades_per_symbol_per_day',    '3',     'Phase 27 maximum hourly trades for a single symbol per day'),
    ('phase27_max_trades_per_day_total',         '10',    'Phase 27 maximum total hourly trades per day, all symbols combined'),
    ('phase27_cooldown_seconds_per_symbol',      '3600',  'Phase 27 per-symbol cooldown between hourly trades, in seconds (one candle)'),
    ('phase27_session_market_open',              '"13:30"', 'Phase 27 regular US market open time (UTC, HH:MM)'),
    ('phase27_session_market_close',             '"20:00"', 'Phase 27 regular US market close time (UTC, HH:MM)'),
    ('phase27_no_new_trades_minutes_before_close', '60',  'Phase 27 minutes before close after which no new hourly candle opens a trade (skip last candle)'),
    ('phase27_force_close_before_close_minutes', '30',    'Phase 27 minutes before close at which open hourly positions are force-closed'),
    ('phase27_force_close_enabled',              'true',  'Phase 27 whether open hourly positions are automatically force-closed before market close')
ON CONFLICT (key) DO NOTHING;
