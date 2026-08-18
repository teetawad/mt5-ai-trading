// Pure, dependency-free technical indicator math over MT5 OHLCV bars.
// Every function is a plain array-in/array-or-number-out transform so it can
// be unit tested without any MT5/HTTP dependency.

export interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  tick_volume?: number;
}

export function sma(values: number[], period: number): (number | null)[] {
  return values.map((_, i) => {
    if (i + 1 < period) return null;
    const window = values.slice(i + 1 - period, i + 1);
    return window.reduce((sum, v) => sum + v, 0) / period;
  });
}

export function ema(values: number[], period: number): (number | null)[] {
  const k = 2 / (period + 1);
  const out: (number | null)[] = [];
  let prev: number | null = null;
  values.forEach((value, i) => {
    if (i + 1 < period) {
      out.push(null);
      return;
    }
    if (prev === null) {
      const seed = values.slice(i + 1 - period, i + 1).reduce((sum, v) => sum + v, 0) / period;
      prev = seed;
      out.push(seed);
      return;
    }
    prev = value * k + prev * (1 - k);
    out.push(prev);
  });
  return out;
}

export function lastFinite(values: (number | null)[]): number | null {
  for (let i = values.length - 1; i >= 0; i -= 1) {
    if (values[i] !== null && Number.isFinite(values[i])) return values[i];
  }
  return null;
}

export function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i += 1) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function atr(bars: Bar[], period = 14): number | null {
  if (bars.length < period + 1) return null;
  const trueRanges: number[] = [];
  for (let i = 1; i < bars.length; i += 1) {
    const high = bars[i].high;
    const low = bars[i].low;
    const prevClose = bars[i - 1].close;
    trueRanges.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  const window = trueRanges.slice(-period);
  return window.reduce((sum, v) => sum + v, 0) / period;
}

export interface MacdResult {
  macd: number | null;
  signal: number | null;
  histogram: number | null;
}

export function macd(closes: number[], fast = 12, slow = 26, signalPeriod = 9): MacdResult {
  if (closes.length < slow + signalPeriod) return { macd: null, signal: null, histogram: null };
  const fastEma = ema(closes, fast);
  const slowEma = ema(closes, slow);
  const macdLine: number[] = [];
  for (let i = 0; i < closes.length; i += 1) {
    const f = fastEma[i];
    const s = slowEma[i];
    if (f !== null && s !== null) macdLine.push(f - s);
  }
  if (macdLine.length < signalPeriod) return { macd: lastFinite(macdLine), signal: null, histogram: null };
  const signalLine = ema(macdLine, signalPeriod);
  const macdValue = macdLine.at(-1) ?? null;
  const signalValue = lastFinite(signalLine);
  return {
    macd: macdValue,
    signal: signalValue,
    histogram: macdValue !== null && signalValue !== null ? macdValue - signalValue : null,
  };
}

export function recentHighLow(bars: Bar[], lookback = 40): { high: number | null; low: number | null } {
  const window = bars.slice(-lookback);
  if (!window.length) return { high: null, low: null };
  return {
    high: Math.max(...window.map((bar) => bar.high)),
    low: Math.min(...window.map((bar) => bar.low)),
  };
}

/**
 * Simple fractal-style pivot detection: a bar is a pivot high/low when it is
 * the max/min of a symmetric window around it. Deliberately conservative
 * (wing=3) so the candidate list stays short and readable rather than
 * flagging every minor wiggle as support/resistance.
 */
export function supportResistanceCandidates(bars: Bar[], wing = 3, maxLevels = 4): number[] {
  const pivots: number[] = [];
  for (let i = wing; i < bars.length - wing; i += 1) {
    const windowHighs = bars.slice(i - wing, i + wing + 1).map((bar) => bar.high);
    const windowLows = bars.slice(i - wing, i + wing + 1).map((bar) => bar.low);
    if (bars[i].high === Math.max(...windowHighs)) pivots.push(bars[i].high);
    if (bars[i].low === Math.min(...windowLows)) pivots.push(bars[i].low);
  }
  // De-duplicate near-identical levels and keep the ones closest to the most
  // recent price action (end of the array), which matters most to a trader.
  const unique: number[] = [];
  for (const level of pivots.slice().reverse()) {
    if (!unique.some((existing) => Math.abs(existing - level) / level < 0.0015)) unique.push(level);
    if (unique.length >= maxLevels) break;
  }
  return unique.sort((a, b) => a - b);
}

export function trendFromMovingAverages(fastMa: number | null, slowMa: number | null, price: number | null): 'BULLISH' | 'BEARISH' | 'RANGE' | 'UNCLEAR' {
  if (fastMa === null || slowMa === null || price === null) return 'UNCLEAR';
  const spread = Math.abs(fastMa - slowMa) / slowMa;
  if (spread < 0.0005) return 'RANGE';
  if (fastMa > slowMa && price >= fastMa * 0.999) return 'BULLISH';
  if (fastMa < slowMa && price <= fastMa * 1.001) return 'BEARISH';
  return 'RANGE';
}
