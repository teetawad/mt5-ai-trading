import { Pool, PoolClient } from 'pg';
import { RiskCheck, RiskCheckStage, RiskResult } from '../types';

function mapRow(row: Record<string, unknown>): RiskCheck {
  return {
    id: row.id as string,
    signalId: row.signal_id as string | null,
    proposalId: row.proposal_id as string | null,
    stage: row.stage as RiskCheckStage,
    result: row.result as RiskResult,
    rulesChecked: row.rules_checked as string[],
    failedRules: row.failed_rules as string[],
    reason: row.reason as string | null,
    marketSnapshot: row.market_snapshot as Record<string, unknown>,
    portfolioSnapshot: row.portfolio_snapshot as Record<string, unknown>,
    createdAt: row.created_at as Date,
  };
}

export async function findRiskCheckById(
  db: Pool | PoolClient,
  id: string,
): Promise<RiskCheck | null> {
  const { rows } = await db.query('SELECT * FROM risk_checks WHERE id = $1', [id]);
  return rows.length ? mapRow(rows[0]) : null;
}

export async function findRiskChecksByProposal(
  db: Pool | PoolClient,
  proposalId: string,
): Promise<RiskCheck[]> {
  const { rows } = await db.query(
    'SELECT * FROM risk_checks WHERE proposal_id = $1 ORDER BY created_at',
    [proposalId],
  );
  return rows.map(mapRow);
}

export async function createRiskCheck(
  db: Pool | PoolClient,
  data: {
    signalId?: string | null;
    proposalId?: string | null;
    stage: RiskCheckStage;
    result: RiskResult;
    rulesChecked: string[];
    failedRules?: string[];
    reason?: string | null;
    marketSnapshot: Record<string, unknown>;
    portfolioSnapshot: Record<string, unknown>;
  },
): Promise<RiskCheck> {
  const { rows } = await db.query(
    `INSERT INTO risk_checks
       (signal_id, proposal_id, stage, result, rules_checked, failed_rules,
        reason, market_snapshot, portfolio_snapshot)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      data.signalId ?? null,
      data.proposalId ?? null,
      data.stage,
      data.result,
      JSON.stringify(data.rulesChecked),
      JSON.stringify(data.failedRules ?? []),
      data.reason ?? null,
      JSON.stringify(data.marketSnapshot),
      JSON.stringify(data.portfolioSnapshot),
    ],
  );
  return mapRow(rows[0]);
}

export async function linkRiskCheckToProposal(
  db: Pool | PoolClient,
  riskCheckId: string,
  proposalId: string,
): Promise<void> {
  await db.query(
    'UPDATE risk_checks SET proposal_id = $1 WHERE id = $2',
    [proposalId, riskCheckId],
  );
}
