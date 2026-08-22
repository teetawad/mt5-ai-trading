import { Pool } from 'pg';
import { loadFinalQualitySettings } from '../../config/final-quality-settings';
import {
  countRealDemoCompleted,
  listRealDemoLearningOutcomes,
  RealDemoOutcomeSummary,
  SHADOW_NOT_DOUBLE_COUNTED_CLAUSE,
  summarizeRealDemoOutcomes,
} from './real-demo-learning';

// M5 Fast Learning Dashboard. Combines BOTH learning-source types for AI
// evaluation / a future ML dataset — SHADOW (shadow_trades, simulated, never
// order_send) and REAL_DEMO (trade_outcomes, actual MT5-confirmed trades,
// same rows History already shows) — while keeping every stat clearly
// labeled by source. The two are never merged into one query: every SQL
// statement below reads exactly one of shadow_trades or (via
// real-demo-learning.ts) trade_outcomes, and any place both counts appear
// together is a plain post-query sum, never a JOIN, so a Shadow row can never
// silently become a REAL_DEMO row or vice versa. Where a shadow_trades row's
// own ai_trade_plan_id was ALSO later approved to a real MT5 order (nothing
// prevents an M5-cycle-generated plan from being manually approved
// afterwards), SHADOW_NOT_DOUBLE_COUNTED_CLAUSE excludes it from every
// Shadow aggregate here — the real outcome is ground truth and is the one
// that counts once both exist for the same plan.

export interface FastLearningDailySummary {
  m5Decisions: number;
  shadowSetups: number;
  // "Completed" bookkeeping, kept structurally separate per source (spec:
  // "Never label a real MT5 trade as a Shadow Trade").
  shadowCompleted: number;
  realDemoCompleted: number;
  triggered: number;
  expired: number;
  // Shadow wins/losses/ambiguous (unchanged field names — SHADOW only).
  wins: number;
  losses: number;
  ambiguous: number;
  winRate: number;
  averageR: number | null;
  profitFactor: number | null;
  averageMfeR: number | null;
  averageMaeR: number | null;
  // Real Demo wins/losses/win rate (own field names — REAL_DEMO only).
  realDemoWins: number;
  realDemoLosses: number;
  realDemoWinRate: number;
}

export async function getFastLearningDailySummary(pool: Pool): Promise<FastLearningDailySummary> {
  const todayStart = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z');

  const [decisionsResult, shadowResult, realDemoOutcomesToday] = await Promise.all([
    pool.query(`SELECT count(*)::int AS n FROM ai_analysis_runs WHERE trigger_source='M5_CYCLE' AND created_at >= date_trunc('day', now())`),
    pool.query(
      `SELECT status, exit_reason, r_multiple, net_result_estimate, mfe_r, mae_r
       FROM shadow_trades WHERE created_at >= date_trunc('day', now()) AND ${SHADOW_NOT_DOUBLE_COUNTED_CLAUSE}`,
    ),
    listRealDemoLearningOutcomes(pool, { since: todayStart }),
  ]);

  const rows = shadowResult.rows as Array<Record<string, unknown>>;
  const triggered = rows.filter((r) => r.status === 'ENTERED' || r.status === 'CLOSED').length;
  const expired = rows.filter((r) => r.status === 'EXPIRED_NOT_TRIGGERED').length;
  const closed = rows.filter((r) => r.status === 'CLOSED');
  const wins = closed.filter((r) => r.exit_reason === 'TAKE_PROFIT');
  const losses = closed.filter((r) => r.exit_reason === 'STOP_LOSS');
  const ambiguous = closed.filter((r) => r.exit_reason === 'AMBIGUOUS_OUTCOME').length;
  const decided = wins.length + losses.length;

  const rMultiples = closed
    .map((r) => (r.r_multiple !== null ? Number(r.r_multiple) : null))
    .filter((v): v is number => v !== null && Number.isFinite(v));
  const netResults = closed
    .map((r) => (r.net_result_estimate !== null ? Number(r.net_result_estimate) : null))
    .filter((v): v is number => v !== null && Number.isFinite(v));
  const grossProfit = netResults.filter((v) => v > 0).reduce((sum, v) => sum + v, 0);
  const grossLoss = Math.abs(netResults.filter((v) => v < 0).reduce((sum, v) => sum + v, 0));
  const mfeValues = rows.map((r) => (r.mfe_r !== null ? Number(r.mfe_r) : null)).filter((v): v is number => v !== null && Number.isFinite(v));
  const maeValues = rows.map((r) => (r.mae_r !== null ? Number(r.mae_r) : null)).filter((v): v is number => v !== null && Number.isFinite(v));

  const realDemoToday = summarizeRealDemoOutcomes(realDemoOutcomesToday);

  return {
    m5Decisions: Number(decisionsResult.rows[0]?.n ?? 0),
    shadowSetups: rows.length,
    shadowCompleted: wins.length + losses.length + ambiguous,
    realDemoCompleted: realDemoToday.samples,
    triggered,
    expired,
    wins: wins.length,
    losses: losses.length,
    ambiguous,
    winRate: decided > 0 ? wins.length / decided : 0,
    averageR: rMultiples.length ? rMultiples.reduce((s, v) => s + v, 0) / rMultiples.length : null,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    averageMfeR: mfeValues.length ? mfeValues.reduce((s, v) => s + v, 0) / mfeValues.length : null,
    averageMaeR: maeValues.length ? maeValues.reduce((s, v) => s + v, 0) / maeValues.length : null,
    realDemoWins: realDemoToday.wins,
    realDemoLosses: realDemoToday.losses,
    realDemoWinRate: realDemoToday.winRate,
  };
}

const SCORE_BUCKETS = [
  { label: '85-100', min: 85, max: 100 },
  { label: '70-84', min: 70, max: 84 },
  { label: '50-69', min: 50, max: 69 },
  { label: '30-49', min: 30, max: 49 },
  { label: '0-29', min: 0, max: 29 },
] as const;

export interface ScoreBucketRow {
  bucket: string;
  samples: number;
  triggered: number;
  winRate: number;
  averageR: number | null;
  profitFactor: number | null;
}

export type ScoreBucketField = 'profitability_score' | 'tradeability_pct';

export async function getFastLearningScoreBuckets(pool: Pool, field: ScoreBucketField): Promise<ScoreBucketRow[]> {
  const result = await pool.query(`SELECT ${field} AS score, status, exit_reason, r_multiple, net_result_estimate FROM shadow_trades WHERE ${SHADOW_NOT_DOUBLE_COUNTED_CLAUSE}`);
  const rows = result.rows as Array<Record<string, unknown>>;

  return SCORE_BUCKETS.map(({ label, min, max }) => {
    const inBucket = rows.filter((row) => {
      const score = Number(row.score);
      return Number.isFinite(score) && score >= min && score <= max;
    });
    const triggered = inBucket.filter((r) => r.status === 'ENTERED' || r.status === 'CLOSED').length;
    const closed = inBucket.filter((r) => r.status === 'CLOSED');
    const wins = closed.filter((r) => r.exit_reason === 'TAKE_PROFIT');
    const losses = closed.filter((r) => r.exit_reason === 'STOP_LOSS');
    const decided = wins.length + losses.length;
    const rMultiples = closed.map((r) => (r.r_multiple !== null ? Number(r.r_multiple) : null)).filter((v): v is number => v !== null && Number.isFinite(v));
    const netResults = closed.map((r) => (r.net_result_estimate !== null ? Number(r.net_result_estimate) : null)).filter((v): v is number => v !== null && Number.isFinite(v));
    const grossProfit = netResults.filter((v) => v > 0).reduce((s, v) => s + v, 0);
    const grossLoss = Math.abs(netResults.filter((v) => v < 0).reduce((s, v) => s + v, 0));

    return {
      bucket: label,
      samples: inBucket.length,
      triggered,
      winRate: decided > 0 ? wins.length / decided : 0,
      averageR: rMultiples.length ? rMultiples.reduce((s, v) => s + v, 0) / rMultiples.length : null,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    };
  });
}

export interface ShadowAllTimeSummary {
  samples: number;
  wins: number;
  losses: number;
  winRate: number;
  averageR: number | null;
  profitFactor: number | null;
}

export interface CombinedEvaluation {
  totalCompletedSamples: number;
  // Pooled wins/(wins+losses) across both sources — always meaningful since
  // both are plain, dimensionless win/loss counts.
  combinedWinRate: number | null;
  // Pooled average R-multiple — meaningful because both r_multiple (shadow)
  // and netPnl/riskAmount (real demo, see real-demo-learning.ts) are already
  // risk-normalized to the same dimensionless unit.
  combinedAverageR: number | null;
  // Deliberately no combined profit factor: shadow's net_result_estimate is
  // a simulated dollar estimate and real demo's realized_pnl is actual
  // account currency — summing them into one $ figure would misrepresent
  // both, so profit factor is only ever reported per-source (spec: "only
  // where mathematically meaningful").
}

export interface FastLearningAllTimeSummary {
  shadow: ShadowAllTimeSummary;
  realDemo: RealDemoOutcomeSummary;
  combined: CombinedEvaluation;
}

export async function getFastLearningAllTimeSummary(pool: Pool): Promise<FastLearningAllTimeSummary> {
  const [shadowResult, realDemoOutcomes] = await Promise.all([
    pool.query(`SELECT status, exit_reason, r_multiple, net_result_estimate FROM shadow_trades WHERE ${SHADOW_NOT_DOUBLE_COUNTED_CLAUSE}`),
    listRealDemoLearningOutcomes(pool, {}),
  ]);

  const rows = shadowResult.rows as Array<Record<string, unknown>>;
  const closed = rows.filter((r) => r.status === 'CLOSED');
  const wins = closed.filter((r) => r.exit_reason === 'TAKE_PROFIT');
  const losses = closed.filter((r) => r.exit_reason === 'STOP_LOSS');
  const decided = wins.length + losses.length;
  const rMultiples = closed.map((r) => (r.r_multiple !== null ? Number(r.r_multiple) : null)).filter((v): v is number => v !== null && Number.isFinite(v));
  const netResults = closed.map((r) => (r.net_result_estimate !== null ? Number(r.net_result_estimate) : null)).filter((v): v is number => v !== null && Number.isFinite(v));
  const grossProfit = netResults.filter((v) => v > 0).reduce((s, v) => s + v, 0);
  const grossLoss = Math.abs(netResults.filter((v) => v < 0).reduce((s, v) => s + v, 0));

  const shadow: ShadowAllTimeSummary = {
    samples: wins.length + losses.length,
    wins: wins.length,
    losses: losses.length,
    winRate: decided > 0 ? wins.length / decided : 0,
    averageR: rMultiples.length ? rMultiples.reduce((s, v) => s + v, 0) / rMultiples.length : null,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
  };

  const realDemo = summarizeRealDemoOutcomes(realDemoOutcomes);

  const combinedWins = shadow.wins + realDemo.wins;
  const combinedLosses = shadow.losses + realDemo.losses;
  const combinedDecided = combinedWins + combinedLosses;
  const combinedRValues = [
    ...rMultiples,
    ...realDemoOutcomes.map((o) => o.rMultiple).filter((v): v is number => v !== null && Number.isFinite(v)),
  ];

  const combined: CombinedEvaluation = {
    totalCompletedSamples: shadow.samples + realDemo.samples,
    combinedWinRate: combinedDecided > 0 ? combinedWins / combinedDecided : null,
    combinedAverageR: combinedRValues.length ? combinedRValues.reduce((s, v) => s + v, 0) / combinedRValues.length : null,
  };

  return { shadow, realDemo, combined };
}

export interface MlDataReadiness {
  shadowCompletedSamples: number;
  realDemoCompletedSamples: number;
  totalUsableSamples: number;
  // A soft, documented heuristic only (spec section 21: "do not hardcode
  // claims of statistical significance") — never presented as a statistical
  // guarantee, just a practical "there's now enough data to bother training
  // an initial challenger" signal.
  recommendedMinimumSamples: number;
  ready: boolean;
}

export async function getMlDataReadiness(pool: Pool): Promise<MlDataReadiness> {
  const recommendedMinimumSamples = loadFinalQualitySettings().ml_recommended_min_samples;
  const [shadowResult, realDemoCompletedSamples] = await Promise.all([
    pool.query(`SELECT count(*)::int AS n FROM shadow_trades WHERE status='CLOSED' AND exit_reason IN ('TAKE_PROFIT','STOP_LOSS') AND ${SHADOW_NOT_DOUBLE_COUNTED_CLAUSE}`),
    countRealDemoCompleted(pool),
  ]);
  const shadowCompletedSamples = Number(shadowResult.rows[0]?.n ?? 0);
  const totalUsableSamples = shadowCompletedSamples + realDemoCompletedSamples;
  return {
    shadowCompletedSamples,
    realDemoCompletedSamples,
    totalUsableSamples,
    recommendedMinimumSamples,
    ready: totalUsableSamples >= recommendedMinimumSamples,
  };
}

// Final Quality Score buckets (spec section 24): 0-49 / 50-64 / 65-79 /
// 80-100 — deliberately different boundaries from the legacy SCORE_BUCKETS
// above (which predate Final Quality Score and still serve the
// profitability/tradeability breakdowns), matching the exact ranges the
// owner's spec calls for.
const FINAL_QUALITY_BUCKETS = [
  { label: '80-100', min: 80, max: 100 },
  { label: '65-79', min: 65, max: 79 },
  { label: '50-64', min: 50, max: 64 },
  { label: '0-49', min: 0, max: 49 },
] as const;

export interface FinalQualityBucketRow {
  bucket: string;
  samples: number;
  triggered: number;
  wins: number;
  losses: number;
  winRate: number;
  averageR: number | null;
  profitFactor: number | null;
  netPnl: number | null;
  averageMfe: number | null;
  averageMae: number | null;
}

function bucketRows(rows: Array<{ score: number | null; status?: string; exitReason: string | null; rMultiple: number | null; net: number | null; mfe: number | null; mae: number | null }>): FinalQualityBucketRow[] {
  return FINAL_QUALITY_BUCKETS.map(({ label, min, max }) => {
    const inBucket = rows.filter((row) => row.score !== null && Number.isFinite(row.score) && (row.score as number) >= min && (row.score as number) <= max);
    const wins = inBucket.filter((r) => r.exitReason === 'TAKE_PROFIT' || r.exitReason === 'WIN');
    const losses = inBucket.filter((r) => r.exitReason === 'STOP_LOSS' || r.exitReason === 'LOSS');
    const triggered = inBucket.filter((r) => r.status === undefined || r.status === 'ENTERED' || r.status === 'CLOSED').length;
    const decided = wins.length + losses.length;
    const rMultiples = inBucket.map((r) => r.rMultiple).filter((v): v is number => v !== null && Number.isFinite(v));
    const netValues = inBucket.map((r) => r.net).filter((v): v is number => v !== null && Number.isFinite(v));
    const mfeValues = inBucket.map((r) => r.mfe).filter((v): v is number => v !== null && Number.isFinite(v));
    const maeValues = inBucket.map((r) => r.mae).filter((v): v is number => v !== null && Number.isFinite(v));
    const grossProfit = netValues.filter((v) => v > 0).reduce((s, v) => s + v, 0);
    const grossLoss = Math.abs(netValues.filter((v) => v < 0).reduce((s, v) => s + v, 0));
    return {
      bucket: label,
      samples: inBucket.length,
      triggered,
      wins: wins.length,
      losses: losses.length,
      winRate: decided > 0 ? wins.length / decided : 0,
      averageR: rMultiples.length ? rMultiples.reduce((s, v) => s + v, 0) / rMultiples.length : null,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
      netPnl: netValues.length ? netValues.reduce((s, v) => s + v, 0) : null,
      averageMfe: mfeValues.length ? mfeValues.reduce((s, v) => s + v, 0) / mfeValues.length : null,
      averageMae: maeValues.length ? maeValues.reduce((s, v) => s + v, 0) / maeValues.length : null,
    };
  });
}

export interface FinalQualityBuckets {
  shadow: FinalQualityBucketRow[];
  realDemo: FinalQualityBucketRow[];
  combined: FinalQualityBucketRow[];
}

// Final Quality bucket breakdown (spec section 24), separated SHADOW /
// REAL DEMO / COMBINED so a simulated shadow-trade estimate is never
// confused with an actual MT5-confirmed dollar outcome. final_quality_score
// lives on opportunity_scan_results (persisted once per M5 cycle row), keyed
// back to shadow_trades / trade_outcomes via ai_trade_plan_id — never
// recomputed here, always the exact value shown to the owner at scan time.
export async function getFinalQualityBuckets(pool: Pool): Promise<FinalQualityBuckets> {
  const [shadowResult, realResult] = await Promise.all([
    pool.query(
      // SHADOW_NOT_DOUBLE_COUNTED_CLAUSE references the unaliased
      // shadow_trades table name, so it is deliberately not aliased here.
      `SELECT o.final_quality_score AS score, shadow_trades.status, shadow_trades.exit_reason, shadow_trades.r_multiple, shadow_trades.net_result_estimate AS net, shadow_trades.mfe_r AS mfe, shadow_trades.mae_r AS mae
       FROM shadow_trades
       JOIN opportunity_scan_results o ON o.ai_trade_plan_id = shadow_trades.ai_trade_plan_id
       WHERE shadow_trades.status = 'CLOSED' AND ${SHADOW_NOT_DOUBLE_COUNTED_CLAUSE}`,
    ),
    pool.query(
      `SELECT o.final_quality_score AS score,
          CASE WHEN t.realized_pnl > 0 THEN 'WIN' WHEN t.realized_pnl < 0 THEN 'LOSS' ELSE NULL END AS exit_reason,
          CASE WHEN t.risk_amount > 0 THEN t.realized_pnl / t.risk_amount ELSE NULL END AS r_multiple,
          t.realized_pnl AS net, NULL::numeric AS mfe, NULL::numeric AS mae
       FROM trade_outcomes t
       JOIN opportunity_scan_results o ON o.ai_trade_plan_id = t.ai_trade_plan_id
       WHERE t.closed_at IS NOT NULL AND t.exit_reason IS DISTINCT FROM 'RECONCILIATION_FAILED'`,
    ),
  ]);

  const shadowRows = (shadowResult.rows as Array<Record<string, unknown>>).map((r) => ({
    score: r.score !== null ? Number(r.score) : null,
    status: r.status as string | undefined,
    exitReason: (r.exit_reason as string | null) ?? null,
    rMultiple: r.r_multiple !== null ? Number(r.r_multiple) : null,
    net: r.net !== null ? Number(r.net) : null,
    mfe: r.mfe !== null ? Number(r.mfe) : null,
    mae: r.mae !== null ? Number(r.mae) : null,
  }));
  const realRows = (realResult.rows as Array<Record<string, unknown>>).map((r) => ({
    score: r.score !== null ? Number(r.score) : null,
    exitReason: (r.exit_reason as string | null) ?? null,
    rMultiple: r.r_multiple !== null ? Number(r.r_multiple) : null,
    net: r.net !== null ? Number(r.net) : null,
    mfe: null,
    mae: null,
  }));

  return {
    shadow: bucketRows(shadowRows),
    realDemo: bucketRows(realRows),
    combined: bucketRows([...shadowRows, ...realRows]),
  };
}

// TOP N vs lower-ranked comparison (spec section 25): "Persist rank so later
// we can measure Rank #1-5 versus lower-ranked Shadow setups." Grouped by
// the exact `rank` column persisted per M5_CYCLE scan row (opportunity_scan_
// results), joined to whichever of shadow_trades/trade_outcomes actually
// completed for that plan — never fabricated, empty for a rank with no
// completed outcome yet.
export interface RankPerformanceRow {
  rank: number;
  samples: number;
  wins: number;
  losses: number;
  winRate: number;
  averageR: number | null;
  netPnl: number | null;
}

export async function getRankPerformance(pool: Pool, maxRank = 10): Promise<RankPerformanceRow[]> {
  const [shadowResult, realResult] = await Promise.all([
    pool.query(
      // SHADOW_NOT_DOUBLE_COUNTED_CLAUSE references the unaliased
      // shadow_trades table name, so it is deliberately not aliased here.
      `SELECT o.rank, shadow_trades.exit_reason, shadow_trades.r_multiple, shadow_trades.net_result_estimate AS net
       FROM shadow_trades
       JOIN opportunity_scan_results o ON o.ai_trade_plan_id = shadow_trades.ai_trade_plan_id AND o.source = 'M5_CYCLE'
       WHERE shadow_trades.status = 'CLOSED' AND o.rank <= $1 AND ${SHADOW_NOT_DOUBLE_COUNTED_CLAUSE}`,
      [maxRank],
    ),
    pool.query(
      `SELECT o.rank,
          CASE WHEN t.realized_pnl > 0 THEN 'TAKE_PROFIT' WHEN t.realized_pnl < 0 THEN 'STOP_LOSS' ELSE NULL END AS exit_reason,
          CASE WHEN t.risk_amount > 0 THEN t.realized_pnl / t.risk_amount ELSE NULL END AS r_multiple,
          t.realized_pnl AS net
       FROM trade_outcomes t
       JOIN opportunity_scan_results o ON o.ai_trade_plan_id = t.ai_trade_plan_id AND o.source = 'M5_CYCLE'
       WHERE t.closed_at IS NOT NULL AND t.exit_reason IS DISTINCT FROM 'RECONCILIATION_FAILED' AND o.rank <= $1`,
      [maxRank],
    ),
  ]);

  const byRank = new Map<number, { wins: number; losses: number; rMultiples: number[]; netValues: number[] }>();
  for (const raw of [...shadowResult.rows, ...realResult.rows] as Array<Record<string, unknown>>) {
    const rank = Number(raw.rank);
    if (!Number.isFinite(rank)) continue;
    const bucket = byRank.get(rank) ?? { wins: 0, losses: 0, rMultiples: [], netValues: [] };
    if (raw.exit_reason === 'TAKE_PROFIT') bucket.wins += 1;
    else if (raw.exit_reason === 'STOP_LOSS') bucket.losses += 1;
    const r = raw.r_multiple !== null ? Number(raw.r_multiple) : null;
    if (r !== null && Number.isFinite(r)) bucket.rMultiples.push(r);
    const net = raw.net !== null ? Number(raw.net) : null;
    if (net !== null && Number.isFinite(net)) bucket.netValues.push(net);
    byRank.set(rank, bucket);
  }

  return Array.from(byRank.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([rank, bucket]) => {
      const decided = bucket.wins + bucket.losses;
      return {
        rank,
        samples: decided,
        wins: bucket.wins,
        losses: bucket.losses,
        winRate: decided > 0 ? bucket.wins / decided : 0,
        averageR: bucket.rMultiples.length ? bucket.rMultiples.reduce((s, v) => s + v, 0) / bucket.rMultiples.length : null,
        netPnl: bucket.netValues.length ? bucket.netValues.reduce((s, v) => s + v, 0) : null,
      };
    });
}
