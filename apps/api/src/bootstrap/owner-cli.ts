/**
 * Creates the initial owner account. Run once before first use.
 *
 * Usage:
 *   BOOTSTRAP_EMAIL=owner@example.com BOOTSTRAP_PASSWORD=... tsx src/bootstrap/owner-cli.ts
 *
 * Or pass via command-line args:
 *   tsx src/bootstrap/owner-cli.ts owner@example.com 'MyStrongPassword!'
 *
 * Idempotent: exits cleanly if an owner with that email already exists.
 */

import { loadEnvFile } from 'node:process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createPool } from '../db/client';
import { runMigrations } from '../db/migrate';
import { findUserByEmail, createUser } from '../db/repositories/users';
import { hashPassword } from '../auth/password';

// trade/.env
const envPath = path.resolve(__dirname, '../../../../.env');
if (existsSync(envPath)) {
  loadEnvFile(envPath);
  console.log(`[bootstrap] Loaded environment from ${envPath}`);
}

async function main() {
  const email = (process.argv[2] ?? process.env.BOOTSTRAP_EMAIL ?? '').trim().toLowerCase();
  const password = process.argv[3] ?? process.env.BOOTSTRAP_PASSWORD ?? '';
  const displayName = process.env.BOOTSTRAP_DISPLAY_NAME ?? 'Owner';

  if (!email || !password) {
    console.error('Usage: tsx src/bootstrap/owner-cli.ts <email> <password>');
    console.error('  or set BOOTSTRAP_EMAIL and BOOTSTRAP_PASSWORD env vars');
    process.exit(1);
  }

  if (password.length < 12) {
    console.error('Password must be at least 12 characters');
    process.exit(1);
  }

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL must be set');
    process.exit(1);
  }

  const pool = createPool(url);
  try {
    await runMigrations(pool);

    const existing = await findUserByEmail(pool, email);
    if (existing) {
      console.log(`[bootstrap] Owner account already exists: ${email}`);
      process.exit(0);
    }

    const passwordHash = await hashPassword(password);
    const user = await createUser(pool, {
      email,
      displayName,
      passwordHash,
      role: 'owner',
    });

    console.log(`[bootstrap] Owner account created:`);
    console.log(`  ID:    ${user.id}`);
    console.log(`  Email: ${user.email}`);
    console.log(`  Role:  ${user.role}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[bootstrap] Fatal:', err.message);
  process.exit(1);
});
