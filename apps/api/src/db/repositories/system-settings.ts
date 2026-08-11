import { Pool, PoolClient } from 'pg';
import { SystemSetting } from '../types';

function mapRow(row: Record<string, unknown>): SystemSetting {
  return {
    key: row.key as string,
    value: row.value as unknown,
    description: row.description as string | null,
    updatedAt: row.updated_at as Date,
    updatedBy: row.updated_by as string | null,
  };
}

export async function getSetting(
  db: Pool | PoolClient,
  key: string,
): Promise<SystemSetting | null> {
  const { rows } = await db.query(
    'SELECT * FROM system_settings WHERE key = $1',
    [key],
  );
  return rows.length ? mapRow(rows[0]) : null;
}

export async function getSettingValue<T = unknown>(
  db: Pool | PoolClient,
  key: string,
): Promise<T | null> {
  const setting = await getSetting(db, key);
  return setting ? (setting.value as T) : null;
}

export async function getAllSettings(
  db: Pool | PoolClient,
): Promise<SystemSetting[]> {
  const { rows } = await db.query(
    'SELECT * FROM system_settings ORDER BY key',
  );
  return rows.map(mapRow);
}

export async function setSetting(
  db: Pool | PoolClient,
  key: string,
  value: unknown,
  updatedBy?: string | null,
): Promise<SystemSetting> {
  const { rows } = await db.query(
    `INSERT INTO system_settings (key, value, updated_by)
     VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (key) DO UPDATE
       SET value      = EXCLUDED.value,
           updated_at = NOW(),
           updated_by = EXCLUDED.updated_by
     RETURNING *`,
    [key, JSON.stringify(value), updatedBy ?? null],
  );
  return mapRow(rows[0]);
}

export async function isKillSwitchEnabled(
  db: Pool | PoolClient,
): Promise<boolean> {
  const value = await getSettingValue<boolean>(db, 'trading_kill_switch_enabled');
  return value !== false;
}
