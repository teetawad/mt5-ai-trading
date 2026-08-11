import { Pool, PoolClient } from 'pg';
import { TradeApproval } from '../types';

function mapRow(row: Record<string, unknown>): TradeApproval {
  return {
    id: row.id as string,
    proposalId: row.proposal_id as string,
    approvedBy: row.approved_by as string,
    action: row.action as 'APPROVE' | 'REJECT',
    reason: row.reason as string | null,
    requestId: row.request_id as string,
    ipAddress: row.ip_address as string | null,
    userAgent: row.user_agent as string | null,
    createdAt: row.created_at as Date,
  };
}

export async function findApprovalsByProposal(
  db: Pool | PoolClient,
  proposalId: string,
): Promise<TradeApproval[]> {
  const { rows } = await db.query(
    'SELECT * FROM trade_approvals WHERE proposal_id = $1 ORDER BY created_at',
    [proposalId],
  );
  return rows.map(mapRow);
}

export async function createApproval(
  db: Pool | PoolClient,
  data: {
    proposalId: string;
    approvedBy: string;
    action: 'APPROVE' | 'REJECT';
    reason?: string | null;
    requestId: string;
    ipAddress?: string | null;
    userAgent?: string | null;
  },
): Promise<TradeApproval> {
  const { rows } = await db.query(
    `INSERT INTO trade_approvals
       (proposal_id, approved_by, action, reason, request_id, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      data.proposalId,
      data.approvedBy,
      data.action,
      data.reason ?? null,
      data.requestId,
      data.ipAddress ?? null,
      data.userAgent ?? null,
    ],
  );
  return mapRow(rows[0]);
}
