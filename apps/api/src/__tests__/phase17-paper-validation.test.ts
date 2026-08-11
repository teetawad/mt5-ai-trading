import { describe, expect, it } from 'vitest';
import {
  preflightChecks,
  renderMarkdownReport,
  runPhase17Validation,
} from '../validation/phase17-paper-validation';

describe('Phase 17 paper validation safety preflight', () => {
  it('blocks validation when real paper prerequisites are missing', async () => {
    const report = await runPhase17Validation({});

    expect(report.overallStatus).toBe('BLOCKED');
    expect(report.tradingMode).toBe('PAPER');
    expect(report.checks.some((check) => check.name === 'database configured')).toBe(true);
    expect(report.checks.some((check) => check.name === 'paper order execution opt-in')).toBe(true);
  });

  it('fails closed when a live Alpaca trading endpoint is configured', () => {
    const checks = preflightChecks({
      BROKER_PROVIDER: 'alpaca_paper',
      MARKET_DATA_PROVIDER: 'alpaca',
      DATABASE_URL: 'postgres://example',
      TRADING_ENGINE_URL: 'http://localhost:8000',
      ALPACA_PAPER_API_KEY_ID: 'key',
      ALPACA_PAPER_API_SECRET_KEY: 'secret',
      ALPACA_PAPER_TRADING_BASE_URL: 'https://api.alpaca.markets',
      PHASE17_ENABLE_PAPER_ORDERS: 'true',
    });

    expect(checks.find((check) => check.name === 'live trading endpoint guard')).toMatchObject({
      status: 'FAIL',
    });
  });

  it('renders a paper-only markdown report', async () => {
    const report = await runPhase17Validation({});
    const markdown = renderMarkdownReport(report);

    expect(markdown).toContain('Phase 17 Long-Run PAPER Trading Validation Report');
    expect(markdown).toContain('Mode: PAPER');
    expect(markdown).toContain('does not validate or enable live trading');
  });
});
