import { Pool } from 'pg';
import { AiTradeAction } from './decision-policy';

// Spec: "ALL VALID SETUPS ARE DEMO-ACTIONABLE" — this module is pure
// measurement of the current three-action model (ENTER_NOW/WAIT_FOR_ENTRY/
// NO_EXECUTION) and never feeds back into decision-policy.ts automatically,
// which no longer has any threshold to recalibrate (it is a mechanical
// entry_type mapping only). This is exactly the dataset later used to
// evaluate whether tradeability_pct bands actually predict outcomes (spec
// section 16) — it never decides position sizing itself.
//
// Historical rows from before this refactor may still carry the old
// 'WATCH'/'NO_TRADE' values; they simply fall outside this list and are
// excluded from current-model statistics, which is correct — that data
// reflects a different, no-longer-active operating mode.
const ACTIONS: AiTradeAction[] = ['ENTER_NOW', 'WAIT_FOR_ENTRY', 'NO_EXECUTION'];

export interface AiActionDistributionRow {
  action: AiTradeAction;
  count: number;
  percent: number;
}

export interface AiActionOutcomeRow {
  action: AiTradeAction;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
}

export interface AiActionStats {
  totalAnalyses: number;
  distribution: AiActionDistributionRow[];
  pendingOrders: {
    created: number;
    triggered: number;
    expired: number;
  };
  outcomesByAction: AiActionOutcomeRow[];
}

export async function getAiActionStats(pool: Pool): Promise<AiActionStats> {
  const [distributionResult, pendingResult, outcomesResult] = await Promise.all([
    pool.query(
      `SELECT action, COUNT(*)::int AS count
       FROM ai_analysis_runs
       WHERE action IS NOT NULL
       GROUP BY action`,
    ),
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE mt5_order_ticket IS NOT NULL)::int AS created,
         COUNT(*) FILTER (WHERE triggered_at IS NOT NULL)::int AS triggered,
         COUNT(*) FILTER (WHERE status = 'PLAN_EXPIRED')::int AS expired
       FROM ai_trade_plans
       WHERE action = 'WAIT_FOR_ENTRY'`,
    ),
    pool.query(
      `SELECT p.action, t.realized_pnl
       FROM trade_outcomes t
       JOIN ai_trade_plans p ON p.id = t.ai_trade_plan_id
       WHERE t.closed_at IS NOT NULL AND t.exit_reason <> 'RECONCILIATION_FAILED' AND p.action IS NOT NULL`,
    ),
  ]);

  const totalAnalyses = distributionResult.rows.reduce((sum, row) => sum + Number(row.count), 0);
  const countByAction = new Map(distributionResult.rows.map((row) => [row.action as AiTradeAction, Number(row.count)]));
  const distribution: AiActionDistributionRow[] = ACTIONS.map((action) => {
    const count = countByAction.get(action) ?? 0;
    return { action, count, percent: totalAnalyses > 0 ? Math.round((count / totalAnalyses) * 1000) / 10 : 0 };
  });

  const outcomesByAction: AiActionOutcomeRow[] = ACTIONS.map((action) => {
    const rows = outcomesResult.rows.filter((row) => row.action === action);
    const wins = rows.filter((row) => Number(row.realized_pnl) > 0);
    const losses = rows.filter((row) => Number(row.realized_pnl) < 0);
    const totalPnl = rows.reduce((sum, row) => sum + Number(row.realized_pnl), 0);
    return {
      action,
      trades: rows.length,
      wins: wins.length,
      losses: losses.length,
      winRate: wins.length + losses.length > 0 ? wins.length / (wins.length + losses.length) : 0,
      totalPnl,
    };
  });

  const pendingRow = pendingResult.rows[0] ?? { created: 0, triggered: 0, expired: 0 };

  return {
    totalAnalyses,
    distribution,
    pendingOrders: {
      created: Number(pendingRow.created ?? 0),
      triggered: Number(pendingRow.triggered ?? 0),
      expired: Number(pendingRow.expired ?? 0),
    },
    outcomesByAction,
  };
}
