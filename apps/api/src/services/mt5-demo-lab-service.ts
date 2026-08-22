import { Pool } from 'pg';
import { createAuditLog } from '../db/repositories/audit-logs';
import {
  analyzeMt5Symbol,
  getMt5Status,
  getMt5SymbolInfo,
  listMt5Positions,
  listMt5Symbols,
  Mt5DecisionDTO,
} from './mt5-client';
import { evaluateMt5Risk, toRiskSymbolInfo } from './mt5-risk-engine';
import { effectiveMt5RiskSettings } from '../config/mt5-risk-settings';
import {
  buildEntryPlan,
  computeEntryStatus,
  countTradesToday,
  executeDemoTradeForSymbol,
  getEntryPlanWatcherStatus,
  persistEntryPlan,
  planDto,
  EntryStatus,
  Mt5Actor,
} from './mt5-entry-plan-watcher';

export type { Mt5Actor };

export interface InstrumentFilter {
  search?: string;
  assetClass?: string;
  enabled?: boolean;
}

const THAILAND_TIME_ZONE = 'Asia/Bangkok';

// demoVerified gates the Fast Learning DEMO risk profile (spec section 1):
// its loosened position/loss defaults only ever apply once MT5 demo
// verification has actually succeeded — see effectiveMt5RiskSettings.
async function settings(pool: Pool, demoVerified: boolean): Promise<Record<string, unknown>> {
  void pool;
  return { ...effectiveMt5RiskSettings(demoVerified) };
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

type EntryStatusName = 'WAITING' | 'READY' | 'TRIGGERED' | 'EXECUTING' | 'EXECUTED' | 'BLOCKED' | 'EXPIRED' | 'CANCELLED';

export interface ExecutionEligibility {
  canExecute: boolean;
  entryStatus: EntryStatusName | null;
  blockCode: string | null;
  blockMessage: string | null;
}

/**
 * Single source of truth for "Trade in Demo" eligibility, grounded in the
 * REAL persisted plan row (status + execution_key) rather than only AI/risk/
 * market conditions — tradeButtonDiagnostics alone cannot see whether this
 * plan is already EXECUTING/EXECUTED/EXPIRED/CANCELLED or still holding a
 * stale claim lock, all of which claimPlanForExecution() actually enforces.
 * The frontend must use canExecute/entryStatus/blockCode/blockMessage
 * directly and never re-derive eligibility itself.
 */
export function describeExecutionEligibility(
  row: Record<string, unknown> | undefined,
  tradeButton: { enabled: boolean; disabledReasons: Array<{ rule: string; explanation: string }> },
): ExecutionEligibility {
  const status = (row?.status as EntryStatusName | undefined) ?? null;
  // No persisted row yet for this symbol at all — there is nothing to claim
  // yet, but "Trade in Demo" still works (the click itself creates/refreshes
  // the plan before executing), so eligibility falls back to the live AI/
  // risk/market read.
  if (!status) {
    const first = tradeButton.disabledReasons[0];
    return {
      canExecute: tradeButton.enabled,
      entryStatus: null,
      blockCode: tradeButton.enabled ? null : (first?.rule ?? null),
      blockMessage: tradeButton.enabled ? null : (first?.explanation ?? null),
    };
  }
  const hasStaleLock = Boolean(row?.execution_key);
  const claimable = (status === 'READY' || status === 'TRIGGERED') && !hasStaleLock;
  if (claimable && tradeButton.enabled) return { canExecute: true, entryStatus: status, blockCode: null, blockMessage: null };
  switch (status) {
    case 'EXECUTING':
      return { canExecute: false, entryStatus: status, blockCode: 'EXECUTION_IN_PROGRESS', blockMessage: 'This entry plan is already being executed.' };
    case 'EXECUTED':
      return { canExecute: false, entryStatus: status, blockCode: 'ALREADY_EXECUTED', blockMessage: 'This entry plan already executed in MT5.' };
    case 'EXPIRED':
      return { canExecute: false, entryStatus: status, blockCode: 'PLAN_EXPIRED', blockMessage: 'This entry plan expired before it could be executed.' };
    case 'CANCELLED':
      return { canExecute: false, entryStatus: status, blockCode: 'PLAN_CANCELLED', blockMessage: 'This entry plan was cancelled.' };
    case 'BLOCKED':
      return { canExecute: false, entryStatus: status, blockCode: String(row?.block_reason ?? 'BLOCKED'), blockMessage: beginnerRiskReason(String(row?.block_reason ?? 'BLOCKED')) };
    case 'WAITING':
      return { canExecute: false, entryStatus: status, blockCode: 'WAITING_ENTRY', blockMessage: 'AI is still waiting for price to reach the entry condition.' };
    default: {
      // status is READY/TRIGGERED but not currently claimable — either a
      // stale/active lock, or AI/risk/market conditions moved since the
      // plan's status was last computed.
      const first = tradeButton.disabledReasons[0];
      return {
        canExecute: false,
        entryStatus: status,
        blockCode: hasStaleLock ? 'EXECUTION_IN_PROGRESS' : (first?.rule ?? 'BLOCKED'),
        blockMessage: hasStaleLock ? 'This entry plan is already being executed.' : (first?.explanation ?? 'Demo trade is not currently available.'),
      };
    }
  }
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

// Sub-cent tolerance around zero: realized_pnl is summed from raw MT5 deal
// profits in floating point (see closeTradeOutcomeFromHistory) before being
// persisted, so a genuine breakeven close can land a hair off exact zero.
const BREAKEVEN_TOLERANCE = 0.005;

// Exported so real-demo-learning.ts (the Fast Learning dashboard's REAL_DEMO
// data source) can classify trade_outcomes rows exactly the same way History
// does — a real trade's WIN/LOSS/BREAKEVEN/EXECUTION_FAILED status must never
// diverge between the two, since History stays the single source of truth
// for actual MT5 DEMO performance and Fast Learning only ever references it.
export function resultType(value: unknown, exitReason?: unknown): 'WIN' | 'LOSS' | 'BREAKEVEN' | 'OPEN' | 'EXECUTION_FAILED' {
  if (exitReason === 'RECONCILIATION_FAILED') return 'EXECUTION_FAILED';
  if (value === null || value === undefined) return 'OPEN';
  const pnl = Number(value);
  if (Math.abs(pnl) < BREAKEVEN_TOLERANCE) return 'BREAKEVEN';
  if (pnl > 0) return 'WIN';
  return 'LOSS';
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

function beginnerRiskReason(value: string, snapshot?: Record<string, unknown> | null): string {
  if (value === 'MAX_TRADES_PER_DAY' && snapshot) {
    const used = snapshot.dailyConfirmedTrades ?? '?';
    const limit = snapshot.dailyTradeLimit ?? '?';
    return `Daily demo trade limit reached: ${used}/${limit} confirmed trades today.`;
  }
  if (value === 'MAX_SIMULTANEOUS_POSITIONS' && snapshot) {
    const open = snapshot.openPositions ?? '?';
    const limit = snapshot.maxSimultaneousPositions ?? '?';
    return `Too many demo trades are already open: ${open}/${limit} positions.`;
  }
  if (value === 'MINIMUM_VOLUME_EXCEEDS_RISK' && snapshot) {
    const loss = snapshot.lossPerLot;
    return `Even the broker's minimum lot size for this symbol would lose more than your configured risk${Number.isFinite(Number(loss)) ? ` (~$${Number(loss).toFixed(2)} per 0.01 lot)` : ''}.`;
  }
  if (value === 'INSUFFICIENT_MARGIN' && snapshot) {
    const required = snapshot.marginRequired;
    const free = snapshot.freeMargin;
    const shortfall = snapshot.marginShortfall;
    const parts = [
      Number.isFinite(Number(required)) ? `Required $${Number(required).toFixed(2)}` : null,
      Number.isFinite(Number(free)) ? `Free $${Number(free).toFixed(2)}` : null,
      Number.isFinite(Number(shortfall)) && Number(shortfall) > 0 ? `Shortfall $${Number(shortfall).toFixed(2)}` : null,
    ].filter(Boolean);
    return parts.length ? parts.join(' · ') : 'The required margin for this trade is too high for your free margin.';
  }
  const map: Record<string, string> = {
    SAFETY_SWITCH_ON: 'Demo safety switch is on, so new trades are blocked.',
    RISK_LIMIT: 'Demo safety switch is on, so new trades are blocked.',
    MARKET_CLOSED: 'The market is closed now.',
    STALE_DATA: 'The latest price is too old.',
    STALE_QUOTE: 'MT5 quote is stale.',
    NO_EXECUTABLE_DECISION: 'AI says wait, so there is no entry.',
    STOP_LOSS_REQUIRED: 'Stop Loss is missing.',
    TAKE_PROFIT_REQUIRED: 'Take Profit is missing.',
    INVALID_SL: 'The Stop Loss is not valid for this entry.',
    INVALID_TP: 'The Take Profit is not valid for this entry.',
    INVALID_STOP_DISTANCE: 'The Stop Loss distance from entry is not valid.',
    RISK_REWARD_TOO_LOW: 'The planned reward is too small compared with the risk.',
    MAX_SIMULTANEOUS_POSITIONS: 'Too many demo trades are already open.',
    MAX_TRADES_PER_DAY: 'Daily demo trade limit has been reached.',
    MARGIN_INSUFFICIENT: 'Not enough free demo margin.',
    POSITION_SIZE_INVALID: 'The calculated lot size is not valid.',
    SYMBOL_INFO_UNAVAILABLE: 'This symbol\'s broker contract details are unavailable, so a safe lot size cannot be calculated.',
    MINIMUM_VOLUME_EXCEEDS_RISK: 'Even the broker\'s minimum lot size for this symbol exceeds your configured risk.',
    INSUFFICIENT_MARGIN: 'The required margin for this trade is too high for your free margin.',
    MARGIN_UNVERIFIABLE: 'Required margin could not be verified for this account/symbol.',
    SPREAD_TOO_HIGH: 'The spread is too expensive right now.',
    POSITION_EXISTS: 'A demo position for this symbol is already open.',
    PENDING_ORDER: 'A pending demo order for this symbol already exists.',
    COOLDOWN: 'This symbol is in a cooldown period after its last demo trade.',
    DEMO_VERIFICATION_FAILED: 'MT5 demo account could not be verified.',
    KILL_SWITCH: 'Demo safety switch is on, so new trades are blocked.',
    ORDER_CHECK_FAILED: 'MT5 rejected the order request before it could be sent.',
    EXECUTION_UNCONFIRMED: 'MT5 did not confirm the order — nothing was opened.',
    INVALID_FILLING_MODE: 'This broker/symbol does not support the requested order filling mode.',
    ALREADY_PROCESSING: 'This entry plan is already being executed.',
    AUTO_DEMO_DISABLED: 'AUTO-DEMO automatic execution is turned off.',
    PLAN_EXPIRED: 'The entry plan expired before it could be executed.',
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
  const status = await getMt5Status(actor.requestId ?? undefined);
  const cfg = await settings(pool, status.demo_verified);
  const watchlist = await pool.query(
    `SELECT i.symbol, i.asset_class
     FROM watchlists w JOIN instruments i ON i.symbol = w.symbol
     WHERE w.enabled = true ORDER BY w.rank ASC, i.symbol ASC LIMIT 25`,
  );
  const rows = [];
  const mt5Positions = await listMt5Positions(actor.requestId ?? undefined).catch(() => []);
  for (const row of watchlist.rows) {
    const [decision, symbolInfoRaw] = await Promise.all([
      analyzeMt5Symbol(row.symbol, actor.requestId ?? undefined),
      getMt5SymbolInfo(row.symbol, actor.requestId ?? undefined).catch(() => null),
    ]);
    const openPositions = mt5Positions.length;
    const tradesToday = await countTradesToday(pool);
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
      symbol: toRiskSymbolInfo(symbolInfoRaw),
      leverage: Number(status.account?.leverage) || null,
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
    watcher: getEntryPlanWatcherStatus(),
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
  const status = await getMt5Status(actor.requestId ?? undefined);
  const cfg = await settings(pool, status.demo_verified);
  const instrument = await pool.query('SELECT asset_class FROM instruments WHERE symbol = $1', [symbol]);
  const decision = await analyzeMt5Symbol(symbol, actor.requestId ?? undefined);
  const saved = await persistDecision(pool, decision, instrument.rows[0]?.asset_class ?? 'OTHER');
  const [mt5Positions, symbolInfoRaw] = await Promise.all([
    listMt5Positions(actor.requestId ?? undefined).catch(() => []),
    getMt5SymbolInfo(symbol, actor.requestId ?? undefined).catch(() => null),
  ]);
  const tradesToday = await countTradesToday(pool);
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
    symbol: toRiskSymbolInfo(symbolInfoRaw),
    leverage: Number(status.account?.leverage) || null,
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
  return { decision: saved, entryPlan: { ...planDto(entryPlan), ...savedPlan } };
}

export async function getMt5AnalysisDetail(pool: Pool, symbol: string, actor: Mt5Actor, persist = false) {
  const [status, instrumentResult, mt5Positions, symbolInfoRaw] = await Promise.all([
    getMt5Status(actor.requestId ?? undefined),
    pool.query('SELECT asset_class, description FROM instruments WHERE symbol = $1', [symbol]),
    listMt5Positions(actor.requestId ?? undefined).catch(() => []),
    getMt5SymbolInfo(symbol, actor.requestId ?? undefined).catch(() => null),
  ]);
  const cfg = await settings(pool, status.demo_verified);
  const decision = await analyzeMt5Symbol(symbol, actor.requestId ?? undefined);
  const assetClassValue = instrumentResult.rows[0]?.asset_class ?? decision.market?.asset_class ?? 'OTHER';
  const tradesToday = await countTradesToday(pool);
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
    symbol: toRiskSymbolInfo(symbolInfoRaw),
    leverage: Number(status.account?.leverage) || null,
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
    savedPlan = await persistEntryPlan(pool, String(persistedDecision.id), entryPlanInput, rawEntryStatus as EntryStatus);
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
  const snap = risk.snapshot as Record<string, unknown> | undefined;
  const sizing = {
    recommendedLotSize: risk.recommendedVolume,
    approximateNotional: notionalSize(currentPrice, risk.recommendedVolume),
    maximumPlannedLoss: riskAmount,
    targetProfit: targetProfit(riskAmount, decision.risk_reward),
    riskPerAccountPct: riskPerAccount(riskAmount, status.account),
    // Sourced directly from the risk engine's own broker-native
    // calculation (never re-derived here) so the UI can never drift from
    // what actually gated the trade.
    expectedLossAtSl: snap?.expectedLossAtSl ?? null,
    marginRequired: snap?.marginRequired ?? null,
    freeMargin: snap?.freeMargin ?? null,
    freeMarginAfterEntry: snap?.freeMarginAfterEntry ?? null,
    riskPctOfEquity: snap?.riskPctOfEquity ?? null,
    dailyConfirmedTrades: snap?.dailyConfirmedTrades ?? null,
    dailyTradeLimit: snap?.dailyTradeLimit ?? null,
    dailyTradesRemaining: snap?.dailyTradesRemaining ?? null,
    source: 'SERVER_SIDE_RISK_ENGINE',
  };
  const tradeButton = tradeButtonDiagnostics({ status, decision, risk, entryPlan, marketStatus, dataStatus });
  // Single source of truth for whether the "Trade in Demo" button should
  // actually be clickable: tradeButtonDiagnostics only knows about AI/risk/
  // market conditions, computed fresh and never persisted on a read-only
  // (persist=false) call - it has no way to know this symbol's real,
  // currently-persisted claim state (execution_key/status), which is what
  // claimPlanForExecution() actually gates on. Reading the real row here
  // (there is at most one live plan per symbol in practice) is what lets
  // the frontend trust canExecute instead of independently guessing
  // eligibility from AI BUY/RISK PASS/MARKET OPEN alone.
  const persistedRow = savedPlan ?? (await pool.query(
    'SELECT * FROM mt5_entry_plans WHERE symbol=$1 ORDER BY created_at DESC LIMIT 1',
    [symbol],
  )).rows[0] as Record<string, unknown> | undefined;
  const execution = describeExecutionEligibility(persistedRow, tradeButton);
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
    autoDemoEnabled: cfg.mt5_auto_demo_enabled === true,
    watcher: getEntryPlanWatcherStatus(),
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
      diagnostics: (risk.failedRules ?? []).map((rule) => ({ rule, explanation: beginnerRiskReason(rule, snap) })),
    },
    explanation,
    tradeButton,
    execution,
  };
}

export async function executeAssistedDemo(pool: Pool, symbol: string, actor: Mt5Actor) {
  return executeDemoTradeForSymbol(pool, symbol, actor, 'ASSISTED_DEMO', runAssistedAnalysis);
}

export async function executeAutoDemo(pool: Pool, symbol: string, actor: Mt5Actor) {
  return executeDemoTradeForSymbol(pool, symbol, actor, 'AUTO_DEMO', runAssistedAnalysis);
}

export async function getMt5OpenPositions(pool: Pool, actor: Mt5Actor) {
  const positions = await listMt5Positions(actor.requestId ?? undefined);
  if (!positions.length) return { positions: [] };
  const outcomes = await pool.query(
    `SELECT t.*, d.model_version, p.entry_strategy AS entry_type
     FROM trade_outcomes t
     LEFT JOIN ai_decisions d ON d.id = t.ai_decision_id
     LEFT JOIN mt5_entry_plans p ON p.id = t.entry_plan_id
     WHERE t.closed_at IS NULL
     ORDER BY t.opened_at DESC`,
  );
  const bySymbol = new Map<string, Array<Record<string, unknown>>>();
  for (const row of outcomes.rows) {
    const list = bySymbol.get(String(row.symbol)) ?? [];
    list.push(row);
    bySymbol.set(String(row.symbol), list);
  }
  const enriched = positions.map((position) => {
    const candidates = bySymbol.get(String(position.symbol)) ?? [];
    const ticketIndex = candidates.findIndex((row) => row.order_ticket && String(row.order_ticket) === String(position.ticket));
    const index = ticketIndex >= 0 ? ticketIndex : candidates.length ? 0 : -1;
    const matched = index >= 0 ? candidates[index] : null;
    if (index >= 0) candidates.splice(index, 1);
    return {
      ...position,
      entry_plan_id: matched?.entry_plan_id ?? null,
      model_version: matched?.model_version ?? null,
      entry_type: matched?.entry_type ?? null,
      planned_entry: matched?.expected_entry ?? null,
      actual_entry: matched?.actual_entry ?? position.price_open ?? null,
      max_planned_loss: matched?.risk_amount ?? null,
    };
  });
  return { positions: enriched };
}

export async function listMt5TradeHistory(pool: Pool) {
  const result = await pool.query(
    `SELECT t.id, t.symbol, i.asset_class, t.order_ticket, t.deal_ticket, t.retcode, t.side, t.volume,
        t.expected_entry, t.actual_entry, t.stop_loss, t.take_profit, t.risk_amount, t.risk_reward,
        t.spread, t.slippage, t.exit_reason, t.realized_pnl, t.fees, t.mfe, t.mae,
        t.opened_at, t.closed_at, t.entry_plan_id, t.ai_trade_plan_id, t.account_equity_at_entry,
        COALESCE(d.decision, ap.decision) AS decision,
        -- ai_decisions.confidence (BASELINE_MT5_H1_V1) is stored 0-1; ai_trade_plans.confidence_pct
        -- (Trading AI V3) is stored as a canonical 0-100 integer percent — normalized to the same
        -- 0-1 scale here so every consumer of this unified query can keep using one convention.
        COALESCE(d.confidence, ap.confidence_pct / 100.0) AS confidence,
        d.opportunity_score, d.reasons,
        COALESCE(d.model_version, ap.ai_model) AS model_version,
        COALESCE(p.entry_strategy, ap.entry_type) AS entry_type,
        p.time_to_trigger_seconds, p.reached_trigger,
        ap.ai_provider, ap.ai_prompt_version, ap.pending_order_type,
        ap.trade_score, ap.trade_rating, ap.score_breakdown,
        ap.tradeability_pct, ap.tradeability_rating
     FROM trade_outcomes t
     LEFT JOIN ai_decisions d ON d.id = t.ai_decision_id
     LEFT JOIN instruments i ON i.symbol = t.symbol
     LEFT JOIN mt5_entry_plans p ON p.id = t.entry_plan_id
     LEFT JOIN ai_trade_plans ap ON ap.id = t.ai_trade_plan_id
     ORDER BY COALESCE(t.closed_at, t.opened_at) DESC
     LIMIT 100`,
  );
  const trades = result.rows.map((trade) => {
    const type = resultType(trade.realized_pnl, trade.exit_reason);
    // Only compute a % account return when we actually stored the equity
    // basis at entry for this trade (older rows predate that column) — never
    // derive it from current/unrelated equity, which would misrepresent it.
    const equityAtEntry = trade.account_equity_at_entry === null || trade.account_equity_at_entry === undefined
      ? null : Number(trade.account_equity_at_entry);
    const realizedPnl = trade.realized_pnl === null || trade.realized_pnl === undefined ? null : Number(trade.realized_pnl);
    const accountReturnPct = equityAtEntry && equityAtEntry > 0 && realizedPnl !== null && Number.isFinite(realizedPnl)
      ? (realizedPnl / equityAtEntry) * 100
      : null;
    return {
      ...trade,
      result_type: type,
      account_return_pct: accountReturnPct,
      beginner_note: type === 'EXECUTION_FAILED'
        ? `${trade.symbol}: MT5 never confirmed a real position for this trade — it was not actually opened.`
        : trade.closed_at
          ? `${trade.symbol} closed as ${type.toLowerCase()}${trade.exit_reason ? ` by ${String(trade.exit_reason).replaceAll('_', ' ').toLowerCase()}` : ''}.`
          : `${trade.symbol} is open (MT5 confirmed).`,
    };
  });
  return { trades, statistics: summarizeTrades(trades) };
}

function summarizeTrades(trades: Array<Record<string, unknown>>) {
  // A trade that MT5 never confirmed (result_type === 'EXECUTION_FAILED',
  // e.g. exit_reason RECONCILIATION_FAILED) is a diagnostic record, not a
  // closed trading result — it must never count toward closed trades,
  // win rate, P&L, or the exit-reason breakdown.
  const executionFailed = trades.filter((trade) => trade.result_type === 'EXECUTION_FAILED');
  const closed = trades.filter((trade) => trade.closed_at && trade.result_type !== 'EXECUTION_FAILED');
  const wins = closed.filter((trade) => trade.result_type === 'WIN');
  const losses = closed.filter((trade) => trade.result_type === 'LOSS');
  const breakeven = closed.filter((trade) => trade.result_type === 'BREAKEVEN');
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
  const grossProfit = wins.reduce((sum, trade) => sum + money(trade.realized_pnl), 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + money(trade.realized_pnl), 0));
  // Undefined (not 0 or Infinity) when there's no loss to divide by yet —
  // an empty/all-winning sample isn't a real profit factor, it's no data.
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : null;
  const holdingMinutes = closed
    .map((trade) => {
      const opened = new Date(String(trade.opened_at)).getTime();
      const closedAt = new Date(String(trade.closed_at)).getTime();
      return Number.isFinite(opened) && Number.isFinite(closedAt) ? (closedAt - opened) / 60000 : null;
    })
    .filter((minutes): minutes is number => minutes !== null);
  const averageHoldingMinutes = holdingMinutes.length
    ? holdingMinutes.reduce((sum, minutes) => sum + minutes, 0) / holdingMinutes.length
    : null;
  return {
    totalClosedTrades: closed.length,
    wins: wins.length,
    losses: losses.length,
    breakeven: breakeven.length,
    // wins / (wins + losses) — breakeven and execution failures are excluded
    // from both the numerator and denominator so they can't dilute the rate.
    winRate: wins.length + losses.length ? wins.length / (wins.length + losses.length) : 0,
    totalPnl,
    averageWin: avg(wins),
    averageLoss: avg(losses),
    profitFactor,
    averageHoldingMinutes,
    bestTrade: sortedTrades[0] ?? null,
    worstTrade: sortedTrades.at(-1) ?? null,
    bestPerformingSymbol: sortedSymbols[0]?.[0] ?? null,
    worstPerformingSymbol: sortedSymbols.at(-1)?.[0] ?? null,
    pnlBySymbol: sortedSymbols.map(([label, value]) => ({ label, value })),
    pnlByAssetClass: [...byAssetClass.entries()].map(([label, value]) => ({ label, value })),
    exitReasons: [...exits.entries()].map(([label, value]) => ({ label, value })),
    // System-level diagnostic count, kept separate from trading performance.
    executionFailures: executionFailed.length,
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
  // Same exclusion as summarizeTrades(): EXECUTION_FAILED/RECONCILIATION_FAILED
  // rows are not closed trading results and must not count as one here either,
  // so Dashboard and History always agree on the same numbers.
  const closedTrades = history.trades.filter((trade) => trade.closed_at && trade.result_type !== 'EXECUTION_FAILED');
  const wins = closedTrades.filter((trade) => trade.result_type === 'WIN');
  const losses = closedTrades.filter((trade) => trade.result_type === 'LOSS');
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
      winRate: wins.length + losses.length ? wins.length / (wins.length + losses.length) : 0,
      totalClosedTrades: closedTrades.length,
      totalWins: wins.length,
      totalLosses: losses.length,
      executionFailures: history.statistics.executionFailures,
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
