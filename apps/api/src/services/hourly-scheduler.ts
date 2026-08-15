/**
 * Phase 27 hourly scheduler — the server-side "Hourly Scanner" that detects
 * a newly closed 1H candle per watchlist symbol and evaluates it exactly
 * once, with no browser required (CLAUDE.md: "Browser must NOT be required
 * for scanning. API + Trading Engine must perform the hourly workflow.").
 *
 * This is genuinely new infrastructure — no scheduler existed anywhere in
 * this codebase before Phase 27 (see planning/DESIGN_DECISIONS.md DD-004,
 * which deliberately deferred one). It is deliberately simple: a plain
 * `setInterval` tick, not a queue or cron library, because the actual
 * "exactly once per candle" guarantee lives entirely in the database (the
 * `hourly_candle_processing` UNIQUE(symbol, candle_timestamp) claim — see
 * db/repositories/hourly-candle-processing.ts), not in scheduler memory or
 * timing. That's what makes this restart-safe: a fresh process, on its
 * first tick, asks Alpaca for the latest closed bar and asks the database
 * whether that bar has already been claimed — exactly the same question it
 * asks on every other tick.
 *
 * Detection uses the already-existing historical-bars endpoint
 * (getHistoricalBars) rather than hand-computing market-hour-aligned
 * boundaries — Alpaca already knows when a 1H bar has closed, so the
 * scheduler just asks for the latest one and compares its timestamp to
 * what's already claimed.
 */

import { Pool } from 'pg';
import {
  claimCandle,
  findLastProcessedCandle,
  markCandleAnalyzed,
  markCandleError,
} from '../db/repositories/hourly-candle-processing';
import { findEnabledWatchlistSymbols } from '../db/repositories/hourly-watchlist';
import { loadPhase27Settings } from './hourly-decision-service';
import { createHourlyDecisionAndProposal, ActorContext } from './trade-proposal-service';
import { getHistoricalBars } from './trading-engine-client';

export const SYSTEM_HOURLY_SCHEDULER_ACTOR: ActorContext = {
  actorId: null,
  actorEmail: 'system-hourly-scheduler@internal',
};

const HOURLY_TIMEFRAME = '1Hour';
const ONE_HOUR_MS = 3_600_000;

export interface HourlyTickResult {
  symbolsChecked: number;
  candlesClaimed: number;
  signalsCreated: number;
  errors: number;
}

function lookbackStart(): string {
  return new Date(Date.now() - 6 * ONE_HOUR_MS).toISOString();
}

/**
 * One scheduler pass: for each enabled watchlist symbol, detect whether a
 * newly closed 1H candle exists and, if so, claim and analyze it exactly
 * once. Never throws — one symbol's failure (a flaky Alpaca call, a bad
 * analysis) must never block the others or crash the interval timer, same
 * defensive contract as reconcileBracketOrders/reconcileIntradayTimeExits.
 */
export async function tick(pool: Pool): Promise<HourlyTickResult> {
  const result: HourlyTickResult = {
    symbolsChecked: 0,
    candlesClaimed: 0,
    signalsCreated: 0,
    errors: 0,
  };

  const settings = await loadPhase27Settings(pool).catch(() => null);
  if (!settings || !settings.hourlyModeEnabled) return result;

  let symbols: string[];
  try {
    symbols = await findEnabledWatchlistSymbols(pool);
  } catch {
    return result;
  }
  if (symbols.length === 0) return result;

  const now = Date.now();

  for (const symbol of symbols) {
    result.symbolsChecked += 1;
    try {
      const bars = await getHistoricalBars(symbol, {
        timeframe: HOURLY_TIMEFRAME,
        start: lookbackStart(),
        limit: 1,
      });
      const latestBar = bars[bars.length - 1];
      if (!latestBar) continue;

      const candleOpen = new Date(latestBar.timestamp);
      const candleClose = candleOpen.getTime() + ONE_HOUR_MS;
      // Defensive: never act on a still-forming candle, even if a provider
      // were to return one — mirrors the Python no-look-ahead guard.
      if (candleClose > now) continue;

      const lastProcessed = await findLastProcessedCandle(pool, symbol);
      if (lastProcessed && lastProcessed.getTime() >= candleOpen.getTime()) continue;

      const claim = await claimCandle(pool, symbol, candleOpen);
      if (!claim) continue; // lost the race, or already processed before a restart
      result.candlesClaimed += 1;

      try {
        const outcome = await createHourlyDecisionAndProposal(
          pool,
          { symbol },
          SYSTEM_HOURLY_SCHEDULER_ACTOR,
        );
        await markCandleAnalyzed(pool, claim.id, outcome.signal?.id ?? null);
        if (outcome.proposal) result.signalsCreated += 1;
      } catch (err) {
        await markCandleError(pool, claim.id, (err as Error).message ?? 'unknown error');
        result.errors += 1;
      }
    } catch {
      result.errors += 1;
    }
  }

  return result;
}

export interface HourlySchedulerHandle {
  stop(): void;
}

function schedulerEnabled(): boolean {
  return (process.env.HOURLY_SCHEDULER_ENABLED ?? 'true').trim().toLowerCase() !== 'false';
}

function tickIntervalMs(): number {
  const raw = Number(process.env.HOURLY_SCHEDULER_TICK_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
}

/** Starts the interval timer. Only ever called from index.ts (the real
 * server process) — never from app.ts, which is what apps/api's test suite
 * imports, so the scheduler never runs during `npm test`. */
export function startHourlyScheduler(pool: Pool): HourlySchedulerHandle {
  if (!schedulerEnabled()) {
    return { stop: () => {} };
  }
  const intervalMs = tickIntervalMs();
  const handle = setInterval(() => {
    tick(pool).catch((err) => {
      console.error('[hourly-scheduler] tick failed (non-fatal):', err);
    });
  }, intervalMs);
  console.log(`[hourly-scheduler] started, tick every ${intervalMs}ms`);
  return {
    stop: () => clearInterval(handle),
  };
}
