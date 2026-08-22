import { Pool } from 'pg';
import { resultType } from '../mt5-demo-lab-service';

// REAL_DEMO learning data source (Fast Learning dashboard). Reads
// trade_outcomes — the exact rows History already treats as the source of
// truth for actual MT5 DEMO performance — joined with ai_trade_plans /
// ai_analysis_runs when a real trade happens to be AI-linked. This module
// never writes to trade_outcomes and never recomputes WIN/LOSS/PnL
// differently than History does (see resultType, imported not reimplemented)
// — it only REFERENCES that existing data for AI evaluation / a future ML
// dataset. The two Fast Learning learning-source types are SHADOW (see
// shadow-trade-service.ts / shadow_trades — simulated, never order_send) and
// REAL_DEMO (this module — actual MT5-confirmed trades). A row is always
// tagged with exactly one of the two; they are structurally distinct tables
// and must never be presented as the other.
export type LearningSource = 'SHADOW' | 'REAL_DEMO';

// A trade_outcomes row only ever "completes" the learning dataset once it
// has a definite realized outcome: closed, and not a diagnostic
// EXECUTION_FAILED record (MT5 never actually confirmed a position for
// those — see resultType/RECONCILIATION_FAILED). Matches History's own
// `closed` definition in mt5-demo-lab-service.ts's summarizeTrades exactly,
// so "completed" never disagrees between the two pages.
const COMPLETED_WHERE = `t.closed_at IS NOT NULL AND t.exit_reason IS DISTINCT FROM 'RECONCILIATION_FAILED'`;

export interface RealDemoLearningOutcome {
  source: 'REAL_DEMO';
  id: string;
  aiTradePlanId: string | null;
  symbol: string;
  direction: string | null;
  entryPrice: number | null;
  // No exit-price column exists anywhere in trade_outcomes (only
  // realized_pnl/mfe/mae are ever recorded) — always unavailable rather than
  // derived/invented from other fields.
  exitPrice: null;
  stopLoss: number | null;
  takeProfit: number | null;
  volume: number | null;
  openedAt: string | null;
  closedAt: string | null;
  netPnl: number | null;
  result: 'WIN' | 'LOSS' | 'BREAKEVEN' | 'OPEN' | 'EXECUTION_FAILED';
  holdingMinutes: number | null;
  exitReason: string | null;
  // Risk-normalized like a shadow trade's r_multiple (net_pnl / planned risk
  // amount) so the two sources stay comparable — derived from two real
  // stored columns, never fabricated; null when risk_amount is missing/zero.
  rMultiple: number | null;
  // AI-linked fields (spec: "when linked to an AI plan also include...").
  // Every field here is null/unavailable, never invented, for a trade with
  // no ai_trade_plan_id (older manual/demo-test trades) or missing values.
  confidencePct: number | null;
  tradeabilityPct: number | null;
  profitabilityScore: number | null;
  aiProvider: string | null;
  aiModel: string | null;
  aiPromptVersion: string | null;
  entryType: string | null;
  riskReward: number | null;
  marketSnapshot: unknown | null;
}

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function mapRow(row: Record<string, unknown>): RealDemoLearningOutcome {
  const openedAt = row.opened_at ? new Date(String(row.opened_at)).getTime() : null;
  const closedAt = row.closed_at ? new Date(String(row.closed_at)).getTime() : null;
  const holdingMinutes = openedAt !== null && closedAt !== null && Number.isFinite(openedAt) && Number.isFinite(closedAt)
    ? (closedAt - openedAt) / 60000
    : null;
  const netPnl = numOrNull(row.realized_pnl);
  const riskAmount = numOrNull(row.risk_amount);
  const rMultiple = netPnl !== null && riskAmount !== null && riskAmount > 0 ? netPnl / riskAmount : null;

  return {
    source: 'REAL_DEMO',
    id: String(row.id),
    aiTradePlanId: row.ai_trade_plan_id ? String(row.ai_trade_plan_id) : null,
    symbol: String(row.symbol),
    direction: row.side !== null && row.side !== undefined ? String(row.side) : null,
    entryPrice: numOrNull(row.actual_entry) ?? numOrNull(row.expected_entry),
    exitPrice: null,
    stopLoss: numOrNull(row.stop_loss),
    takeProfit: numOrNull(row.take_profit),
    volume: numOrNull(row.volume),
    openedAt: row.opened_at ? new Date(String(row.opened_at)).toISOString() : null,
    closedAt: row.closed_at ? new Date(String(row.closed_at)).toISOString() : null,
    netPnl,
    result: resultType(row.realized_pnl, row.exit_reason),
    holdingMinutes,
    exitReason: row.exit_reason !== null && row.exit_reason !== undefined ? String(row.exit_reason) : null,
    rMultiple,
    confidencePct: numOrNull(row.confidence_pct),
    tradeabilityPct: numOrNull(row.tradeability_pct),
    profitabilityScore: numOrNull(row.profitability_score),
    aiProvider: row.ai_provider !== null && row.ai_provider !== undefined ? String(row.ai_provider) : null,
    aiModel: row.ai_model !== null && row.ai_model !== undefined ? String(row.ai_model) : null,
    aiPromptVersion: row.ai_prompt_version !== null && row.ai_prompt_version !== undefined ? String(row.ai_prompt_version) : null,
    entryType: row.entry_type !== null && row.entry_type !== undefined ? String(row.entry_type) : null,
    riskReward: numOrNull(row.plan_risk_reward) ?? numOrNull(row.outcome_risk_reward),
    marketSnapshot: row.market_analysis_package ?? null,
  };
}

export interface ListRealDemoLearningOutcomesOptions {
  since?: Date;
  limit?: number;
}

// The REAL_DEMO half of the AI evaluation dataset (spec section 2's
// "backfill"): no separate import/migration step exists or is needed —
// every real DEMO trade History already knows about is available here
// immediately via this read-only join, exactly as it was recorded.
export async function listRealDemoLearningOutcomes(pool: Pool, options: ListRealDemoLearningOutcomesOptions = {}): Promise<RealDemoLearningOutcome[]> {
  const params: unknown[] = [];
  const conditions = [COMPLETED_WHERE];
  if (options.since) {
    params.push(options.since.toISOString());
    conditions.push(`t.closed_at >= $${params.length}`);
  }
  let limitClause = '';
  if (options.limit) {
    params.push(Math.min(500, Math.max(1, options.limit)));
    limitClause = `LIMIT $${params.length}`;
  }

  const result = await pool.query(
    `SELECT t.id, t.ai_trade_plan_id, t.symbol, t.side, t.volume, t.expected_entry, t.actual_entry,
        t.stop_loss, t.take_profit, t.risk_amount, t.risk_reward AS outcome_risk_reward, t.exit_reason,
        t.realized_pnl, t.opened_at, t.closed_at,
        ap.confidence_pct, ap.tradeability_pct, ap.profitability_score,
        ap.ai_provider, ap.ai_model, ap.ai_prompt_version, ap.entry_type, ap.risk_reward AS plan_risk_reward,
        ar.market_analysis_package
     FROM trade_outcomes t
     LEFT JOIN ai_trade_plans ap ON ap.id = t.ai_trade_plan_id
     LEFT JOIN ai_analysis_runs ar ON ar.id = ap.analysis_run_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY t.closed_at DESC
     ${limitClause}`,
    params,
  );
  return result.rows.map(mapRow);
}

export interface RealDemoOutcomeSummary {
  samples: number;
  wins: number;
  losses: number;
  breakeven: number;
  winRate: number;
  averageR: number | null;
  profitFactor: number | null;
}

// Pure aggregation over an already-fetched outcome list (shared by the
// "today" and "all time" dashboard sections so both use one definition of
// win/loss/profit factor).
export function summarizeRealDemoOutcomes(outcomes: RealDemoLearningOutcome[]): RealDemoOutcomeSummary {
  const wins = outcomes.filter((o) => o.result === 'WIN');
  const losses = outcomes.filter((o) => o.result === 'LOSS');
  const breakeven = outcomes.filter((o) => o.result === 'BREAKEVEN');
  const decided = wins.length + losses.length;
  const rMultiples = outcomes.map((o) => o.rMultiple).filter((v): v is number => v !== null && Number.isFinite(v));
  const grossProfit = wins.reduce((sum, o) => sum + (o.netPnl ?? 0), 0);
  const grossLoss = Math.abs(losses.reduce((sum, o) => sum + (o.netPnl ?? 0), 0));

  return {
    samples: outcomes.length,
    wins: wins.length,
    losses: losses.length,
    breakeven: breakeven.length,
    winRate: decided > 0 ? wins.length / decided : 0,
    averageR: rMultiples.length ? rMultiples.reduce((s, v) => s + v, 0) / rMultiples.length : null,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
  };
}

// Lightweight COUNT-only query for readiness checks that don't need the full
// row payload — same COMPLETED_WHERE definition as listRealDemoLearningOutcomes
// so the two can never disagree on what counts as "completed".
export async function countRealDemoCompleted(pool: Pool, options: { since?: Date } = {}): Promise<number> {
  const params: unknown[] = [];
  const conditions = [COMPLETED_WHERE];
  if (options.since) {
    params.push(options.since.toISOString());
    conditions.push(`t.closed_at >= $${params.length}`);
  }
  const result = await pool.query(`SELECT count(*)::int AS n FROM trade_outcomes t WHERE ${conditions.join(' AND ')}`, params);
  return Number(result.rows[0]?.n ?? 0);
}

// A shadow_trades row must never be double-counted against Fast Learning
// totals once its plan was ALSO manually approved to a real MT5 DEMO order
// (nothing stops an M5-cycle-generated, Risk-PASS plan from later being
// approved through the normal AI Trade approval flow — shadow creation and
// real approval are entirely independent paths over the same ai_trade_plans
// row). When both exist for one plan, the real outcome is ground truth and
// wins the count; every shadow aggregate query below excludes it.
export const SHADOW_NOT_DOUBLE_COUNTED_CLAUSE = `NOT EXISTS (
  SELECT 1 FROM trade_outcomes rt WHERE rt.ai_trade_plan_id = shadow_trades.ai_trade_plan_id
)`;
