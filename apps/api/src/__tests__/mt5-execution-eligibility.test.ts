import { describe, expect, it } from 'vitest';
import { describeUnclaimablePlan } from '../services/mt5-entry-plan-watcher';

// Regression coverage for the ALREADY_PROCESSING bug: a second/duplicate
// request for a plan that is already mid-flight or already resolved must
// return the real, specific reason — never a generic "ALREADY_PROCESSING" —
// and an already-EXECUTED plan must hand back its real MT5 ticket.
describe('describeUnclaimablePlan', () => {
  it('EXECUTING -> EXECUTION_IN_PROGRESS, not a generic rejection', () => {
    const { code, reason } = describeUnclaimablePlan({ status: 'EXECUTING' });
    expect(code).toBe('EXECUTION_IN_PROGRESS');
    expect(reason).toMatch(/already being executed/i);
  });

  it('EXECUTED -> ALREADY_EXECUTED and includes the real MT5 ticket in the message', () => {
    const { code, reason } = describeUnclaimablePlan({ status: 'EXECUTED', order_ticket: '472240870' });
    expect(code).toBe('ALREADY_EXECUTED');
    expect(reason).toContain('472240870');
  });

  it('EXECUTED without a ticket still returns ALREADY_EXECUTED with a sensible message', () => {
    const { code, reason } = describeUnclaimablePlan({ status: 'EXECUTED' });
    expect(code).toBe('ALREADY_EXECUTED');
    expect(reason).toMatch(/already executed/i);
  });

  it('EXPIRED -> PLAN_EXPIRED', () => {
    expect(describeUnclaimablePlan({ status: 'EXPIRED' }).code).toBe('PLAN_EXPIRED');
  });

  it('CANCELLED -> PLAN_CANCELLED', () => {
    expect(describeUnclaimablePlan({ status: 'CANCELLED' }).code).toBe('PLAN_CANCELLED');
  });

  it('BLOCKED -> the real block_reason code, not a generic one', () => {
    expect(describeUnclaimablePlan({ status: 'BLOCKED', block_reason: 'SPREAD_TOO_HIGH' }).code).toBe('SPREAD_TOO_HIGH');
  });

  it('WAITING -> WAITING_ENTRY', () => {
    expect(describeUnclaimablePlan({ status: 'WAITING' }).code).toBe('WAITING_ENTRY');
  });

  it('a genuinely unknown/missing row falls back to ALREADY_PROCESSING as a last resort only', () => {
    expect(describeUnclaimablePlan(undefined).code).toBe('ALREADY_PROCESSING');
  });
});
