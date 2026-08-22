import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/trading-ai/m5-opportunity-scan', () => ({
  runM5OpportunityScan: vi.fn(),
}));

import { runM5OpportunityScan } from '../services/trading-ai/m5-opportunity-scan';
import {
  currentM5Boundary,
  runM5CycleSchedulerTick,
  resetM5CycleSchedulerStateForTests,
  getM5CycleStatus,
} from '../services/trading-ai/m5-cycle-scheduler';

const FAKE_POOL = {} as never;

describe('currentM5Boundary', () => {
  it('floors to the most recently completed 5-minute wall-clock boundary', () => {
    const t = new Date('2026-08-18T22:07:33Z').getTime();
    expect(new Date(currentM5Boundary(t)).toISOString()).toBe('2026-08-18T22:05:00.000Z');
  });

  it('is exact on a boundary', () => {
    const t = new Date('2026-08-18T22:10:00Z').getTime();
    expect(new Date(currentM5Boundary(t)).toISOString()).toBe('2026-08-18T22:10:00.000Z');
  });
});

describe('runM5CycleSchedulerTick', () => {
  beforeEach(() => {
    resetM5CycleSchedulerStateForTests();
    vi.mocked(runM5OpportunityScan).mockReset();
    vi.mocked(runM5OpportunityScan).mockResolvedValue({
      scanId: 'x',
      summary: {
        m5CandleTimestamp: new Date().toISOString(), symbolsDiscovered: 0, dataValid: 0, aiShortlisted: 0,
        actionable: 0, enterNow: 0, waitForEntry: 0, technicalBlocked: 0, riskPass: 0, riskBlocked: 0,
        openAiRequestsUsed: 0, reusedFromCache: 0, shadowTradesCreated: 0,
        realDemoEligible: 0, shadowLearningOnly: 0, realDemoMinFinalScore: 65, realDemoTopCandidates: 5,
      },
      topOpportunities: [],
      realDemoCandidates: [],
      shadowLearningOnly: [],
      actionable: [],
    });
    delete process.env.FAST_LEARNING_MODE;
  });

  afterEach(() => {
    delete process.env.FAST_LEARNING_MODE;
  });

  it('is a no-op when FAST_LEARNING_MODE is disabled (default)', async () => {
    const outcome = await runM5CycleSchedulerTick(FAKE_POOL);
    expect(outcome).toBe('skipped-disabled');
    expect(runM5OpportunityScan).not.toHaveBeenCalled();
  });

  it('a new completed M5 candle triggers exactly one cycle', async () => {
    process.env.FAST_LEARNING_MODE = 'true';
    const outcome = await runM5CycleSchedulerTick(FAKE_POOL);
    expect(outcome).toBe('ran');
    expect(runM5OpportunityScan).toHaveBeenCalledTimes(1);
    expect(getM5CycleStatus().lastCandleTimestamp).not.toBeNull();
  });

  it('the same M5 candle boundary does not trigger a duplicate cycle', async () => {
    process.env.FAST_LEARNING_MODE = 'true';
    const first = await runM5CycleSchedulerTick(FAKE_POOL);
    const second = await runM5CycleSchedulerTick(FAKE_POOL);
    expect(first).toBe('ran');
    expect(second).toBe('skipped-same-candle');
    expect(runM5OpportunityScan).toHaveBeenCalledTimes(1);
  });
});
