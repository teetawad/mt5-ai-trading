import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getTestPool, setupTestDb, withTransaction } from './setup';
import {
  getSetting,
  getSettingValue,
  getAllSettings,
  setSetting,
  isKillSwitchEnabled,
} from '../../db/repositories/system-settings';

const SKIP = !process.env.TEST_DATABASE_URL;

describe('system-settings repository', () => {
  let pool: Pool;

  beforeAll(async () => {
    if (SKIP) return;
    pool = getTestPool();
    await setupTestDb(pool);
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  it.skipIf(SKIP)('getSetting returns seeded value', async () => {
    await withTransaction(pool, async (client) => {
      const setting = await getSetting(client, 'trading_mode');
      expect(setting).not.toBeNull();
      expect(setting!.value).toBe('PAPER');
    });
  });

  it.skipIf(SKIP)('getSetting returns null for unknown key', async () => {
    await withTransaction(pool, async (client) => {
      const setting = await getSetting(client, 'nonexistent_key');
      expect(setting).toBeNull();
    });
  });

  it.skipIf(SKIP)('getSettingValue returns typed value', async () => {
    await withTransaction(pool, async (client) => {
      const value = await getSettingValue<number>(client, 'max_open_positions');
      expect(value).toBe(10);
    });
  });

  it.skipIf(SKIP)('getAllSettings returns all seeded settings', async () => {
    await withTransaction(pool, async (client) => {
      const settings = await getAllSettings(client);
      expect(settings.length).toBeGreaterThanOrEqual(12);
      const keys = settings.map((s) => s.key);
      expect(keys).toContain('trading_kill_switch_enabled');
      expect(keys).toContain('trading_mode');
    });
  });

  it.skipIf(SKIP)('setSetting upserts a new setting', async () => {
    await withTransaction(pool, async (client) => {
      const updated = await setSetting(client, 'max_open_positions', 20, null);
      expect(updated.value).toBe(20);
      const fetched = await getSettingValue<number>(client, 'max_open_positions');
      expect(fetched).toBe(20);
    });
  });

  it.skipIf(SKIP)('isKillSwitchEnabled returns true by default', async () => {
    await withTransaction(pool, async (client) => {
      const enabled = await isKillSwitchEnabled(client);
      expect(enabled).toBe(true);
    });
  });
});
