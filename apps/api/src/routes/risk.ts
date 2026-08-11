import { Router, Request, Response } from 'express';
import { requireAuth, requireOwner } from '../auth/middleware';
import { getPool } from '../db/client';
import { createAuditLog } from '../db/repositories/audit-logs';
import { findRiskCheckById, listRiskChecks } from '../db/repositories/risk-checks';
import { getAllSettings, getSetting, setSetting } from '../db/repositories/system-settings';
import { SystemSetting } from '../db/types';

export const riskRouter = Router();

riskRouter.use(requireAuth);

const RISK_SETTING_KEYS = new Set([
  'trading_kill_switch_enabled',
  'trading_mode',
  'market_data_staleness_seconds',
  'price_drift_threshold_pct',
  'max_order_notional_usd',
  'max_position_size_usd',
  'max_portfolio_concentration_pct',
  'max_open_positions',
  'max_daily_loss_usd',
  'proposal_ttl_seconds',
  'trading_session_start',
  'trading_session_end',
  'cooldown_between_trades_seconds',
]);

const WRITABLE_RISK_SETTING_KEYS = new Set([
  'market_data_staleness_seconds',
  'price_drift_threshold_pct',
  'max_order_notional_usd',
  'max_position_size_usd',
  'max_portfolio_concentration_pct',
  'max_open_positions',
  'max_daily_loss_usd',
  'proposal_ttl_seconds',
  'trading_session_start',
  'trading_session_end',
  'cooldown_between_trades_seconds',
]);

const INTEGER_SETTING_KEYS = new Set([
  'market_data_staleness_seconds',
  'max_open_positions',
  'proposal_ttl_seconds',
  'cooldown_between_trades_seconds',
]);

const DECIMAL_SETTING_KEYS = new Set([
  'price_drift_threshold_pct',
  'max_order_notional_usd',
  'max_position_size_usd',
  'max_portfolio_concentration_pct',
  'max_daily_loss_usd',
]);

function getRequestId(req: Request): string | null {
  return (req.headers['x-request-id'] as string | undefined) ?? null;
}

function serialiseSetting(setting: SystemSetting) {
  return {
    key: setting.key,
    value: setting.value,
    description: setting.description,
    updatedAt: setting.updatedAt.toISOString(),
    updatedBy: setting.updatedBy,
  };
}

function parseLimitOffset(req: Request): { limit: number; offset: number } | null {
  const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
  const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);

  if (
    !Number.isInteger(limit)
    || !Number.isInteger(offset)
    || limit < 1
    || limit > 100
    || offset < 0
  ) {
    return null;
  }

  return { limit, offset };
}

function validateTime(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return undefined;
  return value;
}

function validateSettingValue(key: string, value: unknown): unknown | undefined {
  if (INTEGER_SETTING_KEYS.has(key)) {
    return Number.isInteger(value) && Number(value) >= 0 ? value : undefined;
  }

  if (DECIMAL_SETTING_KEYS.has(key)) {
    if (typeof value !== 'string' || !/^\d+(\.\d+)?$/.test(value)) return undefined;
    return value;
  }

  if (key === 'trading_session_start' || key === 'trading_session_end') {
    return validateTime(value);
  }

  return undefined;
}

// GET /risk/settings
riskRouter.get('/settings', async (_req: Request, res: Response) => {
  const settings = await getAllSettings(getPool());
  res.json(settings.filter((s) => RISK_SETTING_KEYS.has(s.key)).map(serialiseSetting));
});

// PUT /risk/settings/:key
riskRouter.put('/settings/:key', requireOwner, async (req: Request, res: Response) => {
  const { key } = req.params;
  if (!WRITABLE_RISK_SETTING_KEYS.has(key)) {
    res.status(422).json({ error: 'VALIDATION_ERROR', message: 'Unsupported risk setting' });
    return;
  }

  const { value } = req.body as { value?: unknown };
  const parsed = validateSettingValue(key, value);
  if (parsed === undefined) {
    res.status(422).json({ error: 'VALIDATION_ERROR', message: 'Invalid setting value' });
    return;
  }

  const pool = getPool();
  const before = await getSetting(pool, key);
  const updated = await setSetting(pool, key, parsed, req.user!.sub);

  await createAuditLog(pool, {
    eventType: 'RISK_SETTING_UPDATED',
    actorId: req.user!.sub,
    actorEmail: req.user!.email,
    entityType: 'system_setting',
    entityId: null,
    action: 'UPDATE_RISK_SETTING',
    beforeData: before ? { key: before.key, value: before.value } : null,
    afterData: { key: updated.key, value: updated.value },
    requestId: getRequestId(req),
  });

  res.json(serialiseSetting(updated));
});

// GET /risk/kill-switch
riskRouter.get('/kill-switch', async (_req: Request, res: Response) => {
  const setting = await getSetting(getPool(), 'trading_kill_switch_enabled');
  res.json({ enabled: setting?.value !== false });
});

// PUT /risk/kill-switch
riskRouter.put('/kill-switch', requireOwner, async (req: Request, res: Response) => {
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
    entityId: null,
    action: enabled ? 'ENABLE_KILL_SWITCH' : 'DISABLE_KILL_SWITCH',
    beforeData: before ? { key: before.key, value: before.value } : null,
    afterData: { key: updated.key, value: updated.value },
    requestId: getRequestId(req),
  });

  res.json({ enabled: updated.value !== false, updatedAt: updated.updatedAt.toISOString() });
});

// GET /risk/checks
riskRouter.get('/checks', async (req: Request, res: Response) => {
  const parsed = parseLimitOffset(req);
  if (!parsed) {
    res.status(422).json({ error: 'VALIDATION_ERROR', message: 'Invalid pagination' });
    return;
  }

  const checks = await listRiskChecks(getPool(), parsed.limit, parsed.offset);
  res.json(checks);
});

// GET /risk/checks/:id
riskRouter.get('/checks/:id', async (req: Request, res: Response) => {
  const check = await findRiskCheckById(getPool(), req.params.id);
  if (!check) {
    res.status(404).json({ error: 'NOT_FOUND', message: 'Risk check not found' });
    return;
  }
  res.json(check);
});
