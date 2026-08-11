import { Pool, PoolClient } from 'pg';
import { AuditLog } from '../types';

function mapRow(row: Record<string, unknown>): AuditLog {
  return {
    id: row.id as string,
    eventType: row.event_type as string,
    actorId: row.actor_id as string | null,
    actorEmail: row.actor_email as string | null,
    entityType: row.entity_type as string | null,
    entityId: row.entity_id as string | null,
    action: row.action as string,
    beforeData: row.before_data as Record<string, unknown> | null,
    afterData: row.after_data as Record<string, unknown> | null,
    requestId: row.request_id as string | null,
    ipAddress: row.ip_address as string | null,
    createdAt: row.created_at as Date,
  };
}

export async function createAuditLog(
  db: Pool | PoolClient,
  data: {
    eventType: string;
    actorId?: string | null;
    actorEmail?: string | null;
    entityType?: string | null;
    entityId?: string | null;
    action: string;
    beforeData?: Record<string, unknown> | null;
    afterData?: Record<string, unknown> | null;
    requestId?: string | null;
    ipAddress?: string | null;
  },
): Promise<AuditLog> {
  const { rows } = await db.query(
    `INSERT INTO audit_logs
       (event_type, actor_id, actor_email, entity_type, entity_id,
        action, before_data, after_data, request_id, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      data.eventType,
      data.actorId ?? null,
      data.actorEmail ?? null,
      data.entityType ?? null,
      data.entityId ?? null,
      data.action,
      data.beforeData ? JSON.stringify(data.beforeData) : null,
      data.afterData ? JSON.stringify(data.afterData) : null,
      data.requestId ?? null,
      data.ipAddress ?? null,
    ],
  );
  return mapRow(rows[0]);
}

export async function findAuditLogsByEntity(
  db: Pool | PoolClient,
  entityType: string,
  entityId: string,
): Promise<AuditLog[]> {
  const { rows } = await db.query(
    `SELECT * FROM audit_logs
     WHERE entity_type = $1 AND entity_id = $2
     ORDER BY created_at`,
    [entityType, entityId],
  );
  return rows.map(mapRow);
}

export async function listAuditLogs(
  db: Pool | PoolClient,
  filters: {
    eventType?: string;
    entityId?: string;
    actorId?: string;
    from?: Date;
    to?: Date;
    limit?: number;
    offset?: number;
  } = {},
): Promise<AuditLog[]> {
  const clauses: string[] = [];
  const values: unknown[] = [];

  if (filters.eventType) {
    values.push(filters.eventType);
    clauses.push(`event_type = $${values.length}`);
  }
  if (filters.entityId) {
    values.push(filters.entityId);
    clauses.push(`entity_id = $${values.length}`);
  }
  if (filters.actorId) {
    values.push(filters.actorId);
    clauses.push(`actor_id = $${values.length}`);
  }
  if (filters.from) {
    values.push(filters.from);
    clauses.push(`created_at >= $${values.length}`);
  }
  if (filters.to) {
    values.push(filters.to);
    clauses.push(`created_at <= $${values.length}`);
  }

  values.push(filters.limit ?? 20);
  const limitParam = values.length;
  values.push(filters.offset ?? 0);
  const offsetParam = values.length;

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await db.query(
    `SELECT * FROM audit_logs
     ${where}
     ORDER BY created_at DESC
     LIMIT $${limitParam} OFFSET $${offsetParam}`,
    values,
  );
  return rows.map(mapRow);
}

export async function findAuditLogsByActor(
  db: Pool | PoolClient,
  actorId: string,
  limit = 100,
): Promise<AuditLog[]> {
  const { rows } = await db.query(
    `SELECT * FROM audit_logs
     WHERE actor_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [actorId, limit],
  );
  return rows.map(mapRow);
}
