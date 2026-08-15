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
  HourlyAnalysisDTO,
  HourlyConfigDTO,
  MarketSnapshotDTO,
  RiskConfigDTO,
  SessionStatusValue,
  analyzeHourly,
} from './trading-engine-client';

export const HOURLY_STRATEGY_NAME = 'HOURLY_TREND_PAPER_ONLY';
export const HOURLY_STRATEGY_VERSION = '27.0.0';

export interface Phase27Settings {
  hourlyModeEnabled: boolean;
  trendEmaFast: number;
  trendEmaSlow: number;
  momentumWindow: number;
  volumeWindow: number;
  breakoutLookbackBars: number;
  minVolumeRatio: string;
  atrWindow: number;
  stopAtrMultiple: string;
  takeProfitAtrMultiple: string;
  minRiskReward: string;
  higherTfBarsPerCandle: number;
  higherTfConfirmationRequired: boolean;
  maxSpreadPct: string;
  estimatedSlippagePct: string;
  maxEstimatedSlippagePct: string;
  maxHoldingHours: number;
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

export async function loadPhase27Settings(db: Pool | PoolClient): Promise<Phase27Settings> {
  return {
    hourlyModeEnabled: await getSettingValue<boolean>(db, 'phase27_hourly_mode_enabled') ?? true,
    trendEmaFast: Number(await getSettingValue(db, 'phase27_trend_ema_fast') ?? 8),
    trendEmaSlow: Number(await getSettingValue(db, 'phase27_trend_ema_slow') ?? 21),
    momentumWindow: Number(await getSettingValue(db, 'phase27_momentum_window') ?? 3),
    volumeWindow: Number(await getSettingValue(db, 'phase27_volume_window') ?? 20),
    breakoutLookbackBars: Number(await getSettingValue(db, 'phase27_breakout_lookback_bars') ?? 20),
    minVolumeRatio: String(await getSettingValue(db, 'phase27_min_volume_ratio') ?? '1.0'),
    atrWindow: Number(await getSettingValue(db, 'phase27_atr_window') ?? 14),
    stopAtrMultiple: String(await getSettingValue(db, 'phase27_stop_atr_multiple') ?? '1.5'),
    takeProfitAtrMultiple: String(await getSettingValue(db, 'phase27_take_profit_atr_multiple') ?? '3.0'),
    minRiskReward: String(await getSettingValue(db, 'phase27_min_risk_reward') ?? '1.5'),
    higherTfBarsPerCandle: Number(await getSettingValue(db, 'phase27_higher_tf_bars_per_candle') ?? 4),
    higherTfConfirmationRequired:
      await getSettingValue<boolean>(db, 'phase27_higher_tf_confirmation_required') ?? true,
    maxSpreadPct: String(await getSettingValue(db, 'phase27_max_spread_pct') ?? '0.5'),
    estimatedSlippagePct: String(await getSettingValue(db, 'phase27_estimated_slippage_pct') ?? '0.05'),
    maxEstimatedSlippagePct: String(
      await getSettingValue(db, 'phase27_max_estimated_slippage_pct') ?? '0.25',
    ),
    maxHoldingHours: Number(await getSettingValue(db, 'phase27_max_holding_hours') ?? 8),
    defaultQuantity: String(await getSettingValue(db, 'phase27_default_quantity') ?? '1'),
    maxLossPerTradeUsd: String(await getSettingValue(db, 'phase27_max_loss_per_trade_usd') ?? '100'),
    maxTradesPerSymbolPerDay: Number(await getSettingValue(db, 'phase27_max_trades_per_symbol_per_day') ?? 3),
    maxTradesPerDayTotal: Number(await getSettingValue(db, 'phase27_max_trades_per_day_total') ?? 10),
    cooldownSecondsPerSymbol: Number(await getSettingValue(db, 'phase27_cooldown_seconds_per_symbol') ?? 3600),
    sessionMarketOpen: String(await getSettingValue(db, 'phase27_session_market_open') ?? '13:30'),
    sessionMarketClose: String(await getSettingValue(db, 'phase27_session_market_close') ?? '20:00'),
    noNewTradesMinutesBeforeClose: Number(
      await getSettingValue(db, 'phase27_no_new_trades_minutes_before_close') ?? 60,
    ),
    forceCloseBeforeCloseMinutes: Number(
      await getSettingValue(db, 'phase27_force_close_before_close_minutes') ?? 30,
    ),
    forceCloseEnabled: await getSettingValue<boolean>(db, 'phase27_force_close_enabled') ?? true,
  };
}

export function toHourlyConfigDTO(settings: Phase27Settings): HourlyConfigDTO {
  return {
    trend_ema_fast: settings.trendEmaFast,
    trend_ema_slow: settings.trendEmaSlow,
    momentum_window: settings.momentumWindow,
    volume_window: settings.volumeWindow,
    breakout_lookback_bars: settings.breakoutLookbackBars,
    min_volume_ratio: settings.minVolumeRatio,
    atr_window: settings.atrWindow,
    stop_atr_multiple: settings.stopAtrMultiple,
    take_profit_atr_multiple: settings.takeProfitAtrMultiple,
    min_risk_reward: settings.minRiskReward,
    max_spread_pct: settings.maxSpreadPct,
    higher_tf_bars_per_candle: settings.higherTfBarsPerCandle,
    higher_tf_confirmation_required: settings.higherTfConfirmationRequired,
    max_holding_hours: settings.maxHoldingHours,
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
 * session_status_for(): pure time-of-day math against the configured
 * regular US session window. Used by the position-exit reconciler and the
 * scheduler's cheap pre-flight gate. Must stay in lockstep with
 * strategy/common/session.py::session_status_for. */
export function computeHourlySessionStatus(now: Date, settings: Phase27Settings): SessionStatusValue {
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

export async function runHourlyAnalysis(
  symbol: string,
  db: Pool | PoolClient,
  hasOpenPosition: boolean,
  requestId?: string,
): Promise<{ analysis: HourlyAnalysisDTO; settings: Phase27Settings }> {
  const settings = await loadPhase27Settings(db);
  const analysis = await analyzeHourly(symbol, toHourlyConfigDTO(settings), hasOpenPosition, requestId);
  return { analysis, settings };
}

export interface Phase27ControlsInput {
  symbol: string;
  strategyId: string;
  side: 'BUY' | 'SELL';
  analysis: HourlyAnalysisDTO;
  market: MarketSnapshotDTO;
  paperPortfolio: { cash: string; positions: Record<string, string> };
  latestSnapshot: { portfolioEquity: string; dailyPnl: string } | null;
  riskCfg: RiskConfigDTO;
  settings: Phase27Settings;
  requestedQuantity: string;
  excludeProposalId?: string;
}

export interface Phase27ControlsResult {
  quantity: string;
  estimatedNotional: string;
  passed: boolean;
  failedRules: string[];
  reason: string | null;
  snapshot: Record<string, unknown>;
}

/** Server-side sizing and safety gate for hourly (Phase 27) BUY/SELL
 * decisions. Structurally mirrors phase26RiskControls (bidirectional, same
 * two-order-class shape) with two differences: (1) position sizing rounds
 * to whole shares like phase25 (US stocks, not fractional crypto), and (2)
 * an explicit PHASE27_SESSION_STATUS / PHASE27_HOURLY_MODE_DISABLED gate is
 * enforced here rather than solely relying on the shared Python session
 * check, matching phase25's own session-status enforcement. */
export async function phase27RiskControls(
  db: Pool | PoolClient,
  input: Phase27ControlsInput,
): Promise<Phase27ControlsResult> {
  const { analysis, settings, side } = input;
  const entry = decimal(analysis.entry_price);
  const stopLoss = analysis.stop_loss ? decimal(analysis.stop_loss) : null;
  const takeProfit = analysis.take_profit ? decimal(analysis.take_profit) : null;
  const bid = decimal(input.market.bid);
  const ask = decimal(input.market.ask);
  const mid = bid.plus(ask).div(2);
  const spreadPct = mid.gt(0) ? ask.minus(bid).div(mid).mul(100) : new Decimal(0);
  const maxSpreadPct = decimal(settings.maxSpreadPct);
  const estimatedSlippagePct = decimal(settings.estimatedSlippagePct);
  const maxEstimatedSlippagePct = decimal(settings.maxEstimatedSlippagePct);
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

  if (!settings.hourlyModeEnabled) failedRules.push('PHASE27_HOURLY_MODE_DISABLED');
  if (analysis.decision !== side) failedRules.push('PHASE27_NO_ENTRY_SIGNAL');
  if (analysis.session_status !== 'OPEN_FOR_ENTRIES') failedRules.push('PHASE27_SESSION_STATUS');
  if (input.market.is_stale) failedRules.push('PHASE27_FRESH_MARKET_DATA');
  if (spreadPct.gt(maxSpreadPct)) failedRules.push('PHASE27_BID_ASK_SPREAD');
  if (estimatedSlippagePct.gt(maxEstimatedSlippagePct)) failedRules.push('PHASE27_ESTIMATED_SLIPPAGE');
  if (!analysis.liquidity_ok) failedRules.push('PHASE27_LIQUIDITY');

  const riskPerShare = side === 'BUY' && stopLoss ? entry.minus(stopLoss) : new Decimal(0);
  const riskReward = side === 'BUY' && takeProfit && stopLoss && riskPerShare.gt(0)
    ? takeProfit.minus(entry).abs().div(riskPerShare)
    : new Decimal(0);
  if (side === 'BUY') {
    if (riskPerShare.lte(0)) {
      failedRules.push('PHASE27_INVALID_STOP_DISTANCE');
    } else if (riskReward.lt(minRiskReward)) {
      failedRules.push('PHASE27_MIN_RISK_REWARD');
    }
  }

  const estimatedFeePerShare = new Decimal('0.005');
  const minFee = new Decimal('1');
  const slippagePerShare = entry.mul(estimatedSlippagePct.div(100));

  let quantity: Decimal;
  if (side === 'BUY') {
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
    quantity = Decimal.min(
      requestedQuantity,
      riskQuantity,
      cashQuantity,
      positionLimitQuantity,
      concentrationQuantity,
    ).toDecimalPlaces(0, Decimal.ROUND_DOWN);
  } else {
    // SELL closes an existing long — sized to the position held, not
    // risk-budgeted (there is no new stop distance to size against).
    quantity = Decimal.min(requestedQuantity, existingQty).toDecimalPlaces(0, Decimal.ROUND_DOWN);
    if (existingQty.lte(0)) failedRules.push('PHASE27_NO_POSITION_TO_SELL');
  }

  const estimatedFee = Decimal.max(quantity.mul(estimatedFeePerShare), side === 'BUY' ? minFee : new Decimal(0));
  const estimatedSlippageUsd = quantity.mul(slippagePerShare);
  const maxLoss = side === 'BUY'
    ? quantity.mul(riskPerShare).plus(estimatedSlippageUsd).plus(estimatedFee)
    : new Decimal(0);

  if (quantity.lte(0)) failedRules.push('PHASE27_POSITION_SIZE');
  if (side === 'BUY' && maxLoss.gt(maxLossPerTradeUsd)) failedRules.push('PHASE27_MAX_LOSS_PER_TRADE');
  if (dailyPnl.lt(maxDailyLossUsd.neg())) failedRules.push('PHASE27_MAX_DAILY_LOSS');
  if (side === 'BUY' && existingQty.gt(0)) failedRules.push('PHASE27_DUPLICATE_EXPOSURE');

  const activeOrders = await findActiveOrdersBySymbol(db, input.symbol);
  if (activeOrders.length > 0) failedRules.push('PHASE27_DUPLICATE_PENDING_ORDER');
  if (side === 'BUY') {
    const activeExposure = await findActiveExposureProposals(db, input.excludeProposalId);
    if (activeExposure.some((proposal) => proposal.symbol === input.symbol)) {
      if (!failedRules.includes('PHASE27_DUPLICATE_EXPOSURE')) failedRules.push('PHASE27_DUPLICATE_EXPOSURE');
    }
  }

  const latestFill = await findLatestFillBySymbol(db, input.symbol);
  const cooldownRemaining = latestFill && settings.cooldownSecondsPerSymbol > 0
    ? Math.max(
      0,
      settings.cooldownSecondsPerSymbol
        - Math.floor((Date.now() - latestFill.filledAt.getTime()) / 1000),
    )
    : 0;
  if (cooldownRemaining > 0) failedRules.push('PHASE27_COOLDOWN');

  const tradesTodayForSymbol = await countProposalsForStrategyToday(db, input.strategyId, input.symbol);
  const tradesTodayTotal = await countProposalsForStrategyToday(db, input.strategyId);
  if (tradesTodayForSymbol >= settings.maxTradesPerSymbolPerDay) {
    failedRules.push('PHASE27_MAX_TRADES_PER_SYMBOL_PER_DAY');
  }
  if (tradesTodayTotal >= settings.maxTradesPerDayTotal) {
    failedRules.push('PHASE27_MAX_TRADES_PER_DAY_TOTAL');
  }

  const snapshot: Record<string, unknown> = {
    phase: '27',
    source: 'HOURLY_TREND',
    orderClass: side === 'BUY' ? 'BRACKET' : 'SINGLE',
    candleTimestamp: analysis.candle_timestamp,
    strategyVersion: analysis.strategy_version,
    entry: money(entry),
    stopLoss: stopLoss ? money(stopLoss) : null,
    takeProfit: takeProfit ? money(takeProfit) : null,
    riskReward: side === 'BUY' ? money(riskReward) : null,
    atr: analysis.atr,
    trendDirection: analysis.trend_direction,
    momentumPct: analysis.momentum_pct,
    volumeRatio: analysis.volume_ratio,
    breakout: analysis.breakout,
    pullback: analysis.pullback,
    higherTfTrendDirection: analysis.higher_tf_trend_direction,
    higherTfConfirmed: analysis.higher_tf_confirmed,
    sessionStatus: analysis.session_status,
    expectedHoldingHours: analysis.expected_holding_hours,
    maxHoldingHours: settings.maxHoldingHours,
    forceCloseBeforeCloseMinutes: settings.forceCloseBeforeCloseMinutes,
    forceCloseEnabled: settings.forceCloseEnabled,
    requestedQuantity: money(requestedQuantity),
    quantity: money(quantity),
    maxLoss: money(maxLoss),
    riskBudget: money(maxLossPerTradeUsd),
    spreadPct: money(spreadPct),
    estimatedSlippagePct: money(estimatedSlippagePct),
    estimatedSlippageUsd: money(estimatedSlippageUsd),
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
    reason: failedRules.length ? `Phase 27 risk controls failed: ${failedRules.join(', ')}` : null,
    snapshot,
  };
}

export async function ensureHourlyStrategy(db: Pool | PoolClient) {
  return upsertStrategy(db, {
    name: HOURLY_STRATEGY_NAME,
    description: 'Phase 27 hourly trend PAPER ONLY strategy. Never submits broker orders.',
    version: HOURLY_STRATEGY_VERSION,
    parameters: { source: 'hourly_trend', tradingMode: 'PAPER' },
    isActive: true,
  });
}
