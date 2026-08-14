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
  CryptoAnalysisDTO,
  CryptoConfigDTO,
  MarketSnapshotDTO,
  RiskConfigDTO,
  analyzeCrypto,
} from './trading-engine-client';

export const CRYPTO_STRATEGY_NAME = 'CRYPTO_MULTI_TIMEFRAME_PAPER_ONLY';

export interface Phase26Settings {
  cryptoTradingEnabled: boolean;
  supportedSymbols: string[];
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
  minVolumeRatio: string;
  maxSpreadPct: string;
  estimatedSlippagePct: string;
  maxEstimatedSlippagePct: string;
  feeBps: number;
  defaultQuantity: string;
  maxLossPerTradeUsd: string;
  maxDailyLossUsd: string;
  maxTradesPerSymbolPerDay: number;
  maxTradesPerDayTotal: number;
  cooldownSecondsPerSymbol: number;
}

function decimal(value: string | number | null | undefined): Decimal {
  return new Decimal(value ?? '0');
}

function money(value: Decimal): string {
  return value.toDecimalPlaces(8).toFixed(8);
}

export async function loadPhase26Settings(db: Pool | PoolClient): Promise<Phase26Settings> {
  return {
    cryptoTradingEnabled: await getSettingValue<boolean>(db, 'phase26_crypto_trading_enabled') ?? false,
    supportedSymbols: await getSettingValue<string[]>(db, 'phase26_supported_symbols') ?? ['BTC/USD', 'ETH/USD'],
    trendEmaFast: Number(await getSettingValue(db, 'phase26_trend_ema_fast') ?? 8),
    trendEmaSlow: Number(await getSettingValue(db, 'phase26_trend_ema_slow') ?? 21),
    setupMomentumWindow: Number(await getSettingValue(db, 'phase26_setup_momentum_window') ?? 6),
    setupVolumeWindow: Number(await getSettingValue(db, 'phase26_setup_volume_window') ?? 20),
    entryMomentumWindow: Number(await getSettingValue(db, 'phase26_entry_momentum_window') ?? 3),
    entryVolumeWindow: Number(await getSettingValue(db, 'phase26_entry_volume_window') ?? 20),
    atrWindow: Number(await getSettingValue(db, 'phase26_atr_window') ?? 14),
    stopAtrMultiple: String(await getSettingValue(db, 'phase26_stop_atr_multiple') ?? '1.5'),
    takeProfitAtrMultiple: String(await getSettingValue(db, 'phase26_take_profit_atr_multiple') ?? '3.0'),
    minRiskReward: String(await getSettingValue(db, 'phase26_min_risk_reward') ?? '1.5'),
    minVolumeRatio: String(await getSettingValue(db, 'phase26_min_volume_ratio') ?? '1.0'),
    maxSpreadPct: String(await getSettingValue(db, 'phase26_max_spread_pct') ?? '0.75'),
    estimatedSlippagePct: String(await getSettingValue(db, 'phase26_estimated_slippage_pct') ?? '0.10'),
    maxEstimatedSlippagePct: String(await getSettingValue(db, 'phase26_max_estimated_slippage_pct') ?? '0.50'),
    feeBps: Number(await getSettingValue(db, 'phase26_fee_bps') ?? 10),
    defaultQuantity: String(await getSettingValue(db, 'phase26_default_quantity') ?? '0.01'),
    maxLossPerTradeUsd: String(await getSettingValue(db, 'phase26_max_loss_per_trade_usd') ?? '100'),
    maxDailyLossUsd: String(await getSettingValue(db, 'phase26_max_daily_loss_usd') ?? '300'),
    maxTradesPerSymbolPerDay: Number(await getSettingValue(db, 'phase26_max_trades_per_symbol_per_day') ?? 5),
    maxTradesPerDayTotal: Number(await getSettingValue(db, 'phase26_max_trades_per_day_total') ?? 15),
    cooldownSecondsPerSymbol: Number(await getSettingValue(db, 'phase26_cooldown_seconds_per_symbol') ?? 900),
  };
}

export function toCryptoConfigDTO(settings: Phase26Settings): CryptoConfigDTO {
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
    quantity: settings.defaultQuantity,
  };
}

export async function runCryptoAnalysis(
  symbol: string,
  db: Pool | PoolClient,
  hasOpenPosition: boolean,
  requestId?: string,
): Promise<{ analysis: CryptoAnalysisDTO; settings: Phase26Settings }> {
  const settings = await loadPhase26Settings(db);
  const analysis = await analyzeCrypto(symbol, toCryptoConfigDTO(settings), hasOpenPosition, requestId);
  return { analysis, settings };
}

export interface Phase26ControlsInput {
  symbol: string;
  strategyId: string;
  side: 'BUY' | 'SELL';
  analysis: CryptoAnalysisDTO;
  market: MarketSnapshotDTO;
  paperPortfolio: { cash: string; positions: Record<string, string> };
  latestSnapshot: { portfolioEquity: string; dailyPnl: string } | null;
  riskCfg: RiskConfigDTO;
  settings: Phase26Settings;
  requestedQuantity: string;
  excludeProposalId?: string;
}

export interface Phase26ControlsResult {
  quantity: string;
  estimatedNotional: string;
  passed: boolean;
  failedRules: string[];
  reason: string | null;
  snapshot: Record<string, unknown>;
}

/** Server-side sizing and safety gate for crypto (Phase 26) BUY/SELL decisions.
 * Mirrors trade-proposal-service.ts's phase22RiskControls / phase25RiskControls
 * with two crypto-specific differences: (1) position sizing rounds to 8
 * decimal places (fractional BTC/ETH) instead of whole units, and (2) an
 * additional `phase26_max_daily_loss_usd` gate is layered on top of the
 * platform-wide MAX_DAILY_LOSS check — a tighter, crypto-specific budget the
 * owner can configure independently of the stock daily-loss limit. */
export async function phase26RiskControls(
  db: Pool | PoolClient,
  input: Phase26ControlsInput,
): Promise<Phase26ControlsResult> {
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
  const cryptoMaxDailyLossUsd = decimal(settings.maxDailyLossUsd);
  const maxPositionSizeUsd = decimal(input.riskCfg.max_position_size_usd);
  const maxConcentrationPct = decimal(input.riskCfg.max_portfolio_concentration_pct);
  const platformMaxDailyLossUsd = decimal(input.riskCfg.max_daily_loss_usd);
  const cash = decimal(input.paperPortfolio.cash);
  const equity = decimal(input.latestSnapshot?.portfolioEquity ?? input.paperPortfolio.cash);
  const dailyPnl = decimal(input.latestSnapshot?.dailyPnl);
  const existingQty = decimal(input.paperPortfolio.positions[input.symbol]);
  const requestedQuantity = decimal(input.requestedQuantity);

  const failedRules: string[] = [];

  if (!settings.cryptoTradingEnabled) failedRules.push('PHASE26_CRYPTO_TRADING_DISABLED');
  if (analysis.decision !== side) failedRules.push('PHASE26_NO_ENTRY_SIGNAL');
  if (input.market.is_stale) failedRules.push('PHASE26_FRESH_MARKET_DATA');
  if (spreadPct.gt(maxSpreadPct)) failedRules.push('PHASE26_BID_ASK_SPREAD');
  if (estimatedSlippagePct.gt(maxEstimatedSlippagePct)) failedRules.push('PHASE26_ESTIMATED_SLIPPAGE');
  if (!analysis.liquidity_ok) failedRules.push('PHASE26_LIQUIDITY');

  const riskPerUnit = side === 'BUY' && stopLoss ? entry.minus(stopLoss) : new Decimal(0);
  const riskReward = side === 'BUY' && takeProfit && stopLoss && riskPerUnit.gt(0)
    ? takeProfit.minus(entry).abs().div(riskPerUnit)
    : new Decimal(0);
  if (side === 'BUY') {
    if (riskPerUnit.lte(0)) {
      failedRules.push('PHASE26_INVALID_STOP_DISTANCE');
    } else if (riskReward.lt(minRiskReward)) {
      failedRules.push('PHASE26_MIN_RISK_REWARD');
    }
  }

  const feeBps = new Decimal(settings.feeBps);
  const feePerUnit = entry.mul(feeBps.div(10000));
  const slippagePerUnit = entry.mul(estimatedSlippagePct.div(100));

  let quantity: Decimal;
  if (side === 'BUY') {
    const riskQuantity = riskPerUnit.gt(0)
      ? maxLossPerTradeUsd.div(riskPerUnit.plus(slippagePerUnit).plus(feePerUnit))
      : new Decimal(0);
    const cashQuantity = entry.plus(slippagePerUnit).gt(0)
      ? cash.div(entry.plus(slippagePerUnit))
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
    ).toDecimalPlaces(8, Decimal.ROUND_DOWN);
  } else {
    // SELL closes an existing long — sized to the position held, not
    // risk-budgeted (there is no new stop distance to size against).
    quantity = Decimal.min(requestedQuantity, existingQty).toDecimalPlaces(8, Decimal.ROUND_DOWN);
    if (existingQty.lte(0)) failedRules.push('PHASE26_NO_POSITION_TO_SELL');
  }

  const estimatedFee = quantity.mul(feePerUnit);
  const estimatedSlippageUsd = quantity.mul(slippagePerUnit);
  const maxLoss = side === 'BUY'
    ? quantity.mul(riskPerUnit).plus(estimatedSlippageUsd).plus(estimatedFee)
    : new Decimal(0);

  if (quantity.lte(0)) failedRules.push('PHASE26_POSITION_SIZE');
  if (side === 'BUY' && maxLoss.gt(maxLossPerTradeUsd)) failedRules.push('PHASE26_MAX_LOSS_PER_TRADE');
  if (dailyPnl.lt(platformMaxDailyLossUsd.neg())) failedRules.push('PHASE26_PLATFORM_MAX_DAILY_LOSS');
  if (dailyPnl.lt(cryptoMaxDailyLossUsd.neg())) failedRules.push('PHASE26_CRYPTO_MAX_DAILY_LOSS');
  if (side === 'BUY' && existingQty.gt(0)) failedRules.push('PHASE26_DUPLICATE_EXPOSURE');

  const activeOrders = await findActiveOrdersBySymbol(db, input.symbol);
  if (activeOrders.length > 0) failedRules.push('PHASE26_DUPLICATE_PENDING_ORDER');
  if (side === 'BUY') {
    const activeExposure = await findActiveExposureProposals(db, input.excludeProposalId);
    if (activeExposure.some((proposal) => proposal.symbol === input.symbol)) {
      if (!failedRules.includes('PHASE26_DUPLICATE_EXPOSURE')) failedRules.push('PHASE26_DUPLICATE_EXPOSURE');
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
  if (cooldownRemaining > 0) failedRules.push('PHASE26_COOLDOWN');

  const tradesTodayForSymbol = await countProposalsForStrategyToday(db, input.strategyId, input.symbol);
  const tradesTodayTotal = await countProposalsForStrategyToday(db, input.strategyId);
  if (tradesTodayForSymbol >= settings.maxTradesPerSymbolPerDay) {
    failedRules.push('PHASE26_MAX_TRADES_PER_SYMBOL_PER_DAY');
  }
  if (tradesTodayTotal >= settings.maxTradesPerDayTotal) {
    failedRules.push('PHASE26_MAX_TRADES_PER_DAY_TOTAL');
  }

  const snapshot: Record<string, unknown> = {
    phase: '26',
    source: 'CRYPTO_MULTI_TIMEFRAME',
    assetClass: 'CRYPTO',
    orderClass: side === 'BUY' ? 'BRACKET' : 'SINGLE',
    marketStatus: analysis.market_status,
    entry: money(entry),
    stopLoss: stopLoss ? money(stopLoss) : null,
    takeProfit: takeProfit ? money(takeProfit) : null,
    riskReward: side === 'BUY' ? money(riskReward) : null,
    atr: analysis.atr,
    trendDirection: analysis.trend_direction,
    setupConfirmed: analysis.setup_confirmed,
    entryConfirmed: analysis.entry_confirmed,
    volumeSignal: analysis.volume_signal,
    requestedQuantity: money(requestedQuantity),
    quantity: money(quantity),
    maxLoss: money(maxLoss),
    riskBudget: money(maxLossPerTradeUsd),
    spreadPct: money(spreadPct),
    estimatedSlippagePct: money(estimatedSlippagePct),
    estimatedSlippageUsd: money(estimatedSlippageUsd),
    feeBps: settings.feeBps,
    estimatedFee: money(estimatedFee),
    dailyLossUsed: money(dailyPnl.lt(0) ? dailyPnl.abs() : new Decimal(0)),
    cryptoDailyLossLimit: money(cryptoMaxDailyLossUsd),
    platformDailyLossLimit: money(platformMaxDailyLossUsd),
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
    reason: failedRules.length ? `Phase 26 risk controls failed: ${failedRules.join(', ')}` : null,
    snapshot,
  };
}

export async function ensureCryptoStrategy(db: Pool | PoolClient) {
  return upsertStrategy(db, {
    name: CRYPTO_STRATEGY_NAME,
    description: 'Phase 26 crypto multi-timeframe PAPER ONLY strategy. Never submits broker orders.',
    version: '26.0.0',
    parameters: { source: 'crypto_multi_timeframe', tradingMode: 'PAPER' },
    isActive: true,
  });
}
