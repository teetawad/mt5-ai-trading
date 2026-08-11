import { Pool, PoolClient } from 'pg';
import { TradeProposal, ProposalStatus } from '../types';

function mapRow(row: Record<string, unknown>): TradeProposal {
  return {
    id: row.id as string,
    signalId: row.signal_id as string,
    strategyId: row.strategy_id as string,
    symbol: row.symbol as string,
    side: row.side as 'BUY' | 'SELL',
    quantity: row.quantity as string,
    orderType: row.order_type as 'MARKET' | 'LIMIT',
    referencePrice: row.reference_price as string,
    limitPrice: row.limit_price as string | null,
    estimatedNotional: row.estimated_notional as string,
    riskCheckId: row.risk_check_id as string | null,
    riskSnapshot: row.risk_snapshot as Record<string, unknown>,
    portfolioSnapshot: row.portfolio_snapshot as Record<string, unknown>,
    status: row.status as ProposalStatus,
    createdAt: row.created_at as Date,
    pendingApprovalAt: row.pending_approval_at as Date | null,
    expiresAt: row.expires_at as Date,
    approvedAt: row.approved_at as Date | null,
    rejectedAt: row.rejected_at as Date | null,
    filledAt: row.filled_at as Date | null,
    updatedAt: row.updated_at as Date,
    notes: row.notes as string | null,
  };
}

export async function findProposalById(
  db: Pool | PoolClient,
  id: string,
): Promise<TradeProposal | null> {
  const { rows } = await db.query('SELECT * FROM trade_proposals WHERE id = $1', [id]);
  return rows.length ? mapRow(rows[0]) : null;
}

export async function findProposalByIdForUpdate(
  db: Pool | PoolClient,
  id: string,
): Promise<TradeProposal | null> {
  const { rows } = await db.query(
    'SELECT * FROM trade_proposals WHERE id = $1 FOR UPDATE',
    [id],
  );
  return rows.length ? mapRow(rows[0]) : null;
}

export async function findProposalsByStatus(
  db: Pool | PoolClient,
  status: ProposalStatus,
): Promise<TradeProposal[]> {
  const { rows } = await db.query(
    'SELECT * FROM trade_proposals WHERE status = $1 ORDER BY created_at',
    [status],
  );
  return rows.map(mapRow);
}

export async function findPendingApprovalProposals(
  db: Pool | PoolClient,
): Promise<TradeProposal[]> {
  const { rows } = await db.query(
    `SELECT * FROM trade_proposals
     WHERE status = 'PENDING_APPROVAL' AND expires_at > NOW()
     ORDER BY pending_approval_at ASC`,
  );
  return rows.map(mapRow);
}

export async function createProposal(
  db: Pool | PoolClient,
  data: {
    signalId: string;
    strategyId: string;
    symbol: string;
    side: 'BUY' | 'SELL';
    quantity: string;
    orderType: 'MARKET' | 'LIMIT';
    referencePrice: string;
    limitPrice?: string | null;
    estimatedNotional: string;
    riskCheckId?: string | null;
    riskSnapshot: Record<string, unknown>;
    portfolioSnapshot: Record<string, unknown>;
    expiresAt: Date;
    notes?: string | null;
  },
): Promise<TradeProposal> {
  const { rows } = await db.query(
    `INSERT INTO trade_proposals
       (signal_id, strategy_id, symbol, side, quantity, order_type,
        reference_price, limit_price, estimated_notional,
        risk_check_id, risk_snapshot, portfolio_snapshot, expires_at, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING *`,
    [
      data.signalId,
      data.strategyId,
      data.symbol,
      data.side,
      data.quantity,
      data.orderType,
      data.referencePrice,
      data.limitPrice ?? null,
      data.estimatedNotional,
      data.riskCheckId ?? null,
      JSON.stringify(data.riskSnapshot),
      JSON.stringify(data.portfolioSnapshot),
      data.expiresAt,
      data.notes ?? null,
    ],
  );
  return mapRow(rows[0]);
}

export async function updateProposalStatus(
  db: Pool | PoolClient,
  id: string,
  status: ProposalStatus,
  timestamps: {
    pendingApprovalAt?: Date;
    approvedAt?: Date;
    rejectedAt?: Date;
    filledAt?: Date;
  } = {},
): Promise<TradeProposal> {
  const { rows } = await db.query(
    `UPDATE trade_proposals
     SET status             = $2,
         updated_at         = NOW(),
         pending_approval_at = COALESCE($3, pending_approval_at),
         approved_at        = COALESCE($4, approved_at),
         rejected_at        = COALESCE($5, rejected_at),
         filled_at          = COALESCE($6, filled_at)
     WHERE id = $1
     RETURNING *`,
    [
      id,
      status,
      timestamps.pendingApprovalAt ?? null,
      timestamps.approvedAt ?? null,
      timestamps.rejectedAt ?? null,
      timestamps.filledAt ?? null,
    ],
  );
  return mapRow(rows[0]);
}

export async function setProposalRiskCheck(
  db: Pool | PoolClient,
  id: string,
  riskCheckId: string,
): Promise<void> {
  await db.query(
    'UPDATE trade_proposals SET risk_check_id = $1, updated_at = NOW() WHERE id = $2',
    [riskCheckId, id],
  );
}

export async function findExpiredProposals(
  db: Pool | PoolClient,
): Promise<TradeProposal[]> {
  const { rows } = await db.query(
    `SELECT * FROM trade_proposals
     WHERE status IN ('RISK_CHECKING', 'PENDING_APPROVAL', 'APPROVED', 'REVALIDATING')
       AND expires_at < NOW()
     ORDER BY expires_at`,
  );
  return rows.map(mapRow);
}
