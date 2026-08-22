import { Pool } from 'pg';
import { FinalQualitySettings } from '../../config/final-quality-settings';
import { SHADOW_NOT_DOUBLE_COUNTED_CLAUSE } from './real-demo-learning';

// Deterministic historical performance feedback (owner spec sections 5-9,
// 27): "AI plan -> Shadow/Real Demo -> Outcome -> Performance statistics ->
// Historical performance adjustment -> Future Final Quality Score". Every
// number here comes straight from completed shadow_trades (simulated, never
// order_send) and trade_outcomes (real, MT5-confirmed) rows — never
// fabricated, and never claimed as statistically certain regardless of
// sample size (spec: "Do not fabricate statistical certainty").

export interface PerformanceBucketStats {
  sampleCount: number;
  wins: number;
  losses: number;
  winRate: number;
  averageR: number | null;
  profitFactor: number | null;
  netPnl: number | null;
  averageMfeR: number | null;
  averageMaeR: number | null;
  averageHoldingMinutes: number | null;
}

const EMPTY_STATS: PerformanceBucketStats = {
  sampleCount: 0, wins: 0, losses: 0, winRate: 0, averageR: null, profitFactor: null,
  netPnl: null, averageMfeR: null, averageMaeR: null, averageHoldingMinutes: null,
};

function num(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function aggregate(rMultiples: number[], netValues: number[], mfeValues: number[], maeValues: number[], holdingMinutes: number[], wins: number, losses: number): PerformanceBucketStats {
  const sampleCount = wins + losses;
  const grossProfit = netValues.filter((v) => v > 0).reduce((s, v) => s + v, 0);
  const grossLoss = Math.abs(netValues.filter((v) => v < 0).reduce((s, v) => s + v, 0));
  return {
    sampleCount,
    wins,
    losses,
    winRate: sampleCount > 0 ? wins / sampleCount : 0,
    averageR: rMultiples.length ? rMultiples.reduce((s, v) => s + v, 0) / rMultiples.length : null,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Number.POSITIVE_INFINITY : null),
    netPnl: netValues.length ? netValues.reduce((s, v) => s + v, 0) : null,
    averageMfeR: mfeValues.length ? mfeValues.reduce((s, v) => s + v, 0) / mfeValues.length : null,
    averageMaeR: maeValues.length ? maeValues.reduce((s, v) => s + v, 0) / maeValues.length : null,
    averageHoldingMinutes: holdingMinutes.length ? holdingMinutes.reduce((s, v) => s + v, 0) / holdingMinutes.length : null,
  };
}

// Symbol-level performance bucket (spec section 9: "XAUUSD: Average R +0.24,
// Profit Factor 1.40" — a symbol+direction match, not narrowed further by
// entry type). Pools SHADOW (shadow_trades) and REAL_DEMO (trade_outcomes)
// into one bucket — both are already risk-normalized to R-multiples, so
// pooling them is meaningful (same convention as
// fast-learning-dashboard.ts's CombinedEvaluation).
export async function getSymbolDirectionPerformance(pool: Pool, symbol: string, direction: 'BUY' | 'SELL'): Promise<PerformanceBucketStats> {
  const [shadowResult, realResult] = await Promise.all([
    pool.query(
      `SELECT exit_reason, r_multiple, net_result_estimate, mfe_r, mae_r, holding_minutes
       FROM shadow_trades
       WHERE symbol = $1 AND direction = $2 AND status = 'CLOSED' AND ${SHADOW_NOT_DOUBLE_COUNTED_CLAUSE}`,
      [symbol, direction],
    ),
    pool.query(
      `SELECT t.realized_pnl, t.risk_amount, t.exit_reason, t.opened_at, t.closed_at
       FROM trade_outcomes t
       WHERE t.symbol = $1 AND t.side = $2
         AND t.closed_at IS NOT NULL AND t.exit_reason IS DISTINCT FROM 'RECONCILIATION_FAILED'`,
      [symbol, direction],
    ),
  ]);

  const rMultiples: number[] = [];
  const netValues: number[] = [];
  const mfeValues: number[] = [];
  const maeValues: number[] = [];
  const holdingMinutes: number[] = [];
  let wins = 0;
  let losses = 0;

  for (const row of shadowResult.rows as Array<Record<string, unknown>>) {
    if (row.exit_reason === 'TAKE_PROFIT') wins += 1;
    else if (row.exit_reason === 'STOP_LOSS') losses += 1;
    else continue; // TIME_EXIT/AMBIGUOUS_OUTCOME are completed samples but not a clean win/loss for this bucket's decided count
    const r = num(row.r_multiple);
    const net = num(row.net_result_estimate);
    if (r !== null) rMultiples.push(r);
    if (net !== null) netValues.push(net);
    const mfe = num(row.mfe_r);
    const mae = num(row.mae_r);
    if (mfe !== null) mfeValues.push(mfe);
    if (mae !== null) maeValues.push(mae);
    const hold = num(row.holding_minutes);
    if (hold !== null) holdingMinutes.push(hold);
  }

  for (const row of realResult.rows as Array<Record<string, unknown>>) {
    const pnl = num(row.realized_pnl);
    const riskAmount = num(row.risk_amount);
    if (pnl === null) continue;
    if (pnl > 0) wins += 1;
    else if (pnl < 0) losses += 1;
    else continue; // breakeven: not decided, excluded from win/loss like the dashboard's own convention
    netValues.push(pnl);
    if (riskAmount !== null && riskAmount > 0) rMultiples.push(pnl / riskAmount);
    const openedAt = row.opened_at ? new Date(String(row.opened_at)).getTime() : null;
    const closedAt = row.closed_at ? new Date(String(row.closed_at)).getTime() : null;
    if (openedAt !== null && closedAt !== null && Number.isFinite(openedAt) && Number.isFinite(closedAt)) {
      holdingMinutes.push((closedAt - openedAt) / 60000);
    }
  }

  if (wins + losses === 0) return EMPTY_STATS;
  return aggregate(rMultiples, netValues, mfeValues, maeValues, holdingMinutes, wins, losses);
}

// Historical influence ramps linearly from 0 (below historical_min_samples)
// to 1 (at/above historical_full_weight_samples) — spec section 6: "Do not
// overreact to small data."
export function historicalInfluenceFactor(sampleCount: number, settings: Pick<FinalQualitySettings, 'historical_min_samples' | 'historical_full_weight_samples'>): number {
  const { historical_min_samples: min, historical_full_weight_samples: full } = settings;
  if (sampleCount < min) return 0;
  if (sampleCount >= full) return 1;
  if (full <= min) return 1;
  return (sampleCount - min) / (full - min);
}

// Historical Performance Score (spec section 7): 0-100, weighted toward
// expectancy metrics (average R, profit factor) over raw win rate — "a setup
// family can have a lower win rate and still be profitable if R:R is good."
export function historicalPerformanceScoreFor(stats: PerformanceBucketStats): number {
  if (stats.sampleCount === 0) return 50; // neutral — no evidence either way
  const rScore = stats.averageR !== null ? Math.max(0, Math.min(100, 50 + stats.averageR * 50)) : 50;
  const pfScore = stats.profitFactor !== null
    ? Math.max(0, Math.min(100, 50 + (Math.min(stats.profitFactor, 5) - 1) * 25))
    : 50;
  const wrScore = Math.max(0, Math.min(100, stats.winRate * 100));
  return Math.round(0.5 * rScore + 0.3 * pfScore + 0.2 * wrScore);
}

export interface HistoricalPerformanceResult {
  score: number; // 0-100
  sampleCount: number;
  influenceFactor: number; // 0-1, how much this score should actually count
  stats: PerformanceBucketStats;
}

export async function computeHistoricalPerformance(
  pool: Pool,
  symbol: string,
  direction: 'BUY' | 'SELL',
  settings: FinalQualitySettings,
): Promise<HistoricalPerformanceResult> {
  const stats = await getSymbolDirectionPerformance(pool, symbol, direction);
  return {
    score: historicalPerformanceScoreFor(stats),
    sampleCount: stats.sampleCount,
    influenceFactor: historicalInfluenceFactor(stats.sampleCount, settings),
    stats,
  };
}

// Recent Loss Guard (spec section 8, REAL DEMO eligibility only): a
// temporary score penalty when the same symbol+direction+entry_type family's
// most recent completed outcomes are all losses. Never a permanent ban —
// recovers immediately the next time that family produces a non-loss (spec:
// "allow the penalty to decay or recover after better results"). Pools
// SHADOW + REAL_DEMO completed outcomes, ordered by completion time, since a
// fast-learning Shadow Trade closes far sooner than waiting for enough real
// DEMO samples and is the whole point of collecting it.
export interface RecentLossGuardResult {
  adjustment: number; // <= 0
  consecutiveLosses: number;
  reason: string | null;
}

interface RecentOutcome {
  isLoss: boolean;
  closedAtMs: number;
}

export async function getRecentLossGuard(
  pool: Pool,
  symbol: string,
  direction: 'BUY' | 'SELL',
  entryType: string,
  settings: FinalQualitySettings,
  lookback = 10,
): Promise<RecentLossGuardResult> {
  const [shadowResult, realResult] = await Promise.all([
    pool.query(
      // SHADOW_NOT_DOUBLE_COUNTED_CLAUSE references the unaliased
      // shadow_trades table name, so this query deliberately does not alias
      // it (unlike ai_trade_plans, aliased p).
      `SELECT shadow_trades.exit_reason, shadow_trades.closed_at
       FROM shadow_trades
       JOIN ai_trade_plans p ON p.id = shadow_trades.ai_trade_plan_id
       WHERE shadow_trades.symbol = $1 AND shadow_trades.direction = $2 AND p.entry_type = $3
         AND shadow_trades.status = 'CLOSED' AND shadow_trades.exit_reason IN ('TAKE_PROFIT','STOP_LOSS')
         AND ${SHADOW_NOT_DOUBLE_COUNTED_CLAUSE}
       ORDER BY shadow_trades.closed_at DESC LIMIT $4`,
      [symbol, direction, entryType, lookback],
    ),
    pool.query(
      `SELECT t.realized_pnl, t.closed_at
       FROM trade_outcomes t
       JOIN ai_trade_plans p ON p.id = t.ai_trade_plan_id
       WHERE t.symbol = $1 AND t.side = $2 AND p.entry_type = $3
         AND t.closed_at IS NOT NULL AND t.exit_reason IS DISTINCT FROM 'RECONCILIATION_FAILED'
         AND t.realized_pnl IS NOT NULL AND t.realized_pnl != 0
       ORDER BY t.closed_at DESC LIMIT $4`,
      [symbol, direction, entryType, lookback],
    ),
  ]);

  const outcomes: RecentOutcome[] = [
    ...(shadowResult.rows as Array<Record<string, unknown>>).map((row) => ({
      isLoss: row.exit_reason === 'STOP_LOSS',
      closedAtMs: new Date(String(row.closed_at)).getTime(),
    })),
    ...(realResult.rows as Array<Record<string, unknown>>).map((row) => ({
      isLoss: Number(row.realized_pnl) < 0,
      closedAtMs: new Date(String(row.closed_at)).getTime(),
    })),
  ].sort((a, b) => b.closedAtMs - a.closedAtMs);

  let consecutiveLosses = 0;
  for (const outcome of outcomes) {
    if (outcome.isLoss) consecutiveLosses += 1;
    else break; // streak broken by a non-loss — immediate recovery, no partial penalty
  }

  if (consecutiveLosses >= settings.recent_loss_streak_threshold) {
    return {
      adjustment: -Math.abs(settings.recent_loss_penalty_points),
      consecutiveLosses,
      reason: `Recent ${symbol} ${direction} ${entryType} setups have ${consecutiveLosses} consecutive losses.`,
    };
  }
  return { adjustment: 0, consecutiveLosses, reason: null };
}
