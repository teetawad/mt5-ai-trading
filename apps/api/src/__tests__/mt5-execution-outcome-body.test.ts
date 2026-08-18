import { describe, expect, it } from 'vitest';
import { buildExecutionOutcomeBody } from '../routes/mt5';

// The exact frontend contract for "Trade in Demo": mt5Confirmed must only
// ever be true when the backend already confirmed a real MT5 position via
// positions_get() (see executeClaimedPlan) - never derived from a DB insert
// or a 2xx HTTP status alone.
describe('buildExecutionOutcomeBody', () => {
  it('a successful execution reports success/mt5Confirmed=true and the real MT5 ticket/deal/volume/prices', () => {
    const body = buildExecutionOutcomeBody({
      executed: true,
      allowed: true,
      code: null,
      entryPlan: {
        symbol: 'LTCUSD',
        side: 'SELL',
        order_ticket: '472240870',
        deal_ticket: '363507775',
        final_volume: '0.01000000',
        actual_entry: '43.79',
        stop_loss: '45.29',
        take_profit: '42.29',
        opened_at: '2026-08-17T08:25:47.846Z',
      },
    });
    expect(body.success).toBe(true);
    expect(body.mt5Confirmed).toBe(true);
    expect(body.symbol).toBe('LTCUSD');
    expect(body.side).toBe('SELL');
    expect(body.ticket).toBe('472240870');
    expect(body.orderTicket).toBe('472240870');
    expect(body.dealTicket).toBe('363507775');
    expect(body.volume).toBe('0.01000000');
    expect(body.actualEntry).toBe('43.79');
    expect(body.stopLoss).toBe('45.29');
    expect(body.takeProfit).toBe('42.29');
    expect(body.openedAt).toBe('2026-08-17T08:25:47.846Z');
    expect(body.code).toBeNull();
  });

  it('a blocked execution reports success/mt5Confirmed=false with the exact code, message, and diagnostic details — never a bare "Risk Engine rejected"', () => {
    const body = buildExecutionOutcomeBody({
      executed: false,
      allowed: false,
      code: 'SPREAD_TOO_HIGH',
      reason: 'Spread is currently above your configured maximum.',
      entryPlan: { symbol: 'LTCUSD', side: 'SELL', status: 'BLOCKED', block_reason: 'SPREAD_TOO_HIGH' },
      risk: { result: 'REJECT', failedRules: ['SPREAD_TOO_HIGH'] },
    });
    expect(body.success).toBe(false);
    expect(body.mt5Confirmed).toBe(false);
    expect(body.code).toBe('SPREAD_TOO_HIGH');
    expect(body.message).toBe('Spread is currently above your configured maximum.');
    expect(body.message).not.toBe('Risk Engine rejected');
    expect(body.symbol).toBe('LTCUSD');
    expect(body.side).toBe('SELL');
    expect((body.details as Record<string, unknown>).risk).toEqual({ result: 'REJECT', failedRules: ['SPREAD_TOO_HIGH'] });
    // Never present on a failed outcome - a caller must not be able to read
    // a stale/undefined ticket and mistake it for a real one.
    expect(body.ticket).toBeUndefined();
  });

  it('never reports mt5Confirmed=true unless executed is literally true (not just "not explicitly false")', () => {
    const body = buildExecutionOutcomeBody({ executed: undefined, code: 'ORDER_CHECK_FAILED', reason: 'MT5 rejected the request' });
    expect(body.success).toBe(false);
    expect(body.mt5Confirmed).toBe(false);
  });
});
