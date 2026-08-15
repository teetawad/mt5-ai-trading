import Decimal from 'decimal.js';

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
  const maxRiskPct = setting(input.settings, 'mt5_max_risk_per_trade_pct', '0.50');
  const maxLoss = setting(input.settings, 'mt5_max_loss_per_trade', '100');
  const minRr = setting(input.settings, 'mt5_min_risk_reward', '1.5');
  const maxPositions = Number(input.settings.mt5_max_simultaneous_positions ?? 3);
  const maxTrades = Number(input.settings.mt5_max_trades_per_day ?? 6);
  const quoteStale = Number(input.settings.mt5_quote_staleness_seconds ?? 10);
  const maxSpread = Number(input.settings.mt5_max_spread_points ?? 50);
  const riskBudget = Decimal.min(maxLoss, equity.mul(maxRiskPct).div(100));
  const riskDistance = sl ? entry.minus(sl).abs() : new Decimal(0);
  const rr = input.riskReward ? dec(input.riskReward) : tp && sl ? tp.minus(entry).abs().div(riskDistance) : new Decimal(0);
  const estimatedLossPerLot = riskDistance;
  const rawVolume = estimatedLossPerLot.gt(0) ? riskBudget.div(estimatedLossPerLot) : new Decimal(0);
  const volume = normalizeVolume(rawVolume, new Decimal('0.01'), new Decimal('100'), new Decimal('0.01'));

  if (input.settings.mt5_kill_switch_enabled !== false) failed.push('KILL_SWITCH');
  if (input.decision !== 'BUY' && input.decision !== 'SELL') failed.push('NO_EXECUTABLE_DECISION');
  if (!sl) failed.push('STOP_LOSS_REQUIRED');
  if (!tp) failed.push('TAKE_PROFIT_REQUIRED');
  if (riskDistance.lte(0)) failed.push('INVALID_STOP_DISTANCE');
  if (rr.lt(minRr)) failed.push('MIN_RISK_REWARD');
  if (input.openPositions >= maxPositions) failed.push('MAX_SIMULTANEOUS_POSITIONS');
  if (input.tradesToday >= maxTrades) failed.push('MAX_TRADES_PER_DAY');
  if ((input.quoteAgeSeconds ?? 0) > quoteStale) failed.push('STALE_QUOTE');
  if ((input.spreadPoints ?? 0) > maxSpread) failed.push('SPREAD_LIMIT');
  if (freeMargin.lte(0)) failed.push('FREE_MARGIN_GUARD');
  if (volume.lte(0)) failed.push('POSITION_SIZE');

  const snapshot = {
    authority: 'SERVER_SIDE_MT5_RISK_ENGINE',
    riskBudget: riskBudget.toFixed(8),
    riskDistance: riskDistance.toFixed(8),
    riskReward: rr.toFixed(8),
    recommendedVolume: volume.toFixed(8),
    maxRiskPct: maxRiskPct.toFixed(8),
    maxLossPerTrade: maxLoss.toFixed(8),
    openPositions: input.openPositions,
    tradesToday: input.tradesToday,
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
