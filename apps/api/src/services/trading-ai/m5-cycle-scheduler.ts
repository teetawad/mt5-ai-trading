import { Pool } from 'pg';
import { loadFastLearningSettings } from '../../config/fast-learning-settings';
import { Mt5Actor } from '../mt5-entry-plan-watcher';
import { runM5OpportunityScan, M5ScanSummary } from './m5-opportunity-scan';

// M5 candle-close trigger (spec section 1): "use every COMPLETED M5 candle
// as a new decision opportunity... trigger analysis once when a new
// completed M5 candle becomes available", not continuously every second.
// M5 candles close on the same wall-clock boundary for every symbol, so a
// single global cadence is sufficient here — per-symbol dedup correctness
// is handled separately, inside runM5OpportunityScan's M5-keyed reuse cache.

const FIVE_MINUTES_MS = 5 * 60_000;

const SYSTEM_ACTOR: Mt5Actor = { actorId: null, actorEmail: 'system:m5-cycle-scheduler', requestId: undefined };

let lastProcessedBoundaryMs: number | null = null;
let lastSummary: M5ScanSummary | null = null;
let lastCycleAt: string | null = null;
let lastError: string | null = null;

export function currentM5Boundary(now: number = Date.now()): number {
  return Math.floor(now / FIVE_MINUTES_MS) * FIVE_MINUTES_MS;
}

export interface M5CycleStatus {
  enabled: boolean;
  lastCycleAt: string | null;
  lastCandleTimestamp: string | null;
  lastSummary: M5ScanSummary | null;
  lastError: string | null;
  nextExpectedAt: string;
}

export function getM5CycleStatus(): M5CycleStatus {
  const settings = loadFastLearningSettings();
  const nextBoundary = currentM5Boundary() + FIVE_MINUTES_MS;
  return {
    enabled: settings.fast_learning_mode_enabled,
    lastCycleAt,
    lastCandleTimestamp: lastProcessedBoundaryMs !== null ? new Date(lastProcessedBoundaryMs).toISOString() : null,
    lastSummary,
    lastError,
    nextExpectedAt: new Date(nextBoundary).toISOString(),
  };
}

// Runs one M5 cycle immediately regardless of the boundary check — used by
// the manual `ai:m5-cycle` dev command (spec section 23) and by the poll
// loop once a genuinely new boundary is detected.
export async function runOneM5Cycle(pool: Pool, boundaryMs: number = currentM5Boundary()): Promise<M5ScanSummary> {
  const m5CandleTimestamp = new Date(boundaryMs).toISOString();
  const result = await runM5OpportunityScan(pool, SYSTEM_ACTOR, m5CandleTimestamp);
  lastProcessedBoundaryMs = boundaryMs;
  lastSummary = result.summary;
  lastCycleAt = new Date().toISOString();
  lastError = null;
  return result.summary;
}

// Exported separately from the setInterval wrapper so a test can drive
// exactly one poll tick deterministically (spec section 22: "new M5 candle
// triggers one cycle" / "same M5 candle does not duplicate analysis").
export async function runM5CycleSchedulerTick(pool: Pool): Promise<'skipped-disabled' | 'skipped-same-candle' | 'ran'> {
  const settings = loadFastLearningSettings();
  if (!settings.fast_learning_mode_enabled) return 'skipped-disabled';

  const boundary = currentM5Boundary();
  if (boundary === lastProcessedBoundaryMs) return 'skipped-same-candle'; // no new completed M5 candle yet

  try {
    const summary = await runOneM5Cycle(pool, boundary);
    console.log(`[m5-cycle-scheduler] cycle for candle ${new Date(boundary).toISOString()}: ${summary.aiShortlisted} shortlisted, ${summary.actionable} actionable, ${summary.shadowTradesCreated} shadow trades created`);
  } catch (err) {
    lastError = (err as Error).message;
    console.warn('[m5-cycle-scheduler] cycle failed:', lastError);
  }
  return 'ran';
}

// Test-only reset of this module's in-memory cadence state (there is no
// production caller — the process simply restarts to clear it).
export function resetM5CycleSchedulerStateForTests(): void {
  lastProcessedBoundaryMs = null;
  lastSummary = null;
  lastCycleAt = null;
  lastError = null;
}

export function startM5CycleScheduler(pool: Pool): void {
  const settings = loadFastLearningSettings();
  setInterval(() => {
    void runM5CycleSchedulerTick(pool);
  }, settings.m5_cycle_poll_interval_ms);
}
