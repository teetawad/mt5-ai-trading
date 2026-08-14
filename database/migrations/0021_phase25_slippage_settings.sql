-- Phase 25: explicit slippage limit alongside the existing spread limit
-- ("spread/slippage limits" in the risk engine requirements), matching the
-- Phase 22 estimated-slippage pattern.

INSERT INTO system_settings (key, value, description)
VALUES
    ('phase25_estimated_slippage_pct', '0.05', 'Phase 25 estimated PAPER slippage percentage used in sizing and checks'),
    ('phase25_max_estimated_slippage_pct', '0.25', 'Phase 25 maximum acceptable estimated PAPER slippage percentage')
ON CONFLICT (key) DO NOTHING;
