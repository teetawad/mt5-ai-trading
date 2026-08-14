import { Router, Request, Response } from 'express';
import { requireAuth, requireOwner } from '../auth/middleware';
import { getPool } from '../db/client';
import { createAuditLog } from '../db/repositories/audit-logs';
import { getAllSettings, getSetting, setSetting } from '../db/repositories/system-settings';
import { SystemSetting } from '../db/types';

export const settingsRouter = Router();

settingsRouter.use(requireAuth);

function requestId(req: Request): string | null {
  return (req.headers['x-request-id'] as string | undefined) ?? null;
}

function serialise(setting: SystemSetting) {
  return {
    key: setting.key,
    value: setting.value,
    description: setting.description,
    updatedAt: setting.updatedAt.toISOString(),
    updatedBy: setting.updatedBy,
  };
}

settingsRouter.get('/', async (_req: Request, res: Response) => {
  res.json((await getAllSettings(getPool())).map(serialise));
});

settingsRouter.get('/kill-switch', async (_req: Request, res: Response) => {
  const setting = await getSetting(getPool(), 'trading_kill_switch_enabled');
  res.json({ enabled: setting?.value !== false });
});

settingsRouter.put('/kill-switch', requireOwner, async (req: Request, res: Response) => {
  const { enabled } = req.body as { enabled?: unknown };
  if (typeof enabled !== 'boolean') {
    res.status(422).json({ error: 'VALIDATION_ERROR', message: 'enabled must be boolean' });
    return;
  }

  const pool = getPool();
  const before = await getSetting(pool, 'trading_kill_switch_enabled');
  const updated = await setSetting(pool, 'trading_kill_switch_enabled', enabled, req.user!.sub);

  await createAuditLog(pool, {
    eventType: 'KILL_SWITCH_UPDATED',
    actorId: req.user!.sub,
    actorEmail: req.user!.email,
    entityType: 'system_setting',
    action: enabled ? 'ENABLE_KILL_SWITCH' : 'DISABLE_KILL_SWITCH',
    beforeData: before ? { key: before.key, value: before.value } : null,
    afterData: { key: updated.key, value: updated.value },
    requestId: requestId(req),
  });

  res.json({ enabled: updated.value !== false, updatedAt: updated.updatedAt.toISOString() });
});

settingsRouter.get('/intraday-mode', async (_req: Request, res: Response) => {
  const setting = await getSetting(getPool(), 'phase25_intraday_mode_enabled');
  res.json({ enabled: setting?.value === true });
});

settingsRouter.put('/intraday-mode', requireOwner, async (req: Request, res: Response) => {
  const { enabled } = req.body as { enabled?: unknown };
  if (typeof enabled !== 'boolean') {
    res.status(422).json({ error: 'VALIDATION_ERROR', message: 'enabled must be boolean' });
    return;
  }

  const pool = getPool();
  const before = await getSetting(pool, 'phase25_intraday_mode_enabled');
  const updated = await setSetting(pool, 'phase25_intraday_mode_enabled', enabled, req.user!.sub);

  await createAuditLog(pool, {
    eventType: 'INTRADAY_MODE_UPDATED',
    actorId: req.user!.sub,
    actorEmail: req.user!.email,
    entityType: 'system_setting',
    action: enabled ? 'ENABLE_INTRADAY_MODE' : 'DISABLE_INTRADAY_MODE',
    beforeData: before ? { key: before.key, value: before.value } : null,
    afterData: { key: updated.key, value: updated.value },
    requestId: requestId(req),
  });

  res.json({ enabled: updated.value === true, updatedAt: updated.updatedAt.toISOString() });
});

settingsRouter.get('/crypto-trading-mode', async (_req: Request, res: Response) => {
  const setting = await getSetting(getPool(), 'phase26_crypto_trading_enabled');
  res.json({ enabled: setting?.value === true });
});

settingsRouter.put('/crypto-trading-mode', requireOwner, async (req: Request, res: Response) => {
  const { enabled } = req.body as { enabled?: unknown };
  if (typeof enabled !== 'boolean') {
    res.status(422).json({ error: 'VALIDATION_ERROR', message: 'enabled must be boolean' });
    return;
  }

  const pool = getPool();
  const before = await getSetting(pool, 'phase26_crypto_trading_enabled');
  const updated = await setSetting(pool, 'phase26_crypto_trading_enabled', enabled, req.user!.sub);

  await createAuditLog(pool, {
    eventType: 'CRYPTO_TRADING_MODE_UPDATED',
    actorId: req.user!.sub,
    actorEmail: req.user!.email,
    entityType: 'system_setting',
    action: enabled ? 'ENABLE_CRYPTO_TRADING_MODE' : 'DISABLE_CRYPTO_TRADING_MODE',
    beforeData: before ? { key: before.key, value: before.value } : null,
    afterData: { key: updated.key, value: updated.value },
    requestId: requestId(req),
  });

  res.json({ enabled: updated.value === true, updatedAt: updated.updatedAt.toISOString() });
});
