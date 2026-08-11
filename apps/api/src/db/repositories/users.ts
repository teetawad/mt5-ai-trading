import { Pool, PoolClient } from 'pg';
import { User } from '../types';

function mapRow(row: Record<string, unknown>): User {
  return {
    id: row.id as string,
    email: row.email as string,
    displayName: row.display_name as string,
    passwordHash: row.password_hash as string,
    role: row.role as string,
    isActive: row.is_active as boolean,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
    lastLoginAt: row.last_login_at as Date | null,
  };
}

export async function findUserById(
  db: Pool | PoolClient,
  id: string,
): Promise<User | null> {
  const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [id]);
  return rows.length ? mapRow(rows[0]) : null;
}

export async function findUserByEmail(
  db: Pool | PoolClient,
  email: string,
): Promise<User | null> {
  const { rows } = await db.query('SELECT * FROM users WHERE email = $1', [email]);
  return rows.length ? mapRow(rows[0]) : null;
}

export async function createUser(
  db: Pool | PoolClient,
  data: {
    email: string;
    displayName: string;
    passwordHash: string;
    role?: string;
  },
): Promise<User> {
  const { rows } = await db.query(
    `INSERT INTO users (email, display_name, password_hash, role)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [data.email, data.displayName, data.passwordHash, data.role ?? 'owner'],
  );
  return mapRow(rows[0]);
}

export async function updateUserLastLogin(
  db: Pool | PoolClient,
  id: string,
): Promise<void> {
  await db.query(
    'UPDATE users SET last_login_at = NOW(), updated_at = NOW() WHERE id = $1',
    [id],
  );
}

export async function setUserActive(
  db: Pool | PoolClient,
  id: string,
  isActive: boolean,
): Promise<void> {
  await db.query(
    'UPDATE users SET is_active = $1, updated_at = NOW() WHERE id = $2',
    [isActive, id],
  );
}
