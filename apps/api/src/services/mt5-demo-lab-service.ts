import { Pool } from 'pg';
import { createAuditLog } from '../db/repositories/audit-logs';
import {
  analyzeMt5Symbol,
  checkMt5Order,
  getMt5MarketStatus,
  getMt5Status,
  getMt5Tick,
  listMt5Positions,
  listMt5Symbols,
  sendMt5Order,
  Mt5DecisionDTO,
} from './mt5-client';
import { evaluateMt5Risk } from './mt5-risk-engine';
import { loadMt5RiskSettings } from '../config/mt5-risk-settings';

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

const THAILAND_TIME_ZONE = 'Asia/Bangkok';

async function settings(pool: Pool): Promise<Record<string, unknown>> {
  void pool;
  return { ...loadMt5RiskSettings() };
}

type EntryStrategy = 'MARKET_NOW' | 'PULLBACK' | 'BREAKOUT' | 'NO_ENTRY';
type EntryStatus = 'WAITING' | 'READY' | 'TRIGGERED' | 'EXPIRED' | 'CANCELLED' | 'BLOCKED' | 'EXECUTED';

type EntryPlanInput = {
  decisionId?: string;
  symbol: string;
  side: 'BUY' | 'SELL' | 'NONE';
  entryStrategy: EntryStrategy;
  currentBid?: string | null;
  currentAsk?: string | null;
  currentPrice?: string | null;
  entryZoneLow?: string | null;
  entryZoneHigh?: string | null;
  triggerPrice?: string | null;
  referenceEntry?: string | null;
  stopLoss?: string | null;
  takeProfit?: string | null;
  riskReward?: string | null;
  recommendedVolume?: string | null;
  maxPlannedLoss?: string | null;
  confidence: number;
  opportunityScore: number;
  entryReason?: string | null;
  signalCandleTimestamp: string;
  validUntil: string;
  marketStatus?: string;
  dataStatus?: string;
};

function numberOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isoValidUntil(signalCandleTimestamp: string, cfg: Record<string, unknown>, fallback?: string | null): string {
  const hours = Number(cfg.mt5_entry_plan_valid_hours ?? 2);
  const signalTime = new Date(signalCandleTimestamp);
  if (Number.isFinite(signalTime.getTime()) && Number.isFinite(hours) && hours > 0) {
    return new Date(signalTime.getTime() + hours * 60 * 60 * 1000).toISOString();
  }
  return fallback && Number.isFinite(new Date(fallback).getTime()) ? new Date(fallback).toISOString() : new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
}

function currentPriceForSide(input: { side: string; currentBid?: string | null; currentAsk?: string | null; currentPrice?: string | null }) {
  if (input.side === 'BUY') return numberOrNull(input.currentAsk ?? input.currentPrice);
  if (input.side === 'SELL') return numberOrNull(input.currentBid ?? input.currentPrice);
  return numberOrNull(input.currentPrice);
}

function computeEntryStatus(input: EntryPlanInput, now = new Date()): EntryStatus {
  if (input.entryStrategy === 'NO_ENTRY' || input.side === 'NONE') return 'BLOCKED';
  if (new Date(input.validUntil).getTime() <= now.getTime()) return 'EXPIRED';
  if (input.marketStatus && input.marketStatus !== 'OPEN') return 'BLOCKED';
  if (input.dataStatus && input.dataStatus !== 'LIVE') return 'BLOCKED';
  const current = currentPriceForSide(input);
  if (current === null) return 'BLOCKED';
  if (input.entryStrategy === 'MARKET_NOW') return 'READY';
  if (input.entryStrategy === 'PULLBACK') {
    const low = numberOrNull(input.entryZoneLow);
    const high = numberOrNull(input.entryZoneHigh);
    if (low === null || high === null) return 'BLOCKED';
    return current >= Math.min(low, high) && current <= Math.max(low, high) ? 'TRIGGERED' : 'WAITING';
  }
  const trigger = numberOrNull(input.triggerPrice);
  if (trigger === null) return 'BLOCKED';
  if (input.side === 'BUY') return current >= trigger ? 'TRIGGERED' : 'WAITING';
  return current <= trigger ? 'TRIGGERED' : 'WAITING';
}

function buildEntryPlan(decision: Mt5DecisionDTO, risk: { recommendedVolume?: string; riskAmount?: string }, cfg: Record<string, unknown>): EntryPlanInput {
  const side = decision.decision === 'BUY' || decision.decision === 'SELL' ? decision.decision : 'NONE';
  const strategy = decision.entry_strategy ?? (side === 'NONE' ? 'NO_ENTRY' : 'MARKET_NOW');
  const validUntil = isoValidUntil(decision.signal_candle_timestamp, cfg, decision.valid_until);
  const plan: EntryPlanInput = {
    symbol: decision.symbol,
    side,
    entryStrategy: strategy,
    currentBid: decision.bid ?? null,
    currentAsk: decision.ask ?? null,
    currentPrice: decision.current_price ?? (side === 'BUY' ? decision.ask : decision.bid) ?? decision.reference_entry,
    entryZoneLow: decision.entry_zone_low ?? null,
    entryZoneHigh: decision.entry_zone_high ?? null,
    triggerPrice: decision.trigger_price ?? null,
    referenceEntry: decision.reference_entry,
    stopLoss: decision.stop_loss,
    takeProfit: decision.take_profit,
    riskReward: decision.risk_reward,
    recommendedVolume: risk.recommendedVolume ?? null,
    maxPlannedLoss: risk.riskAmount ?? null,
    confidence: decision.confidence,
    opportunityScore: decision.opportunity_score,
    entryReason: decision.entry_reason ?? null,
    signalCandleTimestamp: decision.signal_candle_timestamp,
    validUntil,
    marketStatus: decision.market_status,
    dataStatus: decision.data_status,
  };
  return plan;
}

function planDto(plan: EntryPlanInput, status?: EntryStatus) {
  const currentStatus = status ?? computeEntryStatus(plan);
  return {
    side: plan.side,
    entry_strategy: plan.entryStrategy,
    current_bid: plan.currentBid ?? null,
    current_ask: plan.currentAsk ?? null,
    current_price: plan.currentPrice ?? null,
    entry_zone_low: plan.entryZoneLow ?? null,
    entry_zone_high: plan.entryZoneHigh ?? null,
    trigger_price: plan.triggerPrice ?? null,
    reference_entry: plan.referenceEntry ?? null,
    stop_loss: plan.stopLoss ?? null,
    take_profit: plan.takeProfit ?? null,
    risk_reward: plan.riskReward ?? null,
    recommended_volume: plan.recommendedVolume ?? null,
    max_planned_loss: plan.maxPlannedLoss ?? null,
    confidence: plan.confidence,
    opportunity_score: plan.opportunityScore,
    entry_reason: plan.entryReason ?? null,
    signal_candle_timestamp: plan.signalCandleTimestamp,
    valid_until: plan.validUntil,
    current_entry_status: currentStatus,
  };
}

function beginnerEntryLabel(strategy?: string): string {
  if (strategy === 'MARKET_NOW') return 'ENTER NOW';
  if (strategy === 'PULLBACK') return 'WAIT FOR PRICE';
  if (strategy === 'BREAKOUT') return 'WAIT FOR BREAKOUT';
  return 'DO NOT ENTER';
}

function blockedEntryStatus(marketStatus?: string, dataStatus?: string): string {
  if (marketStatus === 'CLOSED') return 'BLOCKED_MARKET_CLOSED';
  if (marketStatus && marketStatus !== 'OPEN') return `BLOCKED_MARKET_${marketStatus}`;
  if (dataStatus === 'STALE') return 'BLOCKED_STALE_PRICE_DATA';
  if (dataStatus && dataStatus !== 'LIVE') return `BLOCKED_DATA_${dataStatus}`;
  return 'BLOCKED';
}

function currentPriceFromDecision(decision: Mt5DecisionDTO): string | null {
  return decision.current_price ?? (decision.decision === 'BUY' ? decision.ask : decision.bid) ?? decision.reference_entry ?? null;
}

function targetProfit(riskAmount: unknown, riskReward: unknown): string | null {
  const risk = Number(riskAmount);
  const rr = Number(riskReward);
  if (!Number.isFinite(risk) || !Number.isFinite(rr)) return null;
  return (risk * rr).toFixed(2);
}

function notionalSize(price: unknown, volume: unknown): string | null {
  const current = Number(price);
  const lots = Number(volume);
  if (!Number.isFinite(current) || !Number.isFinite(lots) || lots <= 0) return null;
  return (current * lots).toFixed(2);
}

function riskPerAccount(riskAmount: unknown, account: Record<string, unknown> | null | undefined): string | null {
  const risk = Number(riskAmount);
  const equity = Number(account?.equity ?? account?.balance);
  if (!Number.isFinite(risk) || !Number.isFinite(equity) || equity <= 0) return null;
  return ((risk / equity) * 100).toFixed(2);
}

function tradeButtonDiagnostics(input: {
  status: Awaited<ReturnType<typeof getMt5Status>>;
  decision: Mt5DecisionDTO;
  risk: { result?: string; failedRules?: string[] };
  entryPlan: { current_entry_status?: string; recommended_volume?: string | null };
  marketStatus?: string;
  dataStatus?: string;
}) {
  const reasons: Array<{ rule: string; explanation: string }> = [];
  const volume = Number(input.entryPlan.recommended_volume);
  if (!input.status.demo_verified) reasons.push({ rule: 'DEMO_VERIFICATION_FAILED', explanation: input.status.blocked_reason ?? 'MT5 demo account is not verified.' });
  if (input.marketStatus !== 'OPEN') reasons.push({ rule: input.marketStatus === 'CLOSED' ? 'MARKET_CLOSED' : `MARKET_${input.marketStatus ?? 'UNKNOWN'}`, explanation: beginnerRiskReason(input.marketStatus === 'CLOSED' ? 'MARKET_CLOSED' : `BLOCKED_MARKET_${input.marketStatus ?? 'UNKNOWN'}`) });
  if (input.dataStatus !== 'LIVE') reasons.push({ rule: input.dataStatus === 'STALE' ? 'STALE_PRICE_DATA' : `DATA_${input.dataStatus ?? 'UNKNOWN'}`, explanation: beginnerRiskReason(input.dataStatus === 'STALE' ? 'STALE_DATA' : `DATA_${input.dataStatus ?? 'UNKNOWN'}`) });
  if (input.decision.decision !== 'BUY' && input.decision.decision !== 'SELL') reasons.push({ rule: 'NO_EXECUTABLE_DECISION', explanation: beginnerRiskReason('NO_EXECUTABLE_DECISION') });
  if (!['READY', 'TRIGGERED'].includes(String(input.entryPlan.current_entry_status))) reasons.push({ rule: String(input.entryPlan.current_entry_status ?? 'ENTRY_NOT_READY'), explanation: 'The entry plan is not ready to execute.' });
  if (!input.decision.stop_loss) reasons.push({ rule: 'STOP_LOSS_REQUIRED', explanation: beginnerRiskReason('STOP_LOSS_REQUIRED') });
  if (!input.decision.take_profit) reasons.push({ rule: 'TAKE_PROFIT_REQUIRED', explanation: beginnerRiskReason('TAKE_PROFIT_REQUIRED') });
  if (!Number.isFinite(volume) || volume <= 0) reasons.push({ rule: 'POSITION_SIZE_INVALID', explanation: beginnerRiskReason('POSITION_SIZE_INVALID') });
  if (input.risk.result !== 'PASS') {
    for (const rule of input.risk.failedRules ?? []) {
      if (!reasons.some((reason) => reason.rule === rule)) reasons.push({ rule, explanation: beginnerRiskReason(rule) });
    }
  }
  return {
    enabled: reasons.length === 0,
    label: reasons.length === 0 ? 'TRADE IN DEMO' : 'TRADE IN DEMO DISABLED',
    disabledReasons: reasons,
  };
}

async function persistEntryPlan(pool: Pool, decisionId: string, plan: EntryPlanInput, status = computeEntryStatus(plan)) {
  const result = await pool.query(
    `INSERT INTO mt5_entry_plans(ai_decision_id, symbol, side, entry_strategy, status,
        current_bid, current_ask, current_price, entry_zone_low, entry_zone_high,
        trigger_price, reference_entry, stop_loss, take_profit, risk_reward,
        recommended_volume, max_planned_loss, confidence, opportunity_score,
        entry_reason, signal_candle_timestamp, valid_until,
        triggered_at, expired_at, reached_trigger, time_to_trigger_seconds)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,
        CASE WHEN $5 = 'TRIGGERED' THEN now() ELSE NULL END,
        CASE WHEN $5 = 'EXPIRED' THEN now() ELSE NULL END,
        CASE WHEN $5 = 'TRIGGERED' THEN true ELSE false END,
        CASE WHEN $5 = 'TRIGGERED' THEN GREATEST(0, EXTRACT(EPOCH FROM (now() - $21::timestamptz)))::int ELSE NULL END)
     ON CONFLICT(ai_decision_id) DO UPDATE SET
        status=EXCLUDED.status,
        current_bid=EXCLUDED.current_bid,
        current_ask=EXCLUDED.current_ask,
        current_price=EXCLUDED.current_price,
        entry_zone_low=EXCLUDED.entry_zone_low,
        entry_zone_high=EXCLUDED.entry_zone_high,
        trigger_price=EXCLUDED.trigger_price,
        reference_entry=EXCLUDED.reference_entry,
        stop_loss=EXCLUDED.stop_loss,
        take_profit=EXCLUDED.take_profit,
        risk_reward=EXCLUDED.risk_reward,
        recommended_volume=EXCLUDED.recommended_volume,
        max_planned_loss=EXCLUDED.max_planned_loss,
        confidence=EXCLUDED.confidence,
        opportunity_score=EXCLUDED.opportunity_score,
        entry_reason=EXCLUDED.entry_reason,
        valid_until=EXCLUDED.valid_until,
        triggered_at=COALESCE(mt5_entry_plans.triggered_at, EXCLUDED.triggered_at),
        expired_at=COALESCE(mt5_entry_plans.expired_at, EXCLUDED.expired_at),
        reached_trigger=mt5_entry_plans.reached_trigger OR EXCLUDED.reached_trigger,
        time_to_trigger_seconds=COALESCE(mt5_entry_plans.time_to_trigger_seconds, EXCLUDED.time_to_trigger_seconds),
        updated_at=now()
     RETURNING *`,
    [
      decisionId,
      plan.symbol,
      plan.side,
      plan.entryStrategy,
      status,
      plan.currentBid ?? null,
      plan.currentAsk ?? null,
      plan.currentPrice ?? null,
      plan.entryZoneLow ?? null,
      plan.entryZoneHigh ?? null,
      plan.triggerPrice ?? null,
      plan.referenceEntry ?? null,
      plan.stopLoss ?? null,
      plan.takeProfit ?? null,
      plan.riskReward ?? null,
      plan.recommendedVolume ?? null,
      plan.maxPlannedLoss ?? null,
      plan.confidence,
      plan.opportunityScore,
      plan.entryReason ?? null,
      plan.signalCandleTimestamp,
      plan.validUntil,
    ],
  );
  return result.rows[0];
}

function assetClass(symbol: Record<string, unknown>): string {
  const path = String(symbol.path ?? symbol.description ?? '').toLowerCase();
  const name = String(symbol.name ?? '').toLowerCase();
  if (path.includes('forex') || path.includes('fx')) return 'FOREX';
  if (path.includes('stock') || path.includes('share') || path.includes('equit')) return 'STOCK';
  if (path.includes('metal') || name.includes('xau') || name.includes('xag')) return 'METAL';
  if (path.includes('crypto') || ['btc', 'eth', 'sol', 'ltc', 'xrp'].some((token) => name.includes(token))) return 'CRYPTO_CFD';
  if (path.includes('indice') || path.includes('index')) return 'INDEX_CFD';
  if (path.includes('commod')) return 'COMMODITY_CFD';
  return 'OTHER';
}

function money(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function resultType(value: unknown): 'WIN' | 'LOSS' | 'BREAKEVEN' | 'OPEN' {
  if (value === null || value === undefined) return 'OPEN';
  const pnl = Number(value);
  if (pnl > 0) return 'WIN';
  if (pnl < 0) return 'LOSS';
  return 'BREAKEVEN';
}

function formatThaiTime(value: unknown): string | null {
  if (!value) return null;
  const date = new Date(String(value));
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: THAILAND_TIME_ZONE,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function countdownTo(value: unknown): string | null {
  if (!value) return null;
  const target = new Date(String(value)).getTime();
  if (!Number.isFinite(target)) return null;
  const minutes = Math.max(0, Math.round((target - Date.now()) / 60000));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours > 0 ? `${hours}h ${rest}m` : `${rest}m`;
}

function beginnerRiskReason(value: string): string {
  const map: Record<string, string> = {
    SAFETY_SWITCH_ON: 'Demo safety switch is on, so new trades are blocked.',
    MARKET_CLOSED: 'The market is closed now.',
    STALE_DATA: 'The latest price is too old.',
    STALE_QUOTE: 'MT5 quote is stale.',
    NO_EXECUTABLE_DECISION: 'AI says wait, so there is no entry.',
    STOP_LOSS_REQUIRED: 'Stop Loss is missing.',
    TAKE_PROFIT_REQUIRED: 'Take Profit is missing.',
    RISK_REWARD_TOO_LOW: 'The planned reward is too small compared with the risk.',
    MAX_SIMULTANEOUS_POSITIONS: 'Too many demo trades are already open.',
    MAX_TRADES_PER_DAY: 'Daily demo trade limit has been reached.',
    MARGIN_INSUFFICIENT: 'Not enough free demo margin.',
    POSITION_SIZE_INVALID: 'The calculated lot size is not valid.',
    SPREAD_TOO_HIGH: 'The spread is too expensive right now.',
  };
  return map[value] ?? value.replaceAll('_', ' ').toLowerCase();
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

export async function scannerSnapshot(pool: Pool, actor: Mt5Actor, persist = false) {
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
      quoteAgeSeconds: decision.quote_age_seconds ?? undefined,
      marketStatus: decision.market_status,
      dataStatus: decision.data_status,
    });
    const entryPlan = buildEntryPlan(decision, risk, cfg);
    const entryStatus = computeEntryStatus(entryPlan);
    if (persist) {
      const saved = await persistDecision(pool, decision, row.asset_class);
      await persistEntryPlan(pool, saved.id, entryPlan, entryStatus);
    }
    rows.push({
      rank: rows.length + 1,
      assetClass: row.asset_class,
      freshness: decision.data_status ?? decision.market_state ?? 'LIVE',
      ...decision,
      risk,
      entry_plan: planDto(entryPlan, entryStatus),
    });
  }
  const openMarkets = rows.filter((row) => row.market_status === 'OPEN').length;
  const nextMarket = rows
    .filter((row) => typeof row.next_session_open === 'string' && row.next_session_open.length > 0)
    .sort((a, b) => String(a.next_session_open).localeCompare(String(b.next_session_open)))[0] ?? null;
  return {
    status,
    autoDemoEnabled: cfg.mt5_auto_demo_enabled === true,
    scanner: rows,
    watchlistMarketSummary: {
      open: openMarkets,
      total: rows.length,
      nextMarketOpen: nextMarket?.next_session_open ?? null,
      nextMarketOpenSymbol: nextMarket?.symbol ?? null,
      nextMarketOpenLocal: nextMarket?.next_session_open
        ? new Date(nextMarket.next_session_open).toLocaleString()
        : null,
      nextH1Analysis: openMarkets > 0 ? nextCompletedH1Timestamp() : null,
    },
  };
}

function nextCompletedH1Timestamp(): string {
  const now = new Date();
  const next = new Date(now);
  next.setUTCMinutes(0, 0, 0);
  next.setUTCHours(next.getUTCHours() + 1);
  return next.toISOString();
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
  const cfg = await settings(pool);
  const status = await getMt5Status(actor.requestId ?? undefined);
  const instrument = await pool.query('SELECT asset_class FROM instruments WHERE symbol = $1', [symbol]);
  const decision = await analyzeMt5Symbol(symbol, actor.requestId ?? undefined);
  const saved = await persistDecision(pool, decision, instrument.rows[0]?.asset_class ?? 'OTHER');
  const mt5Positions = await listMt5Positions(actor.requestId ?? undefined).catch(() => []);
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
    openPositions: mt5Positions.length,
    tradesToday,
    quoteAgeSeconds: decision.quote_age_seconds ?? undefined,
    marketStatus: decision.market_status,
    dataStatus: decision.data_status,
  });
  const entryPlan = buildEntryPlan(decision, risk, cfg);
  const savedPlan = await persistEntryPlan(pool, saved.id, entryPlan);
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
  return { decision: saved, entryPlan: savedPlan };
}

export async function getMt5AnalysisDetail(pool: Pool, symbol: string, actor: Mt5Actor, persist = false) {
  const cfg = await settings(pool);
  const [status, instrumentResult, mt5Positions] = await Promise.all([
    getMt5Status(actor.requestId ?? undefined),
    pool.query('SELECT asset_class, description FROM instruments WHERE symbol = $1', [symbol]),
    listMt5Positions(actor.requestId ?? undefined).catch(() => []),
  ]);
  const decision = await analyzeMt5Symbol(symbol, actor.requestId ?? undefined);
  const assetClassValue = instrumentResult.rows[0]?.asset_class ?? decision.market?.asset_class ?? 'OTHER';
  const tradesToday = Number((await pool.query("SELECT count(*)::int AS c FROM trade_outcomes WHERE opened_at >= date_trunc('day', now())")).rows[0]?.c ?? 0);
  const marketStatus = decision.market_status ?? 'UNKNOWN';
  const dataStatus = decision.data_status ?? 'DISCONNECTED';
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
    openPositions: mt5Positions.length,
    tradesToday,
    quoteAgeSeconds: decision.quote_age_seconds ?? undefined,
    spreadPoints: Number.isFinite(Number(decision.spread)) ? Number(decision.spread) : undefined,
    marketStatus: marketStatus as 'OPEN' | 'CLOSED' | 'QUOTE_ONLY' | 'TRADE_DISABLED' | 'UNKNOWN',
    dataStatus: dataStatus as 'LIVE' | 'STALE' | 'DISCONNECTED',
  });
  const entryPlanInput = buildEntryPlan(decision, risk, cfg);
  const rawEntryStatus = computeEntryStatus(entryPlanInput);
  const entryStatus = rawEntryStatus === 'BLOCKED' ? blockedEntryStatus(marketStatus, dataStatus) : rawEntryStatus;
  const entryPlan = { ...planDto(entryPlanInput, rawEntryStatus), current_entry_status: entryStatus };
  let savedDecision: Record<string, unknown> | null = null;
  let savedPlan: Record<string, unknown> | null = null;
  if (persist) {
    const persistedDecision = await persistDecision(pool, decision, String(assetClassValue));
    savedDecision = persistedDecision;
    savedPlan = await persistEntryPlan(pool, String(persistedDecision.id), entryPlanInput, rawEntryStatus);
    await createAuditLog(pool, {
      eventType: 'MT5_AI_DECISION_RECORDED',
      actorId: actor.actorId,
      actorEmail: actor.actorEmail,
      entityType: 'ai_decision',
      entityId: String(persistedDecision.id),
      action: 'ASSISTED_ANALYSIS',
      afterData: { ...decision },
      requestId: actor.requestId ?? null,
    });
  }
  const currentPrice = currentPriceFromDecision(decision);
  const riskAmount = risk.riskAmount;
  const sizing = {
    recommendedLotSize: risk.recommendedVolume,
    approximateNotional: notionalSize(currentPrice, risk.recommendedVolume),
    maximumPlannedLoss: riskAmount,
    targetProfit: targetProfit(riskAmount, decision.risk_reward),
    riskPerAccountPct: riskPerAccount(riskAmount, status.account),
    source: 'SERVER_SIDE_RISK_ENGINE',
  };
  const tradeButton = tradeButtonDiagnostics({ status, decision, risk, entryPlan, marketStatus, dataStatus });
  const explanation = {
    title: decision.decision === 'BUY' || decision.decision === 'SELL'
      ? `AI recommends ${decision.decision}`
      : 'AI recommends WAIT',
    bullets: (decision.reasons?.length ? decision.reasons : ['Conditions are not suitable yet.']).map((reason) => String(reason).replaceAll('_', ' ')).slice(0, 8),
    beginnerSummary: decision.decision === 'BUY' || decision.decision === 'SELL'
      ? 'AI found a possible setup, but the demo trade is allowed only if the Risk Engine passes.'
      : 'There is no safe executable setup right now.',
  };
  return {
    generatedAt: new Date().toISOString(),
    timezone: THAILAND_TIME_ZONE,
    status,
    symbol,
    assetClass: assetClassValue,
    market: {
      status: marketStatus,
      dataStatus,
      sessionOpen: decision.session_open ?? null,
      sessionClose: decision.session_close ?? null,
      nextOpen: decision.next_session_open ?? null,
      nextClose: decision.market?.next_session_close ?? decision.session_close ?? null,
      serverTime: decision.server_time ?? null,
      thailandTime: formatThaiTime(decision.local_time ?? new Date().toISOString()),
      sessionOpenThailand: formatThaiTime(decision.session_open),
      sessionCloseThailand: formatThaiTime(decision.session_close),
      nextOpenThailand: formatThaiTime(decision.next_session_open),
      nextCloseThailand: formatThaiTime(decision.market?.next_session_close ?? decision.session_close),
      opensIn: marketStatus === 'OPEN' ? null : countdownTo(decision.next_session_open),
      closesIn: marketStatus === 'OPEN' ? countdownTo(decision.session_close) : null,
      source: decision.source ?? decision.market?.source ?? 'MT5_BROKER_SESSION',
      reason: decision.market?.reason ?? null,
    },
    quote: {
      bid: decision.bid ?? null,
      ask: decision.ask ?? null,
      currentPrice,
      spread: decision.spread ?? null,
      quoteTimestamp: decision.quote_timestamp ?? null,
      quoteAgeSeconds: decision.quote_age_seconds ?? null,
    },
    decision: {
      id: savedDecision?.id ?? null,
      action: decision.decision === 'BUY' || decision.decision === 'SELL' ? decision.decision : 'WAIT',
      rawDecision: decision.decision,
      confidence: decision.confidence,
      opportunityScore: decision.opportunity_score,
      modelVersion: decision.model_version,
      expectedHoldingHours: decision.expected_holding_hours,
      signalCandleTimestamp: decision.signal_candle_timestamp,
      features: decision.features,
    },
    entryPlan: {
      id: savedPlan?.id ?? null,
      ...entryPlan,
      beginner_label: beginnerEntryLabel(entryPlan.entry_strategy),
      status_label: entryStatus === 'READY' || entryStatus === 'TRIGGERED' ? 'READY NOW' : entryStatus,
    },
    protection: {
      stopLoss: decision.stop_loss,
      takeProfit: decision.take_profit,
      riskReward: decision.risk_reward,
    },
    positionSizing: sizing,
    risk: {
      ...risk,
      label: risk.result === 'PASS' ? 'RISK CHECK: PASS' : 'TRADE BLOCKED',
      diagnostics: (risk.failedRules ?? []).map((rule) => ({ rule, explanation: beginnerRiskReason(rule) })),
    },
    explanation,
    tradeButton,
  };
}

type DemoExecutionMode = 'AUTO_DEMO' | 'ASSISTED_DEMO';

async function executeDemoTrade(pool: Pool, symbol: string, actor: Mt5Actor, mode: DemoExecutionMode) {
  const cfg = await settings(pool);
  if (mode === 'AUTO_DEMO' && cfg.mt5_auto_demo_enabled !== true) throw new Error('AUTO-DEMO is disabled');
  const status = await getMt5Status(actor.requestId ?? undefined);
  if (!status.demo_verified) throw new Error(status.blocked_reason ?? 'MT5 DEMO is not verified');
  const analysis = await runAssistedAnalysis(pool, symbol, actor);
  const decision = analysis.decision;
  const entryPlanStatus = String(analysis.entryPlan.status ?? 'BLOCKED') as EntryStatus;
  if (!['READY', 'TRIGGERED'].includes(entryPlanStatus)) {
    return {
      executed: false,
      decision,
      entryPlan: analysis.entryPlan,
      reason: `Entry plan is ${entryPlanStatus}; execution is not allowed yet.`,
    };
  }
  const market = await getMt5MarketStatus(symbol, actor.requestId ?? undefined);
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
    quoteAgeSeconds: typeof market.quote_age_seconds === 'number' ? market.quote_age_seconds : undefined,
    marketStatus: market.market_status as 'OPEN' | 'CLOSED' | 'QUOTE_ONLY' | 'TRADE_DISABLED' | 'UNKNOWN' | undefined,
    dataStatus: market.data_status as 'LIVE' | 'STALE' | 'DISCONNECTED' | undefined,
  });
  const riskRow = await pool.query(
    'INSERT INTO risk_evaluations(ai_decision_id, symbol, result, failed_rules, reason, snapshot) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
    [decision.id, symbol, risk.result, JSON.stringify(risk.failedRules), risk.reason, risk.snapshot],
  );
  if (risk.result !== 'PASS') {
    await pool.query('UPDATE mt5_entry_plans SET status = $1, updated_at = now() WHERE ai_decision_id = $2', ['BLOCKED', decision.id]);
    return { executed: false, decision, entryPlan: analysis.entryPlan, risk: riskRow.rows[0] };
  }
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
  await pool.query('UPDATE mt5_entry_plans SET status = $1, executed_at = now(), updated_at = now() WHERE ai_decision_id = $2', ['EXECUTED', decision.id]);
  await createAuditLog(pool, {
    eventType: mode === 'AUTO_DEMO' ? 'MT5_AUTO_DEMO_ORDER_SENT' : 'MT5_ASSISTED_DEMO_ORDER_SENT',
    actorId: actor.actorId,
    actorEmail: actor.actorEmail,
    entityType: 'ai_decision',
    entityId: decision.id,
    action: mode === 'AUTO_DEMO' ? 'AUTO_DEMO_EXECUTE' : 'ASSISTED_DEMO_EXECUTE',
    afterData: { check, result },
    requestId: actor.requestId ?? null,
  });
  return { executed: true, decision, entryPlan: { ...analysis.entryPlan, status: 'EXECUTED' }, risk: riskRow.rows[0], check, result };
}

export async function executeAssistedDemo(pool: Pool, symbol: string, actor: Mt5Actor) {
  return executeDemoTrade(pool, symbol, actor, 'ASSISTED_DEMO');
}

export async function executeAutoDemo(pool: Pool, symbol: string, actor: Mt5Actor) {
  return executeDemoTrade(pool, symbol, actor, 'AUTO_DEMO');
}

function dbPlanToInput(row: Record<string, unknown>, tick: Record<string, unknown>, market: Record<string, unknown>): EntryPlanInput {
  const side = String(row.side) === 'BUY' || String(row.side) === 'SELL' ? String(row.side) as 'BUY' | 'SELL' : 'NONE';
  return {
    decisionId: String(row.ai_decision_id),
    symbol: String(row.symbol),
    side,
    entryStrategy: String(row.entry_strategy) as EntryStrategy,
    currentBid: tick.bid !== undefined ? String(tick.bid) : row.current_bid ? String(row.current_bid) : null,
    currentAsk: tick.ask !== undefined ? String(tick.ask) : row.current_ask ? String(row.current_ask) : null,
    currentPrice: row.current_price ? String(row.current_price) : null,
    entryZoneLow: row.entry_zone_low ? String(row.entry_zone_low) : null,
    entryZoneHigh: row.entry_zone_high ? String(row.entry_zone_high) : null,
    triggerPrice: row.trigger_price ? String(row.trigger_price) : null,
    referenceEntry: row.reference_entry ? String(row.reference_entry) : null,
    stopLoss: row.stop_loss ? String(row.stop_loss) : null,
    takeProfit: row.take_profit ? String(row.take_profit) : null,
    riskReward: row.risk_reward ? String(row.risk_reward) : null,
    recommendedVolume: row.recommended_volume ? String(row.recommended_volume) : null,
    maxPlannedLoss: row.max_planned_loss ? String(row.max_planned_loss) : null,
    confidence: Number(row.confidence ?? 0),
    opportunityScore: Number(row.opportunity_score ?? 0),
    entryReason: row.entry_reason ? String(row.entry_reason) : null,
    signalCandleTimestamp: new Date(String(row.signal_candle_timestamp)).toISOString(),
    validUntil: new Date(String(row.valid_until)).toISOString(),
    marketStatus: String(market.market_status ?? 'UNKNOWN'),
    dataStatus: String(market.data_status ?? 'DISCONNECTED'),
  };
}

async function refreshStoredEntryPlan(pool: Pool, row: Record<string, unknown>, actor: Mt5Actor) {
  const [tick, market] = await Promise.all([
    getMt5Tick(String(row.symbol), actor.requestId ?? undefined).catch(() => ({})),
    getMt5MarketStatus(String(row.symbol), actor.requestId ?? undefined).catch(() => ({})),
  ]);
  const plan = dbPlanToInput(row, tick, market);
  const current = currentPriceForSide(plan);
  const updated = current === null ? plan : { ...plan, currentPrice: String(current) };
  const status = computeEntryStatus(updated);
  const saved = await persistEntryPlan(pool, String(row.ai_decision_id), updated, status);
  return { plan: saved, status };
}

export async function listActiveEntryPlans(pool: Pool, actor: Mt5Actor) {
  const result = await pool.query(
    `SELECT * FROM mt5_entry_plans
     WHERE status IN ('WAITING','READY','TRIGGERED','BLOCKED')
       AND valid_until >= now() - interval '1 hour'
     ORDER BY created_at DESC
     LIMIT 100`,
  );
  const plans = [];
  for (const row of result.rows) {
    plans.push((await refreshStoredEntryPlan(pool, row, actor)).plan);
  }
  return { plans };
}

async function executeTriggeredPlan(pool: Pool, planRow: Record<string, unknown>, actor: Mt5Actor) {
  const cfg = await settings(pool);
  const status = await getMt5Status(actor.requestId ?? undefined);
  if (!status.demo_verified) throw new Error(status.blocked_reason ?? 'MT5 DEMO is not verified');
  const decisionResult = await pool.query('SELECT * FROM ai_decisions WHERE id = $1', [planRow.ai_decision_id]);
  const decision = decisionResult.rows[0];
  if (!decision) return { executed: false, reason: 'AI decision not found', entryPlan: planRow };
  const market = await getMt5MarketStatus(String(planRow.symbol), actor.requestId ?? undefined);
  const mt5Positions = await listMt5Positions(actor.requestId ?? undefined).catch(() => []);
  const tradesToday = Number((await pool.query("SELECT count(*)::int AS c FROM trade_outcomes WHERE opened_at >= date_trunc('day', now())")).rows[0]?.c ?? 0);
  const risk = evaluateMt5Risk({
    decision: decision.decision,
    referenceEntry: String(decision.reference_entry),
    stopLoss: decision.stop_loss ? String(decision.stop_loss) : null,
    takeProfit: decision.take_profit ? String(decision.take_profit) : null,
    riskReward: decision.risk_reward ? String(decision.risk_reward) : null,
    confidence: Number(decision.confidence),
    account: status.account,
    terminal: status.terminal,
    settings: cfg,
    openPositions: mt5Positions.length,
    tradesToday,
    quoteAgeSeconds: typeof market.quote_age_seconds === 'number' ? market.quote_age_seconds : undefined,
    marketStatus: market.market_status as 'OPEN' | 'CLOSED' | 'QUOTE_ONLY' | 'TRADE_DISABLED' | 'UNKNOWN' | undefined,
    dataStatus: market.data_status as 'LIVE' | 'STALE' | 'DISCONNECTED' | undefined,
  });
  const riskRow = await pool.query(
    'INSERT INTO risk_evaluations(ai_decision_id, symbol, result, failed_rules, reason, snapshot) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
    [decision.id, planRow.symbol, risk.result, JSON.stringify(risk.failedRules), risk.reason, risk.snapshot],
  );
  if (risk.result !== 'PASS') {
    await pool.query('UPDATE mt5_entry_plans SET status = $1, updated_at = now() WHERE id = $2', ['BLOCKED', planRow.id]);
    return { executed: false, entryPlan: planRow, risk: riskRow.rows[0] };
  }
  const request = {
    idempotency_key: `mt5-entry-plan:${planRow.id}`,
    symbol: String(planRow.symbol),
    side: decision.decision as 'BUY' | 'SELL',
    volume: Number(risk.recommendedVolume),
    stop_loss: Number(decision.stop_loss),
    take_profit: Number(decision.take_profit),
    deviation: Number(cfg.mt5_allowed_deviation_points ?? 20),
    comment: `MT5_PLAN_${planRow.id}`,
  };
  const check = await checkMt5Order(request, actor.requestId ?? undefined);
  const result = await sendMt5Order(request, actor.requestId ?? undefined);
  await pool.query(
    `INSERT INTO trade_outcomes(symbol, ai_decision_id, order_ticket, side, volume, expected_entry,
      stop_loss, take_profit, risk_amount, risk_reward, opened_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())`,
    [
      planRow.symbol,
      decision.id,
      String(result.order ?? result.deal ?? result.request_id ?? planRow.id),
      decision.decision,
      risk.recommendedVolume,
      decision.reference_entry,
      decision.stop_loss,
      decision.take_profit,
      risk.riskAmount,
      decision.risk_reward,
    ],
  );
  await pool.query('UPDATE mt5_entry_plans SET status = $1, executed_at = now(), updated_at = now() WHERE id = $2', ['EXECUTED', planRow.id]);
  await createAuditLog(pool, {
    eventType: 'MT5_ENTRY_PLAN_EXECUTED',
    actorId: actor.actorId,
    actorEmail: actor.actorEmail,
    entityType: 'mt5_entry_plan',
    entityId: String(planRow.id),
    action: 'ENTRY_PLAN_EXECUTE',
    afterData: { check, result },
    requestId: actor.requestId ?? null,
  });
  return { executed: true, entryPlan: { ...planRow, status: 'EXECUTED' }, risk: riskRow.rows[0], check, result };
}

export async function processMt5EntryPlans(pool: Pool, actor: Mt5Actor, autoDemoEnabled: boolean) {
  const result = await pool.query(
    `SELECT * FROM mt5_entry_plans
     WHERE status IN ('WAITING','READY','TRIGGERED')
     ORDER BY created_at ASC
     LIMIT 50`,
  );
  const outcomes = [];
  for (const row of result.rows) {
    const refreshed = await refreshStoredEntryPlan(pool, row, actor);
    if (refreshed.status === 'TRIGGERED' && autoDemoEnabled) {
      outcomes.push(await executeTriggeredPlan(pool, refreshed.plan, actor));
    } else {
      outcomes.push({ executed: false, entryPlan: refreshed.plan });
    }
  }
  return { processed: outcomes.length, outcomes };
}

export async function listMt5TradeHistory(pool: Pool) {
  const result = await pool.query(
    `SELECT t.id, t.symbol, i.asset_class, t.order_ticket, t.side, t.volume, t.expected_entry,
        t.actual_entry, t.stop_loss, t.take_profit, t.risk_amount, t.risk_reward,
        t.spread, t.slippage, t.exit_reason, t.realized_pnl, t.fees, t.mfe, t.mae,
        t.opened_at, t.closed_at,
        d.decision, d.confidence, d.opportunity_score, d.model_version, d.reasons
     FROM trade_outcomes t
     LEFT JOIN ai_decisions d ON d.id = t.ai_decision_id
     LEFT JOIN instruments i ON i.symbol = t.symbol
     ORDER BY COALESCE(t.closed_at, t.opened_at) DESC
     LIMIT 100`,
  );
  const trades = result.rows.map((trade) => ({
    ...trade,
    result_type: resultType(trade.realized_pnl),
    beginner_note: trade.closed_at
      ? `${trade.symbol} closed as ${resultType(trade.realized_pnl).toLowerCase()}${trade.exit_reason ? ` by ${String(trade.exit_reason).replaceAll('_', ' ').toLowerCase()}` : ''}.`
      : `${trade.symbol} is still open or not reconciled yet.`,
  }));
  return { trades, statistics: summarizeTrades(trades) };
}

function summarizeTrades(trades: Array<Record<string, unknown>>) {
  const closed = trades.filter((trade) => trade.closed_at);
  const wins = closed.filter((trade) => money(trade.realized_pnl) > 0);
  const losses = closed.filter((trade) => money(trade.realized_pnl) < 0);
  const totalPnl = closed.reduce((sum, trade) => sum + money(trade.realized_pnl), 0);
  const avg = (rows: Array<Record<string, unknown>>) => rows.length
    ? rows.reduce((sum, trade) => sum + money(trade.realized_pnl), 0) / rows.length
    : 0;
  const bySymbol = new Map<string, number>();
  const byAssetClass = new Map<string, number>();
  const exits = new Map<string, number>();
  for (const trade of closed) {
    bySymbol.set(String(trade.symbol), (bySymbol.get(String(trade.symbol)) ?? 0) + money(trade.realized_pnl));
    byAssetClass.set(String(trade.asset_class ?? 'OTHER'), (byAssetClass.get(String(trade.asset_class ?? 'OTHER')) ?? 0) + money(trade.realized_pnl));
    exits.set(String(trade.exit_reason ?? 'OTHER'), (exits.get(String(trade.exit_reason ?? 'OTHER')) ?? 0) + 1);
  }
  const sortedSymbols = [...bySymbol.entries()].sort((a, b) => b[1] - a[1]);
  const sortedTrades = [...closed].sort((a, b) => money(b.realized_pnl) - money(a.realized_pnl));
  return {
    totalClosedTrades: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length ? wins.length / closed.length : 0,
    totalPnl,
    averageWin: avg(wins),
    averageLoss: avg(losses),
    bestTrade: sortedTrades[0] ?? null,
    worstTrade: sortedTrades.at(-1) ?? null,
    bestPerformingSymbol: sortedSymbols[0]?.[0] ?? null,
    worstPerformingSymbol: sortedSymbols.at(-1)?.[0] ?? null,
    pnlBySymbol: sortedSymbols.map(([label, value]) => ({ label, value })),
    pnlByAssetClass: [...byAssetClass.entries()].map(([label, value]) => ({ label, value })),
    exitReasons: [...exits.entries()].map(([label, value]) => ({ label, value })),
    equityCurve: closed
      .slice()
      .reverse()
      .reduce<Array<{ label: string; value: number }>>((points, trade) => {
        const previous = points.at(-1)?.value ?? 0;
        points.push({ label: String(trade.closed_at), value: previous + money(trade.realized_pnl) });
        return points;
      }, []),
  };
}

export async function getMt5Dashboard(pool: Pool, actor: Mt5Actor) {
  const [status, mt5Positions, history, scanner] = await Promise.all([
    getMt5Status(actor.requestId ?? undefined),
    listMt5Positions(actor.requestId ?? undefined).catch(() => []),
    listMt5TradeHistory(pool),
    scannerSnapshot(pool, actor).catch(() => null),
  ]);
  const closedTrades = history.trades.filter((trade) => trade.closed_at);
  const wins = closedTrades.filter((trade) => money(trade.realized_pnl) > 0);
  const losses = closedTrades.filter((trade) => money(trade.realized_pnl) < 0);
  const todayKey = new Date().toISOString().slice(0, 10);
  const todayPnl = closedTrades
    .filter((trade) => String(trade.closed_at).slice(0, 10) === todayKey)
    .reduce((sum, trade) => sum + money(trade.realized_pnl), 0);
  const unrealizedPnl = mt5Positions.reduce((sum, position) => sum + money(position.profit), 0);
  const marginUsed = money(status.account?.margin ?? status.account?.margin_used);
  const topOpportunities = (scanner?.scanner ?? [])
    .slice()
    .sort((a, b) => Number(b.opportunity_score ?? 0) - Number(a.opportunity_score ?? 0))
    .slice(0, 3);
  const portfolioBySymbol = new Map<string, { symbol: string; positions: number; volume: number; unrealizedPnl: number }>();
  for (const position of mt5Positions) {
    const symbol = String(position.symbol ?? 'UNKNOWN');
    const current = portfolioBySymbol.get(symbol) ?? { symbol, positions: 0, volume: 0, unrealizedPnl: 0 };
    current.positions += 1;
    current.volume += money(position.volume);
    current.unrealizedPnl += money(position.profit);
    portfolioBySymbol.set(symbol, current);
  }
  return {
    status,
    account: {
      balance: money(status.account?.balance),
      equity: money(status.account?.equity),
      freeMargin: money(status.account?.free_margin ?? status.account?.margin_free),
      usedMargin: marginUsed,
      realizedPnl: closedTrades.reduce((sum, trade) => sum + money(trade.realized_pnl), 0),
      unrealizedPnl,
      todayPnl,
    },
    statistics: {
      openTrades: mt5Positions.length,
      winRate: closedTrades.length ? wins.length / closedTrades.length : 0,
      totalClosedTrades: closedTrades.length,
      totalWins: wins.length,
      totalLosses: losses.length,
    },
    portfolioBySymbol: [...portfolioBySymbol.values()],
    charts: history.statistics,
    marketSummary: scanner?.watchlistMarketSummary ?? { open: 0, total: 0, nextMarketOpen: null },
    aiReady: Boolean(status.connected && status.demo_verified && (scanner?.scanner.length ?? 0) > 0),
    topOpportunities,
  };
}

function recommendationScore(row: Record<string, unknown>): number {
  let score = 0;
  if (row.market_status === 'OPEN') score += 35;
  if (row.data_status === 'LIVE') score += 25;
  if ((row.risk as { result?: string } | undefined)?.result === 'PASS') score += 20;
  score += Math.min(20, Number(row.opportunity_score ?? 0) / 5);
  return Math.round(score);
}

function marketRecommendationReason(row: Record<string, unknown>): string {
  if (row.market_status !== 'OPEN') return 'Not recommended now because the market is not open.';
  if (row.data_status !== 'LIVE') return 'Not recommended now because price data is not fresh.';
  if ((row.risk as { result?: string } | undefined)?.result !== 'PASS') {
    const failed = ((row.risk as { failedRules?: string[] } | undefined)?.failedRules ?? [])[0];
    return `Watch only: ${beginnerRiskReason(failed ?? 'risk engine is not ready')}`;
  }
  return 'Recommended to watch now because market, data, AI, and risk checks are ready.';
}

export async function getMt5MarketHours(pool: Pool, actor: Mt5Actor) {
  const snapshot = await scannerSnapshot(pool, actor).catch(async () => {
    const instruments = await listMt5Instruments(pool, { enabled: true });
    return { scanner: instruments.instruments.map((instrument) => ({
      symbol: instrument.symbol,
      assetClass: instrument.asset_class,
      market_status: 'UNKNOWN',
      data_status: 'DISCONNECTED',
      opportunity_score: 0,
    })) };
  });
  const markets = snapshot.scanner.map((row: Record<string, unknown>) => ({
    symbol: row.symbol,
    assetClass: row.assetClass,
    status: row.market_status ?? 'UNKNOWN',
    dataStatus: row.data_status ?? 'UNKNOWN',
    sessionOpen: row.session_open ?? null,
    sessionClose: row.session_close ?? null,
    nextOpen: row.next_session_open ?? null,
    nextClose: row.next_session_close ?? row.session_close ?? null,
    sessionOpenThailand: formatThaiTime(row.session_open),
    sessionCloseThailand: formatThaiTime(row.session_close),
    nextOpenThailand: formatThaiTime(row.next_session_open),
    nextCloseThailand: formatThaiTime(row.next_session_close ?? row.session_close),
    countdown: row.market_status === 'OPEN' ? countdownTo(row.session_close) : countdownTo(row.next_session_open),
    recommendationScore: recommendationScore(row),
    recommendation: marketRecommendationReason(row),
    uncertainty: row.market_status === 'UNKNOWN' ? 'MT5 session metadata is incomplete for this symbol.' : null,
  }));
  const recommended = markets
    .slice()
    .sort((a, b) => b.recommendationScore - a.recommendationScore)
    .slice(0, 10);
  return {
    timezone: THAILAND_TIME_ZONE,
    generatedAt: new Date().toISOString(),
    markets,
    recommended,
  };
}
