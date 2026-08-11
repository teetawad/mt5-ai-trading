import { describe, expect, it } from 'vitest';
import {
  preflightChecks,
  renderMarkdownReport,
  runPhase21Validation,
} from '../validation/phase21-paper-operations';

describe('Phase 21 paper operations validation', () => {
  it('blocks validation when operational prerequisites are missing', async () => {
    const report = await runPhase21Validation({});

    expect(report.phase).toBe('21');
    expect(report.tradingMode).toBe('PAPER');
    expect(report.overallStatus).toBe('BLOCKED');
    expect(report.checks.some((check) => check.name === 'api dashboard endpoint configured')).toBe(true);
    expect(
      report.checks.some((check) => check.name === 'phase 21 paper order execution opt-in'),
    ).toBe(true);
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
      PHASE21_ENABLE_PAPER_ORDERS: 'true',
      PHASE21_API_URL: 'http://localhost:4000',
      PHASE21_OWNER_BEARER_TOKEN: 'owner-token',
    });

    expect(checks.find((check) => check.name === 'live trading endpoint guard')).toMatchObject({
      status: 'FAIL',
    });
  });

  it('renders a paper-only operational markdown report', async () => {
    const report = await runPhase21Validation({});
    const markdown = renderMarkdownReport(report);

    expect(markdown).toContain('Phase 21 PAPER Trading Operational Run Report');
    expect(markdown).toContain('Mode: PAPER');
    expect(markdown).toContain('does not validate, add, or enable live trading');
  });
});
