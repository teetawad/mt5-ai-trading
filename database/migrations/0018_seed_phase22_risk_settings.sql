INSERT INTO system_settings (key, value, description)
VALUES
    ('phase22_stop_loss_pct',              '2',     'Phase 22 default stop loss percentage for PAPER bracket entries'),
    ('phase22_take_profit_pct',            '4',     'Phase 22 default take profit percentage for PAPER bracket entries'),
    ('phase22_max_loss_per_trade_usd',     '100',   'Phase 22 maximum PAPER risk budget per trade'),
    ('phase22_max_bid_ask_spread_pct',     '0.5',   'Phase 22 maximum acceptable bid/ask spread percentage'),
    ('phase22_estimated_slippage_pct',     '0.05',  'Phase 22 estimated PAPER slippage percentage used in sizing and checks'),
    ('phase22_max_estimated_slippage_pct', '0.25',  'Phase 22 maximum acceptable estimated PAPER slippage percentage'),
    ('phase22_prevent_duplicate_exposure', 'true',  'Phase 22 prevent adding exposure when a position already exists for the symbol')
ON CONFLICT (key) DO NOTHING;
