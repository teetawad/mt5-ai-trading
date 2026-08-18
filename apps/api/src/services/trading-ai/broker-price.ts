// Broker-aware price normalization/validation (spec section "BROKER-AWARE
// MT5 VALIDATION"). The AI reasons in whatever precision it likes; MT5 only
// ever accepts prices at the broker's own digits, and rejects orders whose
// stop/entry distance from the current price is below trade_stops_level
// points. This module only rounds and checks — it never invents or silently
// repairs a materially invalid price; the Risk Engine (evaluateMt5Risk)
// remains the sole authority on whether a trade may proceed.

export function roundToDigits(value: number, digits: number | null | undefined): number {
  if (digits === null || digits === undefined || !Number.isFinite(digits) || digits < 0) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export interface BrokerStopDistanceInput {
  // The pending-order/market entry anchor (entry_price/trigger_price) and
  // the real current market price it is measured against.
  referenceEntry: number;
  currentPrice: number | null;
  stopLoss: number;
  takeProfit: number;
  entryType: 'MARKET_NOW' | 'PULLBACK' | 'BREAKOUT';
  // symbol_info() point size and trade_stops_level (in POINTS, not price) —
  // absent/non-positive means the broker imposes no known minimum distance,
  // so nothing to check.
  point: number | null;
  stopsLevelPoints: number | null;
}

export interface BrokerStopDistanceResult {
  ok: boolean;
  reason: 'BROKER_STOP_DISTANCE_SL' | 'BROKER_STOP_DISTANCE_TP' | 'BROKER_STOP_DISTANCE_ENTRY' | null;
}

export function checkBrokerStopDistance(input: BrokerStopDistanceInput): BrokerStopDistanceResult {
  const point = input.point;
  const stopsLevel = input.stopsLevelPoints;
  if (!point || point <= 0 || !stopsLevel || stopsLevel <= 0) return { ok: true, reason: null };

  const minDistance = point * stopsLevel;
  if (Math.abs(input.referenceEntry - input.stopLoss) < minDistance) return { ok: false, reason: 'BROKER_STOP_DISTANCE_SL' };
  if (Math.abs(input.takeProfit - input.referenceEntry) < minDistance) return { ok: false, reason: 'BROKER_STOP_DISTANCE_TP' };
  if (input.entryType !== 'MARKET_NOW' && input.currentPrice !== null) {
    if (Math.abs(input.referenceEntry - input.currentPrice) < minDistance) return { ok: false, reason: 'BROKER_STOP_DISTANCE_ENTRY' };
  }
  return { ok: true, reason: null };
}
