import Decimal from 'decimal.js';

export interface Mt5RiskSymbolInfo {
  contractSize: number;
  tickSize: number;
  tickValueLoss: number;
  tickValueProfit: number;
  volumeMin: number;
  volumeMax: number;
  volumeStep: number;
  point: number;
}

export interface Mt5RiskInput {
  decision: 'BUY' | 'SELL' | 'HOLD' | 'NO_TRADE';
  referenceEntry: string;
  stopLoss: string | null;
  takeProfit: string | null;
  riskReward: string | null;
  confidence: number;
  account: Record<string, unknown> | null | undefined;
  terminal: Record<string, unknown> | null | undefined;
  settings: Record<string, unknown>;
  openPositions: number;
  tradesToday: number;
  quoteAgeSeconds?: number;
  spreadPoints?: number;
  marketStatus?: 'OPEN' | 'CLOSED' | 'QUOTE_ONLY' | 'TRADE_DISABLED' | 'UNKNOWN';
  dataStatus?: 'LIVE' | 'STALE' | 'DISCONNECTED';
  // Real broker economics for this symbol (symbol_info()) — required for a
  // trustworthy volume/margin calculation. When absent, sizing is rejected
  // rather than falling back to a naive price-difference guess.
  symbol?: Mt5RiskSymbolInfo | null;
  // account leverage (e.g. 1000 for 1:1000) — required for the margin check.
  leverage?: number | null;
}

export interface Mt5RiskResult {
  result: 'PASS' | 'REJECT';
  failedRules: string[];
  reason: string | null;
  recommendedVolume: string;
  riskAmount: string;
  snapshot: Record<string, unknown>;
}

function dec(value: unknown, fallback = '0'): Decimal {
  return new Decimal(String(value ?? fallback));
}

function setting(settings: Record<string, unknown>, key: string, fallback: string): Decimal {
  return dec(settings[key], fallback);
}

// Maps a raw symbol_info() passthrough dict (see getMt5SymbolInfo) onto the
// fields evaluateMt5Risk actually needs. Returns null (never a guessed
// default) when a field this app cannot safely proceed without is missing
// or non-numeric — the risk engine then rejects with SYMBOL_INFO_UNAVAILABLE
// rather than silently falling back to a made-up value.
export function toRiskSymbolInfo(info: Record<string, unknown> | null | undefined): Mt5RiskSymbolInfo | null {
  if (!info) return null;
  const contractSize = Number(info.trade_contract_size);
  const tickSize = Number(info.trade_tick_size ?? info.point);
  const tickValueLoss = Number(info.trade_tick_value_loss ?? info.trade_tick_value);
  const tickValueProfit = Number(info.trade_tick_value_profit ?? info.trade_tick_value);
  const volumeMin = Number(info.volume_min);
  const volumeMax = Number(info.volume_max);
  const volumeStep = Number(info.volume_step);
  const point = Number(info.point ?? tickSize);
  if (![contractSize, tickSize, volumeMin, volumeMax, volumeStep].every(Number.isFinite)) return null;
  if (contractSize <= 0 || tickSize <= 0 || volumeMin <= 0 || volumeMax <= 0 || volumeStep <= 0) return null;
  return {
    contractSize,
    tickSize,
    tickValueLoss: Number.isFinite(tickValueLoss) && tickValueLoss > 0 ? tickValueLoss : (Number.isFinite(tickValueProfit) ? tickValueProfit : 0),
    tickValueProfit: Number.isFinite(tickValueProfit) ? tickValueProfit : 0,
    volumeMin,
    volumeMax,
    volumeStep,
    point: Number.isFinite(point) && point > 0 ? point : tickSize,
  };
}

export function normalizeVolume(raw: Decimal, min: Decimal, max: Decimal, step: Decimal): Decimal {
  if (raw.lt(min)) return new Decimal(0);
  const bounded = Decimal.min(raw, max);
  if (step.lte(0)) return bounded;
  return bounded.div(step).floor().mul(step);
}

export function evaluateMt5Risk(input: Mt5RiskInput): Mt5RiskResult {
  const failed: string[] = [];
  const entry = dec(input.referenceEntry);
  const sl = input.stopLoss ? dec(input.stopLoss) : null;
  const tp = input.takeProfit ? dec(input.takeProfit) : null;
  const equity = dec(input.account?.equity, input.account?.balance ? String(input.account.balance) : '0');
  const freeMargin = dec(input.account?.margin_free ?? input.account?.free_margin, '0');
  const leverage = dec(input.leverage ?? input.account?.leverage, '0');
  const maxRiskPct = setting(input.settings, 'mt5_max_risk_per_trade_pct', '0.50');
  const maxLoss = setting(input.settings, 'mt5_max_loss_per_trade', '100');
  const minRr = setting(input.settings, 'mt5_min_risk_reward', '1.5');
  const maxPositions = Number(input.settings.mt5_max_simultaneous_positions ?? 3);
  const maxTrades = Number(input.settings.mt5_max_trades_per_day ?? 6);
  const quoteStale = Number(input.settings.mt5_quote_staleness_seconds ?? 10);
  const maxSpread = Number(input.settings.mt5_max_spread_points ?? 50);
  // How much of current free margin a single new position may consume — a
  // second, independent safety layer on top of the per-trade risk budget,
  // so a mis-sized volume can never eat all available margin even if the
  // dollar-risk-at-SL math alone would have allowed it.
  const marginBufferPct = setting(input.settings, 'mt5_margin_safety_buffer_pct', '50');

  const riskBudget = Decimal.min(maxLoss, equity.mul(maxRiskPct).div(100));
  const riskDistance = sl ? entry.minus(sl).abs() : new Decimal(0);
  const rr = input.riskReward ? dec(input.riskReward) : tp && sl ? tp.minus(entry).abs().div(riskDistance) : new Decimal(0);

  // --- Broker-native position sizing --------------------------------------
  // A raw price-difference × lot calculation is only correct by accident:
  // it silently assumes the account currency, the quote currency, and the
  // contract size all line up (true for a plain XXXUSD pair on a 100,000
  // contract, false in general — e.g. AUDZAR, where neither leg is the
  // account's deposit currency). MT5's own economics for "how much money
  // does 1 lot lose per unit of price movement" are exactly
  // trade_tick_value_loss (or trade_tick_value as a fallback) scaled by
  // trade_tick_size, both taken directly from symbol_info() — this is the
  // same effective math MT5 itself uses for order_calc_profit(). Never
  // available -> refuse to guess a volume, reject instead.
  // Collected separately from `failed` so fundamental gates (kill switch,
  // market/data status, missing SL/TP) always take priority as failedRules[0]
  // when several things are wrong at once — sizing detail is appended last.
  const sizingFailed: string[] = [];
  const symbol = input.symbol ?? null;
  let volume = new Decimal(0);
  let lossPerLot = new Decimal(0);
  let expectedLossAtSl = new Decimal(0);
  let marginRequired = new Decimal(0);
  let rawVolumeBeforeNormalize = new Decimal(0);

  if (!symbol) {
    sizingFailed.push('SYMBOL_INFO_UNAVAILABLE');
  } else {
    const tickSize = dec(symbol.tickSize);
    const tickValueLoss = dec(symbol.tickValueLoss || symbol.tickValueProfit, '0');
    const contractSize = dec(symbol.contractSize, '0');
    const volumeMin = dec(symbol.volumeMin, '0.01');
    const volumeMax = dec(symbol.volumeMax, '0');
    const volumeStep = dec(symbol.volumeStep, '0.01');

    lossPerLot = tickSize.gt(0) && riskDistance.gt(0)
      ? riskDistance.div(tickSize).mul(tickValueLoss)
      : new Decimal(0);

    rawVolumeBeforeNormalize = lossPerLot.gt(0) ? riskBudget.div(lossPerLot) : new Decimal(0);
    volume = normalizeVolume(rawVolumeBeforeNormalize, volumeMin, volumeMax, volumeStep);

    if (volume.lte(0) && lossPerLot.gt(0)) {
      // rawVolumeBeforeNormalize > 0 but still floored to 0 by volumeMin
      // means even the smallest tradeable size already risks more than the
      // configured budget — a distinct, specific reason from "no valid
      // size could be computed at all".
      const minLotLoss = volumeMin.mul(lossPerLot);
      if (minLotLoss.gt(riskBudget)) {
        sizingFailed.push('MINIMUM_VOLUME_EXCEEDS_RISK');
      } else {
        sizingFailed.push('POSITION_SIZE_INVALID');
      }
    } else if (volume.lte(0)) {
      sizingFailed.push('POSITION_SIZE_INVALID');
    }

    expectedLossAtSl = volume.mul(lossPerLot);

    // Standard linear (Forex/CFD) margin formula: margin = volume *
    // contract_size * price / leverage — the same formula MT5 itself uses
    // for SYMBOL_CALC_MODE_FOREX/CFD instruments, which is what this app
    // trades. The execution-time recheck additionally confirms this against
    // a live order_check() before any order is ever sent.
    if (volume.gt(0) && contractSize.gt(0) && leverage.gt(0)) {
      marginRequired = volume.mul(contractSize).mul(entry).div(leverage);
      const marginAllowance = freeMargin.mul(marginBufferPct).div(100);
      if (marginRequired.gt(marginAllowance)) {
        sizingFailed.push('INSUFFICIENT_MARGIN');
      }
    } else if (volume.gt(0)) {
      // Missing leverage/contract size means margin truly cannot be
      // verified — never let a plan pass with an un-checked margin.
      sizingFailed.push('MARGIN_UNVERIFIABLE');
    }
  }

  if (input.settings.mt5_kill_switch_enabled !== false) failed.push('SAFETY_SWITCH_ON');
  if (input.marketStatus === 'CLOSED') failed.push('MARKET_CLOSED');
  else if (input.marketStatus && input.marketStatus !== 'OPEN') failed.push(`BLOCKED_MARKET_${input.marketStatus}`);
  if (input.dataStatus === 'STALE') failed.push('STALE_DATA');
  else if (input.dataStatus && input.dataStatus !== 'LIVE') failed.push(`DATA_${input.dataStatus}`);
  if (input.decision !== 'BUY' && input.decision !== 'SELL') failed.push('NO_EXECUTABLE_DECISION');
  if (!sl) failed.push('STOP_LOSS_REQUIRED');
  if (!tp) failed.push('TAKE_PROFIT_REQUIRED');
  if (riskDistance.lte(0)) failed.push('INVALID_STOP_DISTANCE');
  if (rr.lt(minRr)) failed.push('RISK_REWARD_TOO_LOW');
  if (input.openPositions >= maxPositions) failed.push('MAX_SIMULTANEOUS_POSITIONS');
  if (input.tradesToday >= maxTrades) failed.push('MAX_TRADES_PER_DAY');
  if ((input.quoteAgeSeconds ?? 0) > quoteStale) failed.push('STALE_QUOTE');
  if ((input.spreadPoints ?? 0) > maxSpread) failed.push('SPREAD_TOO_HIGH');
  if (freeMargin.lte(0)) failed.push('MARGIN_INSUFFICIENT');
  failed.push(...sizingFailed);

  const freeMarginAfterEntry = freeMargin.minus(marginRequired);
  const riskPctOfEquity = equity.gt(0) ? expectedLossAtSl.div(equity).mul(100) : new Decimal(0);
  const dailyTradesRemaining = Math.max(0, maxTrades - input.tradesToday);

  const snapshot = {
    authority: 'SERVER_SIDE_MT5_RISK_ENGINE',
    riskBudget: riskBudget.toFixed(8),
    riskDistance: riskDistance.toFixed(8),
    riskReward: rr.toFixed(8),
    recommendedVolume: volume.toFixed(8),
    rawVolumeBeforeNormalize: rawVolumeBeforeNormalize.toFixed(8),
    lossPerLot: lossPerLot.toFixed(8),
    expectedLossAtSl: expectedLossAtSl.toFixed(8),
    marginRequired: marginRequired.toFixed(8),
    freeMargin: freeMargin.toFixed(8),
    freeMarginAfterEntry: freeMarginAfterEntry.toFixed(8),
    riskPctOfEquity: riskPctOfEquity.toFixed(8),
    maxRiskPct: maxRiskPct.toFixed(8),
    maxLossPerTrade: maxLoss.toFixed(8),
    openPositions: input.openPositions,
    dailyConfirmedTrades: input.tradesToday,
    dailyTradeLimit: maxTrades,
    dailyTradesRemaining,
    marketStatus: input.marketStatus ?? 'UNKNOWN',
    dataStatus: input.dataStatus ?? 'UNKNOWN',
    failedRules: failed,
  };

  return {
    result: failed.length ? 'REJECT' : 'PASS',
    failedRules: failed,
    reason: failed.length ? `MT5 risk rejected: ${failed.join(', ')}` : null,
    recommendedVolume: volume.toFixed(8),
    riskAmount: riskBudget.toFixed(8),
    snapshot,
  };
}
