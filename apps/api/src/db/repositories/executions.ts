import { Pool, PoolClient } from 'pg';
import { Execution, ExecutionStatus } from '../types';

function mapRow(row: Record<string, unknown>): Execution {
  return {
    id: row.id as string,
    proposalId: row.proposal_id as string,
    idempotencyKey: row.idempotency_key as string,
    brokerOrderId: row.broker_order_id as string | null,
    status: row.status as ExecutionStatus,
    attemptNumber: row.attempt_number as number,
    errorMessage: row.error_message as string | null,
    createdAt: row.created_at as Date,
    submittedAt: row.submitted_at as Date | null,
    completedAt: row.completed_at as Date | null,
    updatedAt: row.updated_at as Date,
  };
}

export async function findExecutionById(
  db: Pool | PoolClient,
  id: string,
): Promise<Execution | null> {
  const { rows } = await db.query('SELECT * FROM executions WHERE id = $1', [id]);
  return rows.length ? mapRow(rows[0]) : null;
}

export async function listExecutions(
  db: Pool | PoolClient,
  limit = 20,
  offset = 0,
): Promise<Execution[]> {
  const { rows } = await db.query(
    `SELECT * FROM executions
     ORDER BY created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return rows.map(mapRow);
}

export async function findExecutionByIdempotencyKey(
  db: Pool | PoolClient,
  key: string,
): Promise<Execution | null> {
  const { rows } = await db.query(
    'SELECT * FROM executions WHERE idempotency_key = $1',
    [key],
  );
  return rows.length ? mapRow(rows[0]) : null;
}

export async function findExecutionsByProposal(
  db: Pool | PoolClient,
  proposalId: string,
): Promise<Execution[]> {
  const { rows } = await db.query(
    'SELECT * FROM executions WHERE proposal_id = $1 ORDER BY attempt_number',
    [proposalId],
  );
  return rows.map(mapRow);
}

export async function createExecution(
  db: Pool | PoolClient,
  data: {
    proposalId: string;
    idempotencyKey: string;
    attemptNumber?: number;
  },
): Promise<Execution> {
  const { rows } = await db.query(
    `INSERT INTO executions (proposal_id, idempotency_key, attempt_number)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [data.proposalId, data.idempotencyKey, data.attemptNumber ?? 1],
  );
  return mapRow(rows[0]);
}

export async function updateExecutionStatus(
  db: Pool | PoolClient,
  id: string,
  status: ExecutionStatus,
  data: {
    brokerOrderId?: string | null;
    errorMessage?: string | null;
    submittedAt?: Date | null;
    completedAt?: Date | null;
  } = {},
): Promise<Execution> {
  const { rows } = await db.query(
    `UPDATE executions
     SET status        = $2,
         updated_at    = NOW(),
         broker_order_id = COALESCE($3, broker_order_id),
         error_message  = COALESCE($4, error_message),
         submitted_at   = COALESCE($5, submitted_at),
         completed_at   = COALESCE($6, completed_at)
     WHERE id = $1
     RETURNING *`,
    [
      id,
      status,
      data.brokerOrderId ?? null,
      data.errorMessage ?? null,
      data.submittedAt ?? null,
      data.completedAt ?? null,
    ],
  );
  return mapRow(rows[0]);
}
