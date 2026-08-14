import Decimal from 'decimal.js';
import { Pool, PoolClient } from 'pg';
import { findLatestFillBySymbol } from '../db/repositories/fills';
import { findActiveOrdersBySymbol } from '../db/repositories/orders';
import { getSettingValue } from '../db/repositories/system-settings';
import { upsertStrategy } from '../db/repositories/strategies';
import {
  countProposalsForStrategyToday,
  findActiveExposureProposals,
} from '../db/repositories/trade-proposals';
import {
  IntradayAnalysisDTO,
  IntradayConfigDTO,
  MarketSnapshotDTO,
  RiskConfigDTO,
  SessionStatusValue,
  analyzeIntraday,
} from './trading-engine-client';

export const INTRADAY_STRATEGY_NAME = 'INTRADAY_MULTI_TIMEFRAME_PAPER_ONLY';

export interface Phase25Settings {
  intradayModeEnabled: boolean;
  trendEmaFast: number;
  trendEmaSlow: number;
  setupMomentumWindow: number;
  setupVolumeWindow: number;
  entryMomentumWindow: number;
  entryVolumeWindow: number;
  atrWindow: number;
  stopAtrMultiple: string;
  takeProfitAtrMultiple: string;
  minRiskReward: string;
  maxSpreadPct: string;
  minVolumeRatio: string;
  maxHoldingMinutes: number;
  defaultQuantity: string;
  maxLossPerTradeUsd: string;
  maxTradesPerSymbolPerDay: number;
  maxTradesPerDayTotal: number;
  cooldownSecondsPerSymbol: number;
  sessionMarketOpen: string;
  sessionMarketClose: string;
  noNewTradesMinutesBeforeClose: number;
  forceCloseBeforeCloseMinutes: number;
  forceCloseEnabled: boolean;
}

function decimal(value: string | number | null | undefined): Decimal {
  return new Decimal(value ?? '0');
}

function money(value: Decimal): string {
  return value.toDecimalPlaces(8).toFixed(8);
}

export async function loadPhase25Settings(db: Pool | PoolClient): Promise<Phase25Settings> {
  return {
    intradayModeEnabled: await getSettingValue<boolean>(db, 'phase25_intraday_mode_enabled') ?? false,
    trendEmaFast: Number(await getSettingValue(db, 'phase25_trend_ema_fast') ?? 8),
    trendEmaSlow: Number(await getSettingValue(db, 'phase25_trend_ema_slow') ?? 21),
    setupMomentumWindow: Number(await getSettingValue(db, 'phase25_setup_momentum_window') ?? 6),
    setupVolumeWindow: Number(await getSettingValue(db, 'phase25_setup_volume_window') ?? 20),
    entryMomentumWindow: Number(await getSettingValue(db, 'phase25_entry_momentum_window') ?? 3),
    entryVolumeWindow: Number(await getSettingValue(db, 'phase25_entry_volume_window') ?? 20),
    atrWindow: Number(await getSettingValue(db, 'phase25_atr_window') ?? 14),
    stopAtrMultiple: String(await getSettingValue(db, 'phase25_stop_atr_multiple') ?? '1.5'),
    takeProfitAtrMultiple: String(await getSettingValue(db, 'phase25_take_profit_atr_multiple') ?? '3.0'),
    minRiskReward: String(await getSettingValue(db, 'phase25_min_risk_reward') ?? '1.5'),
    maxSpreadPct: String(await getSettingValue(db, 'phase25_max_spread_pct') ?? '0.5'),
    minVolumeRatio: String(await getSettingValue(db, 'phase25_min_volume_ratio') ?? '1.0'),
    maxHoldingMinutes: Number(await getSettingValue(db, 'phase25_max_holding_minutes') ?? 120),
    defaultQuantity: String(await getSettingValue(db, 'phase25_default_quantity') ?? '1'),
    maxLossPerTradeUsd: String(await getSettingValue(db, 'phase25_max_loss_per_trade_usd') ?? '100'),
    maxTradesPerSymbolPerDay: Number(await getSettingValue(db, 'phase25_max_trades_per_symbol_per_day') ?? 3),
    maxTradesPerDayTotal: Number(await getSettingValue(db, 'phase25_max_trades_per_day_total') ?? 10),
    cooldownSecondsPerSymbol: Number(await getSettingValue(db, 'phase25_cooldown_seconds_per_symbol') ?? 900),
    sessionMarketOpen: String(await getSettingValue(db, 'phase25_session_market_open') ?? '13:30'),
    sessionMarketClose: String(await getSettingValue(db, 'phase25_session_market_close') ?? '20:00'),
    noNewTradesMinutesBeforeClose: Number(
      await getSettingValue(db, 'phase25_no_new_trades_minutes_before_close') ?? 15,
    ),
    forceCloseBeforeCloseMinutes: Number(
      await getSettingValue(db, 'phase25_force_close_before_close_minutes') ?? 5,
    ),
    forceCloseEnabled: await getSettingValue<boolean>(db, 'phase25_force_close_enabled') ?? true,
  };
}

export function toIntradayConfigDTO(settings: Phase25Settings): IntradayConfigDTO {
  return {
    trend_ema_fast: settings.trendEmaFast,
    trend_ema_slow: settings.trendEmaSlow,
    setup_momentum_window: settings.setupMomentumWindow,
    setup_volume_window: settings.setupVolumeWindow,
    entry_momentum_window: settings.entryMomentumWindow,
    entry_volume_window: settings.entryVolumeWindow,
    atr_window: settings.atrWindow,
    stop_atr_multiple: settings.stopAtrMultiple,
    take_profit_atr_multiple: settings.takeProfitAtrMultiple,
    min_risk_reward: settings.minRiskReward,
    max_spread_pct: settings.maxSpreadPct,
    min_volume_ratio: settings.minVolumeRatio,
    max_holding_minutes: settings.maxHoldingMinutes,
    quantity: settings.defaultQuantity,
    session: {
      market_open: settings.sessionMarketOpen,
      market_close: settings.sessionMarketClose,
      no_new_trades_minutes_before_close: settings.noNewTradesMinutesBeforeClose,
      force_close_before_close_minutes: settings.forceCloseBeforeCloseMinutes,
      force_close_enabled: settings.forceCloseEnabled,
    },
  };
}

/** Local (no Python round-trip) equivalent of the Python service's
 * session_status(): pure time-of-day math against the configured regular
 * US session window. Used by the position-exit reconciler, which needs a
 * fast, frequent check and doesn't need the full multi-timeframe analysis
 * just to know whether the session is closing. Must stay in lockstep with
 * strategy/intraday/analysis.py::session_status. */
export function computeIntradaySessionStatus(now: Date, settings: Phase25Settings): SessionStatusValue {
  const [openHour, openMinute] = settings.sessionMarketOpen.split(':').map(Number);
  const [closeHour, closeMinute] = settings.sessionMarketClose.split(':').map(Number);
  const nowMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const openMinutes = openHour * 60 + openMinute;
  const closeMinutes = closeHour * 60 + closeMinute;

  if (nowMinutes < openMinutes || nowMinutes >= closeMinutes) return 'CLOSED';

  const remainingMinutes = closeMinutes - nowMinutes;
  if (settings.forceCloseEnabled && remainingMinutes <= settings.forceCloseBeforeCloseMinutes) {
    return 'FORCE_CLOSE_WINDOW';
  }
  if (remainingMinutes <= settings.noNewTradesMinutesBeforeClose) {
    return 'NO_NEW_TRADES_NEAR_CLOSE';
  }
  return 'OPEN_FOR_ENTRIES';
}

export async function runIntradayAnalysis(
  symbol: string,
  db: Pool | PoolClient,
  requestId?: string,
): Promise<{ analysis: IntradayAnalysisDTO; settings: Phase25Settings }> {
  const settings = await loadPhase25Settings(db);
  const analysis = await analyzeIntraday(symbol, toIntradayConfigDTO(settings), requestId);
  return { analysis, settings };
}

export interface Phase25ControlsInput {
  symbol: string;
  strategyId: string;
  analysis: IntradayAnalysisDTO;
  market: MarketSnapshotDTO;
  paperPortfolio: { cash: string; positions: Record<string, string> };
  latestSnapshot: { portfolioEquity: string; dailyPnl: string } | null;
  riskCfg: RiskConfigDTO;
  settings: Phase25Settings;
  requestedQuantity: string;
  excludeProposalId?: string;
}

export interface Phase25ControlsResult {
  quantity: string;
  estimatedNotional: string;
  passed: boolean;
  failedRules: string[];
  reason: string | null;
  snapshot: Record<string, unknown>;
}

/** Server-side sizing and safety gate for intraday (Phase 25) BUY decisions.
 * Mirrors trade-proposal-service.ts's phase22RiskControls, but the bracket
 * comes from ATR-derived analysis rather than a fixed percentage, and this
 * layer additionally enforces per-symbol/day and total/day trade-count caps. */
export async function phase25RiskControls(
  db: Pool | PoolClient,
  input: Phase25ControlsInput,
): Promise<Phase25ControlsResult> {
  const { analysis, settings } = input;
  const entry = decimal(analysis.entry_price);
  const stopLoss = analysis.stop_loss ? decimal(analysis.stop_loss) : null;
  const takeProfit = analysis.take_profit ? decimal(analysis.take_profit) : null;
  const bid = decimal(input.market.bid);
  const ask = decimal(input.market.ask);
  const mid = bid.plus(ask).div(2);
  const spreadPct = mid.gt(0) ? ask.minus(bid).div(mid).mul(100) : new Decimal(0);
  const maxSpreadPct = decimal(settings.maxSpreadPct);
  const minRiskReward = decimal(settings.minRiskReward);
  const maxLossPerTradeUsd = decimal(settings.maxLossPerTradeUsd);
  const maxPositionSizeUsd = decimal(input.riskCfg.max_position_size_usd);
  const maxConcentrationPct = decimal(input.riskCfg.max_portfolio_concentration_pct);
  const maxDailyLossUsd = decimal(input.riskCfg.max_daily_loss_usd);
  const cash = decimal(input.paperPortfolio.cash);
  const equity = decimal(input.latestSnapshot?.portfolioEquity ?? input.paperPortfolio.cash);
  const dailyPnl = decimal(input.latestSnapshot?.dailyPnl);
  const existingQty = decimal(input.paperPortfolio.positions[input.symbol]);
  const requestedQuantity = decimal(input.requestedQuantity);

  const failedRules: string[] = [];

  if (!settings.intradayModeEnabled) failedRules.push('PHASE25_INTRADAY_MODE_DISABLED');
  if (analysis.decision !== 'BUY') failedRules.push('PHASE25_NO_ENTRY_SIGNAL');
  if (analysis.session_status !== 'OPEN_FOR_ENTRIES') failedRules.push('PHASE25_SESSION_STATUS');
  if (input.market.is_stale) failedRules.push('PHASE25_FRESH_MARKET_DATA');
  if (spreadPct.gt(maxSpreadPct)) failedRules.push('PHASE25_BID_ASK_SPREAD');
  if (!analysis.liquidity_ok) failedRules.push('PHASE25_LIQUIDITY');

  const riskPerShare = stopLoss ? entry.minus(stopLoss) : new Decimal(0);
  const riskReward = takeProfit && stopLoss && riskPerShare.gt(0)
    ? takeProfit.minus(entry).abs().div(riskPerShare)
    : new Decimal(0);
  if (riskPerShare.lte(0)) {
    failedRules.push('PHASE25_INVALID_STOP_DISTANCE');
  } else if (riskReward.lt(minRiskReward)) {
    failedRules.push('PHASE25_MIN_RISK_REWARD');
  }

  const estimatedFeePerShare = new Decimal('0.005');
  const minFee = new Decimal('1');
  const slippagePerShare = entry.mul(new Decimal('0.0005'));
  const riskQuantity = riskPerShare.gt(0)
    ? maxLossPerTradeUsd.div(riskPerShare.plus(slippagePerShare).plus(estimatedFeePerShare))
    : new Decimal(0);
  const cashQuantity = entry.plus(slippagePerShare).gt(0)
    ? cash.div(entry.plus(slippagePerShare))
    : new Decimal(0);
  const positionLimitQuantity = entry.gt(0) ? maxPositionSizeUsd.div(entry) : new Decimal(0);
  const concentrationQuantity = equity.gt(0) && entry.gt(0)
    ? equity.mul(maxConcentrationPct.div(100)).div(entry)
    : riskQuantity;
  const rawQuantity = Decimal.min(
    requestedQuantity,
    riskQuantity,
    cashQuantity,
    positionLimitQuantity,
    concentrationQuantity,
  );
  const quantity = rawQuantity.toDecimalPlaces(0, Decimal.ROUND_DOWN);
  const estimatedFee = Decimal.max(quantity.mul(estimatedFeePerShare), minFee);
  const estimatedSlippageUsd = quantity.mul(slippagePerShare);
  const maxLoss = quantity.mul(riskPerShare).plus(estimatedSlippageUsd).plus(estimatedFee);

  if (quantity.lte(0)) failedRules.push('PHASE25_POSITION_SIZE');
  if (maxLoss.gt(maxLossPerTradeUsd)) failedRules.push('PHASE25_MAX_LOSS_PER_TRADE');
  if (dailyPnl.lt(maxDailyLossUsd.neg())) failedRules.push('PHASE25_MAX_DAILY_LOSS');
  if (existingQty.gt(0)) failedRules.push('PHASE25_DUPLICATE_EXPOSURE');

  const activeOrders = await findActiveOrdersBySymbol(db, input.symbol);
  if (activeOrders.length > 0) failedRules.push('PHASE25_DUPLICATE_PENDING_ORDER');
  const activeExposure = await findActiveExposureProposals(db, input.excludeProposalId);
  if (activeExposure.some((proposal) => proposal.symbol === input.symbol)) {
    if (!failedRules.includes('PHASE25_DUPLICATE_EXPOSURE')) failedRules.push('PHASE25_DUPLICATE_EXPOSURE');
  }

  const latestFill = await findLatestFillBySymbol(db, input.symbol);
  const cooldownRemaining = latestFill && settings.cooldownSecondsPerSymbol > 0
    ? Math.max(
      0,
      settings.cooldownSecondsPerSymbol
        - Math.floor((Date.now() - latestFill.filledAt.getTime()) / 1000),
    )
    : 0;
  if (cooldownRemaining > 0) failedRules.push('PHASE25_COOLDOWN');

  const tradesTodayForSymbol = await countProposalsForStrategyToday(db, input.strategyId, input.symbol);
  const tradesTodayTotal = await countProposalsForStrategyToday(db, input.strategyId);
  if (tradesTodayForSymbol >= settings.maxTradesPerSymbolPerDay) {
    failedRules.push('PHASE25_MAX_TRADES_PER_SYMBOL_PER_DAY');
  }
  if (tradesTodayTotal >= settings.maxTradesPerDayTotal) {
    failedRules.push('PHASE25_MAX_TRADES_PER_DAY_TOTAL');
  }

  const snapshot: Record<string, unknown> = {
    phase: '25',
    source: 'INTRADAY_MULTI_TIMEFRAME',
    orderClass: 'BRACKET',
    entry: money(entry),
    stopLoss: stopLoss ? money(stopLoss) : null,
    takeProfit: takeProfit ? money(takeProfit) : null,
    riskReward: money(riskReward),
    atr: analysis.atr,
    trendDirection: analysis.trend_direction,
    setupConfirmed: analysis.setup_confirmed,
    entryConfirmed: analysis.entry_confirmed,
    volumeSignal: analysis.volume_signal,
    sessionStatus: analysis.session_status,
    expectedHoldingMinutes: analysis.expected_holding_minutes,
    maxHoldingMinutes: settings.maxHoldingMinutes,
    forceCloseBeforeCloseMinutes: settings.forceCloseBeforeCloseMinutes,
    forceCloseEnabled: settings.forceCloseEnabled,
    requestedQuantity: money(requestedQuantity),
    quantity: money(quantity),
    maxLoss: money(maxLoss),
    riskBudget: money(maxLossPerTradeUsd),
    spreadPct: money(spreadPct),
    dailyLossUsed: money(dailyPnl.lt(0) ? dailyPnl.abs() : new Decimal(0)),
    dailyLossLimit: money(maxDailyLossUsd),
    cooldown: {
      configuredSeconds: settings.cooldownSecondsPerSymbol,
      remainingSeconds: cooldownRemaining,
      passed: cooldownRemaining === 0,
    },
    tradeCounts: {
      symbolToday: tradesTodayForSymbol,
      symbolLimit: settings.maxTradesPerSymbolPerDay,
      totalToday: tradesTodayTotal,
      totalLimit: settings.maxTradesPerDayTotal,
    },
    conflictingPendingOrders: activeOrders.map((order) => ({
      id: order.id,
      brokerOrderId: order.brokerOrderId,
      status: order.status,
    })),
    failedRules,
    result: failedRules.length ? 'REJECT' : 'PASS',
  };

  return {
    quantity: money(quantity),
    estimatedNotional: money(quantity.mul(entry)),
    passed: failedRules.length === 0,
    failedRules,
    reason: failedRules.length ? `Phase 25 risk controls failed: ${failedRules.join(', ')}` : null,
    snapshot,
  };
}

export async function ensureIntradayStrategy(db: Pool | PoolClient) {
  return upsertStrategy(db, {
    name: INTRADAY_STRATEGY_NAME,
    description: 'Phase 25 intraday multi-timeframe PAPER ONLY strategy. Never submits broker orders.',
    version: '25.0.0',
    parameters: { source: 'intraday_multi_timeframe', tradingMode: 'PAPER' },
    isActive: true,
  });
}

