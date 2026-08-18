import {
  getMt5Bars,
  getMt5Status,
  getMt5SymbolInfo,
  getMt5Tick,
  listMt5PendingOrders,
  listMt5Positions,
} from '../mt5-client';
import {
  atr,
  Bar,
  ema,
  lastFinite,
  macd,
  recentHighLow,
  rsi,
  sma,
  supportResistanceCandidates,
  trendFromMovingAverages,
} from './indicators';
import { MarketAnalysisPackage, TimeframeSnapshot } from './types';

const TIMEFRAMES: TimeframeSnapshot['timeframe'][] = ['M5', 'M15', 'H1', 'H4'];
const BARS_PER_TIMEFRAME = 220;

function toBars(raw: Record<string, unknown>[]): Bar[] {
  return raw
    .map((row) => ({
      time: Number(row.time),
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      tick_volume: Number(row.tick_volume ?? 0),
    }))
    .filter((bar) => Number.isFinite(bar.time) && Number.isFinite(bar.close))
    .sort((a, b) => a.time - b.time);
}

async function buildTimeframeSnapshot(symbol: string, timeframe: TimeframeSnapshot['timeframe'], requestId?: string): Promise<TimeframeSnapshot> {
  const raw = await getMt5Bars(symbol, timeframe, BARS_PER_TIMEFRAME, requestId);
  const bars = toBars(raw);
  // Use only completed candles for strategic analysis (spec section 4) — the
  // most recent bar from copy_rates_from_pos(..., start_pos=1, ...) is
  // already the last CLOSED candle (start_pos=0 would be the forming one),
  // so no extra trimming is needed here; this mirrors the existing
  // deterministic baseline's own "completed candles only" contract.
  const closes = bars.map((bar) => bar.close);
  const last = bars.at(-1) ?? null;

  const sma20 = lastFinite(sma(closes, 20));
  const sma50 = lastFinite(sma(closes, 50));
  const ema20 = lastFinite(ema(closes, 20));
  const ema50 = lastFinite(ema(closes, 50));
  const macdResult = macd(closes);
  const { high, low } = recentHighLow(bars, 40);

  return {
    timeframe,
    barCount: bars.length,
    lastClosedTime: last ? new Date(last.time * 1000).toISOString() : null,
    open: last?.open ?? null,
    high: last?.high ?? null,
    low: last?.low ?? null,
    close: last?.close ?? null,
    tickVolume: last?.tick_volume ?? null,
    sma20,
    sma50,
    ema20,
    ema50,
    rsi14: bars.length ? rsi(closes, 14) : null,
    atr14: bars.length ? atr(bars, 14) : null,
    macd: macdResult.macd,
    macdSignal: macdResult.signal,
    macdHistogram: macdResult.histogram,
    recentHigh: high,
    recentLow: low,
    supportResistance: supportResistanceCandidates(bars),
    trend: trendFromMovingAverages(ema20, ema50, last?.close ?? null),
  };
}

/**
 * Builds the structured MarketAnalysisPackage the Trading AI receives.
 * Everything here is real MT5 data (spec section 4) — no secrets/credentials
 * are ever included, and every field is either a plain number/string or
 * null, so this object is safe to persist verbatim into ai_analysis_runs and
 * safe to serialize into the AI provider request.
 */
export async function buildMarketAnalysisPackage(symbol: string, assetClass: string, requestId?: string): Promise<MarketAnalysisPackage> {
  const [status, tick, symbolInfo, positions, pendingOrders, timeframes] = await Promise.all([
    getMt5Status(requestId),
    getMt5Tick(symbol, requestId).catch((): Record<string, unknown> => ({})),
    getMt5SymbolInfo(symbol, requestId).catch((): Record<string, unknown> => ({})),
    listMt5Positions(requestId).catch(() => []),
    listMt5PendingOrders(requestId).catch(() => []),
    Promise.all(TIMEFRAMES.map((timeframe) => buildTimeframeSnapshot(symbol, timeframe, requestId))),
  ]);

  const bid = Number(tick.bid);
  const ask = Number(tick.ask);
  const point = Number(symbolInfo.point);
  const digits = Number(symbolInfo.digits);
  const quoteTime = Number(tick.time);

  const existingPosition = positions.find((position) => String(position.symbol) === symbol) ?? null;
  const existingOrder = pendingOrders.find((order) => String(order.symbol) === symbol) ?? null;

  return {
    symbol,
    assetClass,
    generatedAt: new Date().toISOString(),
    quote: {
      bid: Number.isFinite(bid) ? bid : null,
      ask: Number.isFinite(ask) ? ask : null,
      spread: Number.isFinite(bid) && Number.isFinite(ask) ? Number((ask - bid).toFixed(8)) : null,
      digits: Number.isFinite(digits) ? digits : null,
      point: Number.isFinite(point) ? point : null,
      quoteAgeSeconds: Number.isFinite(quoteTime) ? Math.max(0, Math.round(Date.now() / 1000 - quoteTime)) : null,
    },
    market: {
      status: String(status.connected ? 'CONNECTED' : 'DISCONNECTED'),
      dataStatus: status.demo_verified ? 'LIVE' : 'UNVERIFIED',
      sessionOpen: null,
      sessionClose: null,
      nextOpen: null,
    },
    timeframes,
    account: {
      balance: numberOrNull(status.account?.balance),
      equity: numberOrNull(status.account?.equity),
      freeMargin: numberOrNull(status.account?.margin_free ?? status.account?.free_margin),
      currency: status.account?.currency ? String(status.account.currency) : null,
    },
    existingPosition: existingPosition
      ? { exists: true, side: existingPosition.type === 0 ? 'BUY' : 'SELL', volume: numberOrNull(existingPosition.volume), profit: numberOrNull(existingPosition.profit) }
      : { exists: false },
    existingPendingOrder: existingOrder
      ? { exists: true, type: existingOrder.type !== undefined ? String(existingOrder.type) : null, price: numberOrNull(existingOrder.price_open) }
      : { exists: false },
  };
}

function numberOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
