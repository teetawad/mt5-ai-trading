import { Pool } from 'pg';
import { getMt5Bars } from '../mt5-client';
import { loadFastLearningSettings } from '../../config/fast-learning-settings';

// Shadow Trade lifecycle watcher (spec sections 7, 8, 9): monitors pending
// triggers and open shadow positions against subsequent M5 (and, only to
// disambiguate a same-candle TP+SL touch, M1) historical price data. Never
// imports sendMt5Order/sendMt5PendingOrder/checkMt5Order/listMt5Positions —
// only getMt5Bars — so this file structurally cannot place a real MT5 order,
// mirroring ai-trade-plan-watcher.ts's idempotent, status-guarded UPDATE
// pattern but with historical candles standing in for live MT5 state.

interface SimpleBar {
  time: number; // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
}

function toBars(raw: Record<string, unknown>[]): SimpleBar[] {
  return raw
    .map((row) => ({
      time: Number(row.time),
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
    }))
    .filter((bar) => Number.isFinite(bar.time) && Number.isFinite(bar.high) && Number.isFinite(bar.low))
    .sort((a, b) => a.time - b.time);
}

function barsNeededSince(sinceMs: number, timeframeMinutes: number, buffer = 20): number {
  const minutesElapsed = Math.max(0, (Date.now() - sinceMs) / 60_000);
  return Math.min(2000, Math.ceil(minutesElapsed / timeframeMinutes) + buffer);
}

function triggerLevel(row: Record<string, unknown>): number | null {
  const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : null);
  return num(row.trigger_price) ?? num(row.planned_entry)
    ?? (num(row.entry_zone_low) !== null && num(row.entry_zone_high) !== null
      ? (num(row.entry_zone_low)! + num(row.entry_zone_high)!) / 2
      : num(row.entry_zone_high) ?? num(row.entry_zone_low));
}

function isTriggeredByCandle(orderType: string, level: number, bar: SimpleBar): boolean {
  if (orderType === 'BUY_LIMIT' || orderType === 'SELL_STOP') return bar.low <= level;
  if (orderType === 'SELL_LIMIT' || orderType === 'BUY_STOP') return bar.high >= level;
  return false;
}

async function processAwaitingTrigger(pool: Pool, row: Record<string, unknown>): Promise<'expired' | 'triggered' | 'unchanged'> {
  const id = String(row.id);
  const planExpiryMs = new Date(String(row.plan_expiry)).getTime();

  if (planExpiryMs <= Date.now()) {
    const result = await pool.query(
      `UPDATE shadow_trades SET status='EXPIRED_NOT_TRIGGERED', updated_at=now()
       WHERE id=$1 AND status='AWAITING_TRIGGER'`,
      [id],
    );
    return result.rowCount ? 'expired' : 'unchanged';
  }

  const level = triggerLevel(row);
  if (level === null) return 'unchanged';

  const sinceMs = new Date(String(row.created_at)).getTime();
  const count = barsNeededSince(sinceMs, 5);
  const raw = await getMt5Bars(String(row.symbol), 'M5', count).catch(() => null);
  if (!raw) return 'unchanged';
  const bars = toBars(raw).filter((bar) => bar.time * 1000 >= sinceMs);

  for (const bar of bars) {
    if (isTriggeredByCandle(String(row.order_type), level, bar)) {
      const result = await pool.query(
        `UPDATE shadow_trades SET status='ENTERED', actual_shadow_entry=$2, entered_at=$3, updated_at=now()
         WHERE id=$1 AND status='AWAITING_TRIGGER'`,
        [id, level, new Date(bar.time * 1000).toISOString()],
      );
      return result.rowCount ? 'triggered' : 'unchanged';
    }
  }
  return 'unchanged';
}

interface CloseOutcome {
  exitReason: 'TAKE_PROFIT' | 'STOP_LOSS' | 'TIME_EXIT' | 'AMBIGUOUS_OUTCOME';
  exitPrice: number | null;
  closedAtMs: number;
}

// Attempts to disambiguate a single M5 candle where both SL and TP fall
// inside [low, high] by checking finer M1 data for that exact 5-minute
// window (spec section 9: "Use finer available data where practical").
// Returns null (never guessed) when M1 data is unavailable/inconclusive.
async function disambiguateWithM1(
  symbol: string,
  candle: SimpleBar,
  direction: 'BUY' | 'SELL',
  stopLoss: number,
  takeProfit: number,
): Promise<'TAKE_PROFIT' | 'STOP_LOSS' | null> {
  const raw = await getMt5Bars(symbol, 'M1', 400).catch(() => null);
  if (!raw) return null;
  const m1Bars = toBars(raw).filter((bar) => bar.time >= candle.time && bar.time < candle.time + 300);
  if (!m1Bars.length) return null;

  for (const bar of m1Bars) {
    const hitSl = direction === 'BUY' ? bar.low <= stopLoss : bar.high >= stopLoss;
    const hitTp = direction === 'BUY' ? bar.high >= takeProfit : bar.low <= takeProfit;
    if (hitSl && hitTp) return null; // still ambiguous even at M1 resolution
    if (hitSl) return 'STOP_LOSS';
    if (hitTp) return 'TAKE_PROFIT';
  }
  return null; // M1 window didn't actually confirm either touch — never guess.
}

async function evaluateEnteredTrade(pool: Pool, row: Record<string, unknown>, settings: ReturnType<typeof loadFastLearningSettings>): Promise<CloseOutcome | { mfeR: number; maeR: number } | null> {
  const symbol = String(row.symbol);
  const direction = String(row.direction) as 'BUY' | 'SELL';
  const entry = Number(row.actual_shadow_entry);
  const stopLoss = Number(row.stop_loss);
  const takeProfit = Number(row.take_profit);
  const riskPerUnit = Math.abs(entry - stopLoss);
  if (!Number.isFinite(riskPerUnit) || riskPerUnit === 0) return null;

  const enteredMs = new Date(String(row.entered_at)).getTime();
  const deadlineMs = enteredMs + settings.m5_shadow_max_holding_minutes * 60_000;
  const count = barsNeededSince(enteredMs, 5);
  const raw = await getMt5Bars(symbol, 'M5', count).catch(() => null);
  if (!raw) return null;
  const bars = toBars(raw).filter((bar) => bar.time * 1000 >= enteredMs);

  let favorable = entry;
  let adverse = entry;

  for (const bar of bars) {
    favorable = direction === 'BUY' ? Math.max(favorable, bar.high) : Math.min(favorable, bar.low);
    adverse = direction === 'BUY' ? Math.min(adverse, bar.low) : Math.max(adverse, bar.high);

    const hitSl = direction === 'BUY' ? bar.low <= stopLoss : bar.high >= stopLoss;
    const hitTp = direction === 'BUY' ? bar.high >= takeProfit : bar.low <= takeProfit;

    if (hitSl && hitTp) {
      const resolved = await disambiguateWithM1(symbol, bar, direction, stopLoss, takeProfit);
      if (resolved === 'STOP_LOSS') return { exitReason: 'STOP_LOSS', exitPrice: stopLoss, closedAtMs: bar.time * 1000 };
      if (resolved === 'TAKE_PROFIT') return { exitReason: 'TAKE_PROFIT', exitPrice: takeProfit, closedAtMs: bar.time * 1000 };
      return { exitReason: 'AMBIGUOUS_OUTCOME', exitPrice: null, closedAtMs: bar.time * 1000 };
    }
    if (hitSl) return { exitReason: 'STOP_LOSS', exitPrice: stopLoss, closedAtMs: bar.time * 1000 };
    if (hitTp) return { exitReason: 'TAKE_PROFIT', exitPrice: takeProfit, closedAtMs: bar.time * 1000 };

    if (bar.time * 1000 >= deadlineMs) {
      return { exitReason: 'TIME_EXIT', exitPrice: bar.close, closedAtMs: bar.time * 1000 };
    }
  }

  const signedFavorable = direction === 'BUY' ? favorable - entry : entry - favorable;
  const signedAdverse = direction === 'BUY' ? adverse - entry : entry - adverse;
  return { mfeR: signedFavorable / riskPerUnit, maeR: signedAdverse / riskPerUnit };
}

async function processEnteredTrade(pool: Pool, row: Record<string, unknown>, settings: ReturnType<typeof loadFastLearningSettings>): Promise<'closed' | 'unchanged'> {
  const outcome = await evaluateEnteredTrade(pool, row, settings);
  if (!outcome) return 'unchanged';
  const id = String(row.id);

  if ('mfeR' in outcome) {
    await pool.query(`UPDATE shadow_trades SET mfe_r=$2, mae_r=$3, updated_at=now() WHERE id=$1 AND status='ENTERED'`, [id, outcome.mfeR, outcome.maeR]);
    return 'unchanged';
  }

  const entry = Number(row.actual_shadow_entry);
  const direction = String(row.direction) as 'BUY' | 'SELL';
  const stopLoss = Number(row.stop_loss);
  const riskPerUnit = Math.abs(entry - stopLoss);
  const rMultiple = outcome.exitPrice !== null
    ? (direction === 'BUY' ? outcome.exitPrice - entry : entry - outcome.exitPrice) / riskPerUnit
    : null;
  const holdingMinutes = Math.round((outcome.closedAtMs - new Date(String(row.entered_at)).getTime()) / 60_000);

  // net_result_estimate reuses ai_trade_plans.max_planned_loss ($ risked, the
  // same broker-aware Risk Engine economics already computed for the real
  // plan) rather than duplicating contract-size/tick-value math here.
  const planRow = await pool.query('SELECT max_planned_loss FROM ai_trade_plans WHERE id = $1', [row.ai_trade_plan_id]);
  const maxPlannedLoss = Number(planRow.rows[0]?.max_planned_loss);
  const netResultEstimate = rMultiple !== null && Number.isFinite(maxPlannedLoss) ? rMultiple * maxPlannedLoss : null;

  const result = await pool.query(
    `UPDATE shadow_trades
     SET status='CLOSED', exit_reason=$2, actual_shadow_exit=$3, closed_at=$4,
         r_multiple=$5, net_result_estimate=$6, holding_minutes=$7, updated_at=now()
     WHERE id=$1 AND status='ENTERED'`,
    [id, outcome.exitReason, outcome.exitPrice, new Date(outcome.closedAtMs).toISOString(), rMultiple, netResultEstimate, holdingMinutes],
  );
  return result.rowCount ? 'closed' : 'unchanged';
}

export interface ShadowWatcherTickSummary {
  expired: number;
  triggered: number;
  closed: number;
}

export async function runShadowTradeWatcherTick(pool: Pool): Promise<ShadowWatcherTickSummary> {
  const settings = loadFastLearningSettings();
  const summary: ShadowWatcherTickSummary = { expired: 0, triggered: 0, closed: 0 };

  const awaiting = await pool.query(`SELECT * FROM shadow_trades WHERE status='AWAITING_TRIGGER'`);
  for (const row of awaiting.rows) {
    const outcome = await processAwaitingTrigger(pool, row as Record<string, unknown>);
    if (outcome === 'expired') summary.expired += 1;
    else if (outcome === 'triggered') summary.triggered += 1;
  }

  const entered = await pool.query(`SELECT * FROM shadow_trades WHERE status='ENTERED'`);
  for (const row of entered.rows) {
    const outcome = await processEnteredTrade(pool, row as Record<string, unknown>, settings);
    if (outcome === 'closed') summary.closed += 1;
  }

  return summary;
}

export function startShadowTradeWatcher(pool: Pool): void {
  const poll = async () => {
    const settings = loadFastLearningSettings();
    if (!settings.fast_learning_mode_enabled) return;
    try {
      await runShadowTradeWatcherTick(pool);
    } catch (err) {
      console.warn('[shadow-trade-watcher] tick failed:', (err as Error).message);
    }
  };
  const settings = loadFastLearningSettings();
  setInterval(poll, settings.m5_shadow_watcher_interval_ms);
}
