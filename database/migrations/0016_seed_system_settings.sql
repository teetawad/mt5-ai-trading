-- Default system settings. All risk thresholds marked CONFIGURE BEFORE USE.
-- The owner must review and adjust these values before live paper trading.

INSERT INTO system_settings (key, value, description) VALUES
    ('trading_kill_switch_enabled', 'true',   'When false, no proposals can proceed to execution'),
    ('trading_mode',                '"PAPER"', 'Must always be PAPER in this codebase'),
    ('max_order_notional_usd',      '10000',  'Maximum USD notional per order — CONFIGURE BEFORE USE'),
    ('max_position_size_usd',       '50000',  'Maximum USD position size per symbol — CONFIGURE BEFORE USE'),
    ('max_portfolio_concentration_pct', '0.20', 'Max fraction of portfolio in one symbol — CONFIGURE BEFORE USE'),
    ('max_open_positions',          '10',     'Maximum number of concurrent open positions — CONFIGURE BEFORE USE'),
    ('max_daily_loss_usd',          '1000',   'Maximum daily loss before kill switch triggers — CONFIGURE BEFORE USE'),
    ('proposal_ttl_seconds',        '300',    'Seconds before a proposal expires — CONFIGURE BEFORE USE'),
    ('price_drift_threshold_pct',   '0.02',   'Max allowed price drift from reference price (2%) — CONFIGURE BEFORE USE'),
    ('market_data_staleness_seconds', '60',   'Seconds before market data is considered stale — CONFIGURE BEFORE USE'),
    ('initial_paper_cash_usd',      '100000', 'Starting cash balance for paper portfolio — CONFIGURE BEFORE USE'),
    ('cooldown_between_trades_seconds', '0',  'Minimum seconds between trades per symbol (0 = disabled) — CONFIGURE BEFORE USE')
ON CONFLICT (key) DO NOTHING;
