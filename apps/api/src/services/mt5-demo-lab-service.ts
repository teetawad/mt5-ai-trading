import { Pool } from 'pg';
import { createAuditLog } from '../db/repositories/audit-logs';
import { getSettingValue } from '../db/repositories/system-settings';
import {
  analyzeMt5Symbol,
  checkMt5Order,
  getMt5Status,
  listMt5Positions,
  listMt5Symbols,
  sendMt5Order,
} from './mt5-client';
import { evaluateMt5Risk } from './mt5-risk-engine';

export interface Mt5Actor {
  actorId: string | null;
  actorEmail: string;
  requestId?: string | null;
}

export interface InstrumentFilter {
  search?: string;
  assetClass?: string;
  enabled?: boolean;
}

async function settings(pool: Pool): Promise<Record<string, unknown>> {
  const keys = [
    'mt5_auto_demo_enabled',
    'mt5_kill_switch_enabled',
    'mt5_max_risk_per_trade_pct',
    'mt5_max_loss_per_trade',
    'mt5_max_daily_loss',
    'mt5_max_drawdown_pct',
    'mt5_max_simultaneous_positions',
    'mt5_max_trades_per_day',
    'mt5_min_risk_reward',
    'mt5_max_spread_points',
    'mt5_quote_staleness_seconds',
    'mt5_allowed_deviation_points',
    'mt5_cooldown_minutes',
  ];
  const entries = await Promise.all(keys.map(async (key) => [key, await getSettingValue(pool, key)] as const));
  return Object.fromEntries(entries);
}

function assetClass(symbol: Record<string, unknown>): string {
  const path = String(symbol.path ?? symbol.description ?? '').toLowerCase();
  if (path.includes('forex') || path.includes('fx')) return 'FOREX';
  if (path.includes('metal') || String(symbol.name).toLowerCase().includes('xau')) return 'METAL';
  if (path.includes('crypto')) return 'CRYPTO_CFD';
  if (path.includes('indice') || path.includes('index')) return 'INDEX_CFD';
  if (path.includes('commod')) return 'COMMODITY_CFD';
  return 'OTHER';
}

export async function syncMt5Instruments(pool: Pool, requestId?: string) {
  const symbols = await listMt5Symbols(requestId);
  for (const symbol of symbols) {
    await pool.query(
      `INSERT INTO instruments(symbol, broker_symbol, asset_class, description, currency_base,
        currency_profit, point, trade_tick_size, trade_tick_value, volume_min, volume_max,
        volume_step, trade_stops_level, visible, raw)
       VALUES($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT(symbol) DO UPDATE SET
        asset_class=EXCLUDED.asset_class, description=EXCLUDED.description,
        point=EXCLUDED.point, trade_tick_size=EXCLUDED.trade_tick_size,
        trade_tick_value=EXCLUDED.trade_tick_value, volume_min=EXCLUDED.volume_min,
        volume_max=EXCLUDED.volume_max, volume_step=EXCLUDED.volume_step,
        trade_stops_level=EXCLUDED.trade_stops_level, visible=EXCLUDED.visible,
        raw=EXCLUDED.raw, updated_at=now()`,
      [
        symbol.name,
        assetClass(symbol as unknown as Record<string, unknown>),
        symbol.description ?? null,
        symbol.currency_base ?? null,
        symbol.currency_profit ?? null,
        symbol.point ?? null,
        symbol.trade_tick_size ?? null,
        symbol.trade_tick_value ?? null,
        symbol.volume_min ?? null,
        symbol.volume_max ?? null,
        symbol.volume_step ?? null,
        symbol.trade_stops_level ?? null,
        symbol.visible !== false,
        symbol,
      ],
    );
  }
  return { imported: symbols.length };
}

export async function listMt5Instruments(pool: Pool, filter: InstrumentFilter = {}) {
  const values: unknown[] = [];
  const where: string[] = [];

  if (filter.search?.trim()) {
    values.push(`%${filter.search.trim()}%`);
    where.push(`(i.symbol ILIKE $${values.length} OR i.description ILIKE $${values.length})`);
  }

  if (filter.assetClass && filter.assetClass !== 'ALL') {
    values.push(filter.assetClass);
    where.push(`i.asset_class = $${values.length}`);
  }

  if (typeof filter.enabled === 'boolean') {
    values.push(filter.enabled);
    where.push(`COALESCE(w.enabled, false) = $${values.length}`);
  }

  const result = await pool.query(
    `SELECT i.id, i.symbol, i.broker_symbol, i.asset_class, i.description, i.currency_base,
        i.currency_profit, i.point, i.trade_tick_size, i.trade_tick_value, i.volume_min,
        i.volume_max, i.volume_step, i.trade_stops_level, i.visible, i.updated_at,
        w.id AS watchlist_id, COALESCE(w.enabled, false) AS watchlist_enabled, w.rank
     FROM instruments i
     LEFT JOIN watchlists w ON w.symbol = i.symbol AND w.name = 'Owner MT5 Demo Watchlist'
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY COALESCE(w.enabled, false) DESC, COALESCE(w.rank, 9999) ASC, i.asset_class ASC, i.symbol ASC
     LIMIT 1000`,
    values,
  );

  return { instruments: result.rows };
}

export async function setMt5WatchlistSymbols(pool: Pool, symbols: string[], enabled: boolean, actor: Mt5Actor) {
  const cleanSymbols = [...new Set(symbols.map((symbol) => symbol.trim()).filter(Boolean))];
  if (!cleanSymbols.length) return { updated: 0, symbols: [] };

  const result = await pool.query(
    `WITH selected AS (
       SELECT symbol FROM instruments WHERE symbol = ANY($1::text[])
     ), upserted AS (
       INSERT INTO watchlists(name, symbol, enabled, rank)
       SELECT 'Owner MT5 Demo Watchlist', symbol, $2::boolean,
         row_number() OVER (ORDER BY symbol)::int
       FROM selected
       ON CONFLICT(name, symbol) DO UPDATE SET
         enabled = EXCLUDED.enabled,
         updated_at = now()
       RETURNING symbol, enabled
     )
     SELECT symbol, enabled FROM upserted ORDER BY symbol`,
    [cleanSymbols, enabled],
  );

  await createAuditLog(pool, {
    eventType: 'MT5_WATCHLIST_UPDATED',
    actorId: actor.actorId,
    actorEmail: actor.actorEmail,
    entityType: 'watchlist',
    entityId: null,
    action: enabled ? 'ENABLE_SYMBOLS' : 'DISABLE_SYMBOLS',
    afterData: { symbols: result.rows.map((row) => row.symbol), enabled },
    requestId: actor.requestId ?? null,
  });

  return { updated: result.rowCount ?? 0, symbols: result.rows };
}

export async function scannerSnapshot(pool: Pool, actor: Mt5Actor) {
  const cfg = await settings(pool);
  const status = await getMt5Status(actor.requestId ?? undefined);
  const watchlist = await pool.query(
    `SELECT i.symbol, i.asset_class
     FROM watchlists w JOIN instruments i ON i.symbol = w.symbol
     WHERE w.enabled = true ORDER BY w.rank ASC, i.symbol ASC LIMIT 25`,
  );
  const rows = [];
  const mt5Positions = await listMt5Positions(actor.requestId ?? undefined).catch(() => []);
  for (const row of watchlist.rows) {
    const decision = await analyzeMt5Symbol(row.symbol, actor.requestId ?? undefined);
    const openPositions = mt5Positions.length;
    const tradesToday = Number((await pool.query("SELECT count(*)::int AS c FROM trade_outcomes WHERE opened_at >= date_trunc('day', now())")).rows[0]?.c ?? 0);
    const risk = evaluateMt5Risk({
      decision: decision.decision,
      referenceEntry: decision.reference_entry,
      stopLoss: decision.stop_loss,
      takeProfit: decision.take_profit,
      riskReward: decision.risk_reward,
      confidence: decision.confidence,
      account: status.account,
      terminal: status.terminal,
      settings: cfg,
      openPositions,
      tradesToday,
    });
    rows.push({
      rank: rows.length + 1,
      assetClass: row.asset_class,
      freshness: decision.market_state ?? 'LIVE',
      ...decision,
      risk,
    });
  }
  return { status, autoDemoEnabled: cfg.mt5_auto_demo_enabled === true, scanner: rows };
}

export async function persistDecision(pool: Pool, decision: Awaited<ReturnType<typeof analyzeMt5Symbol>>, assetClassValue: string) {
  const feature = await pool.query(
    `INSERT INTO feature_snapshots(symbol, timeframe, signal_candle_timestamp, features)
     VALUES($1,'H1',$2,$3)
     ON CONFLICT(symbol, timeframe, signal_candle_timestamp) DO UPDATE SET features=EXCLUDED.features
     RETURNING id`,
    [decision.symbol, decision.signal_candle_timestamp, decision.features],
  );
  const saved = await pool.query(
    `INSERT INTO ai_decisions(feature_snapshot_id, symbol, asset_class, decision, confidence,
      opportunity_score, reasons, reference_entry, stop_loss, take_profit, risk_reward,
      expected_holding_hours, signal_candle_timestamp, model_version)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT(symbol, timeframe, signal_candle_timestamp, model_version) DO UPDATE SET
      decision=EXCLUDED.decision, confidence=EXCLUDED.confidence, opportunity_score=EXCLUDED.opportunity_score,
      reasons=EXCLUDED.reasons, reference_entry=EXCLUDED.reference_entry, stop_loss=EXCLUDED.stop_loss,
      take_profit=EXCLUDED.take_profit, risk_reward=EXCLUDED.risk_reward
     RETURNING *`,
    [
      feature.rows[0].id,
      decision.symbol,
      assetClassValue,
      decision.decision,
      decision.confidence,
      decision.opportunity_score,
      JSON.stringify(decision.reasons),
      decision.reference_entry,
      decision.stop_loss,
      decision.take_profit,
      decision.risk_reward,
      decision.expected_holding_hours,
      decision.signal_candle_timestamp,
      decision.model_version,
    ],
  );
  return saved.rows[0];
}

export async function runAssistedAnalysis(pool: Pool, symbol: string, actor: Mt5Actor) {
  const instrument = await pool.query('SELECT asset_class FROM instruments WHERE symbol = $1', [symbol]);
  const decision = await analyzeMt5Symbol(symbol, actor.requestId ?? undefined);
  const saved = await persistDecision(pool, decision, instrument.rows[0]?.asset_class ?? 'OTHER');
  await createAuditLog(pool, {
    eventType: 'MT5_AI_DECISION_RECORDED',
    actorId: actor.actorId,
    actorEmail: actor.actorEmail,
    entityType: 'ai_decision',
    entityId: saved.id,
    action: 'ASSISTED_ANALYSIS',
    afterData: { ...decision },
    requestId: actor.requestId ?? null,
  });
  return { decision: saved };
}

export async function executeAutoDemo(pool: Pool, symbol: string, actor: Mt5Actor) {
  const cfg = await settings(pool);
  if (cfg.mt5_auto_demo_enabled !== true) throw new Error('AUTO-DEMO is disabled');
  const status = await getMt5Status(actor.requestId ?? undefined);
  if (!status.demo_verified) throw new Error(status.blocked_reason ?? 'MT5 DEMO is not verified');
  const analysis = await runAssistedAnalysis(pool, symbol, actor);
  const decision = analysis.decision;
  const mt5Positions = await listMt5Positions(actor.requestId ?? undefined).catch(() => []);
  const openPositions = mt5Positions.length;
  const tradesToday = Number((await pool.query("SELECT count(*)::int AS c FROM trade_outcomes WHERE opened_at >= date_trunc('day', now())")).rows[0]?.c ?? 0);
  const risk = evaluateMt5Risk({
    decision: decision.decision,
    referenceEntry: decision.reference_entry,
    stopLoss: decision.stop_loss,
    takeProfit: decision.take_profit,
    riskReward: decision.risk_reward,
    confidence: Number(decision.confidence),
    account: status.account,
    terminal: status.terminal,
    settings: cfg,
    openPositions,
    tradesToday,
  });
  const riskRow = await pool.query(
    'INSERT INTO risk_evaluations(ai_decision_id, symbol, result, failed_rules, reason, snapshot) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
    [decision.id, symbol, risk.result, JSON.stringify(risk.failedRules), risk.reason, risk.snapshot],
  );
  if (risk.result !== 'PASS') return { executed: false, decision, risk: riskRow.rows[0] };
  const request = {
    idempotency_key: `mt5:${decision.id}`,
    symbol,
    side: decision.decision as 'BUY' | 'SELL',
    volume: Number(risk.recommendedVolume),
    stop_loss: Number(decision.stop_loss),
    take_profit: Number(decision.take_profit),
    deviation: Number(cfg.mt5_allowed_deviation_points ?? 20),
    comment: `MT5_DEMO_${decision.id}`,
  };
  const check = await checkMt5Order(request, actor.requestId ?? undefined);
  const result = await sendMt5Order(request, actor.requestId ?? undefined);
  await pool.query(
    `INSERT INTO trade_outcomes(symbol, ai_decision_id, order_ticket, side, volume, expected_entry,
      stop_loss, take_profit, risk_amount, risk_reward, opened_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())`,
    [
      symbol,
      decision.id,
      String(result.order ?? result.deal ?? result.request_id ?? decision.id),
      decision.decision,
      risk.recommendedVolume,
      decision.reference_entry,
      decision.stop_loss,
      decision.take_profit,
      risk.riskAmount,
      decision.risk_reward,
    ],
  );
  await createAuditLog(pool, {
    eventType: 'MT5_AUTO_DEMO_ORDER_SENT',
    actorId: actor.actorId,
    actorEmail: actor.actorEmail,
    entityType: 'ai_decision',
    entityId: decision.id,
    action: 'AUTO_DEMO_EXECUTE',
    afterData: { check, result },
    requestId: actor.requestId ?? null,
  });
  return { executed: true, decision, risk: riskRow.rows[0], check, result };
}
