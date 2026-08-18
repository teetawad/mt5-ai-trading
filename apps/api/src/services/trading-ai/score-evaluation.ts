import { Pool } from 'pg';

// Spec section 13: compare Trade Score buckets against actual DEMO outcomes.
// This is evidence collection for future calibration, never an automatic
// live scoring-formula change — see trade-score.ts, which is never mutated
// by this module.
const BUCKETS = [
  { label: '90-100', min: 90, max: 100 },
  { label: '75-89', min: 75, max: 89 },
  { label: '60-74', min: 60, max: 74 },
  { label: '40-59', min: 40, max: 59 },
  { label: '0-39', min: 0, max: 39 },
] as const;

export interface ScoreBucketEvaluation {
  bucket: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  profitFactor: number | null;
  averageR: number | null;
}

export async function getTradeScoreEvaluation(pool: Pool): Promise<{ buckets: ScoreBucketEvaluation[]; totalSampleSize: number }> {
  const result = await pool.query(
    `SELECT p.trade_score, t.realized_pnl, t.risk_amount
     FROM trade_outcomes t
     JOIN ai_trade_plans p ON p.id = t.ai_trade_plan_id
     WHERE t.closed_at IS NOT NULL AND t.exit_reason <> 'RECONCILIATION_FAILED' AND p.trade_score IS NOT NULL`,
  );

  const buckets: ScoreBucketEvaluation[] = BUCKETS.map(({ label, min, max }) => {
    const rows = result.rows.filter((row) => {
      const score = Number(row.trade_score);
      return score >= min && score <= max;
    });
    const wins = rows.filter((row) => Number(row.realized_pnl) > 0);
    const losses = rows.filter((row) => Number(row.realized_pnl) < 0);
    const grossProfit = wins.reduce((sum, row) => sum + Number(row.realized_pnl), 0);
    const grossLoss = Math.abs(losses.reduce((sum, row) => sum + Number(row.realized_pnl), 0));
    const rMultiples = rows
      .map((row) => {
        const risk = Number(row.risk_amount);
        const pnl = Number(row.realized_pnl);
        return risk > 0 && Number.isFinite(pnl) ? pnl / risk : null;
      })
      .filter((value): value is number => value !== null);
    return {
      bucket: label,
      trades: rows.length,
      wins: wins.length,
      losses: losses.length,
      winRate: wins.length + losses.length > 0 ? wins.length / (wins.length + losses.length) : 0,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
      averageR: rMultiples.length ? rMultiples.reduce((sum, v) => sum + v, 0) / rMultiples.length : null,
    };
  });

  return { buckets, totalSampleSize: result.rows.length };
}
