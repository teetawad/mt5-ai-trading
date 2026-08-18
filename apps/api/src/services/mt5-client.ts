import { TradingEngineError } from './trading-engine-client';

// FastAPI's default error shape is {"detail": ...}; the Python MT5 router
// sends {"detail": {"error": "PENDING_ORDER_NOT_CONFIRMED", "message": "..."}}
// for differentiated errors (spec: never collapse everything into one
// generic message/code). Falls back to the raw body for any older/
// plain-string detail shape so nothing is ever silently swallowed. `code` is
// what callers should branch on; `message` is always safe to show/log.
function parseEngineErrorDetail(rawBody: string): { code: string | null; message: string; diagnostics: Record<string, unknown> | null } {
  try {
    const parsed = JSON.parse(rawBody) as { detail?: unknown };
    const detail = parsed?.detail;
    if (detail && typeof detail === 'object' && 'message' in detail) {
      const detailObj = detail as Record<string, unknown>;
      const code = 'error' in detail ? String(detailObj.error) : null;
      const message = String(detailObj.message);
      const diagnostics = detailObj.diagnostics && typeof detailObj.diagnostics === 'object' ? (detailObj.diagnostics as Record<string, unknown>) : null;
      return { code, message: code ? `${code}: ${message}` : message, diagnostics };
    }
    if (typeof detail === 'string') return { code: null, message: detail, diagnostics: null };
  } catch {
    // not JSON — fall through to the raw body below.
  }
  return { code: null, message: rawBody, diagnostics: null };
}

function getBaseUrl(): string {
  const url = process.env.TRADING_ENGINE_URL;
  if (!url) throw new TradingEngineError('TRADING_ENGINE_URL is not configured');
  return url.replace(/\/$/, '');
}

function getToken(): string {
  return process.env.INTERNAL_SERVICE_TOKEN ?? '';
}

// Pending-order confirmation can involve up to ~1.75s of deliberate bounded
// polling inside the trading engine (order==0 recovery — see
// mt5/adapter.py's _reconcile_pending_order) on top of the actual MT5 round
// trips, so the transport timeout needs real headroom above that.
const ENGINE_FETCH_TIMEOUT_MS = 15_000;

async function engineFetch(path: string, requestId?: string, init: Omit<RequestInit, 'headers' | 'signal'> = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ENGINE_FETCH_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = getToken();
    if (token) headers['X-Internal-Token'] = token;
    if (requestId) headers['X-Request-ID'] = requestId;
    const res = await fetch(`${getBaseUrl()}${path}`, { ...init, headers, signal: controller.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const { code, message, diagnostics } = parseEngineErrorDetail(body);
      throw new TradingEngineError(`Trading engine MT5 error: ${res.status} ${message}`, res.status, code ?? undefined, diagnostics);
    }
    return res.json() as Promise<unknown>;
  } catch (err) {
    // AbortError and any other transport-level failure (unreachable,
    // connection reset) deliberately carry NO status/code — callers must
    // treat that as genuinely ambiguous (we don't know what MT5 did), never
    // as a definite rejection.
    if ((err as Error).name === 'AbortError') throw new TradingEngineError('Trading engine MT5 request timed out');
    if (err instanceof TradingEngineError) throw err;
    throw new TradingEngineError(`Trading engine MT5 unreachable: ${(err as Error).message}`);
  } finally {
    clearTimeout(timeout);
  }
}

export interface Mt5StatusDTO {
  connected: boolean;
  demo_verified: boolean;
  blocked_reason?: string | null;
  account?: Record<string, unknown> | null;
  terminal?: Record<string, unknown> | null;
}

export interface Mt5SymbolDTO {
  name: string;
  description?: string;
  path?: string;
  currency_base?: string;
  currency_profit?: string;
  point?: number;
  trade_tick_size?: number;
  trade_tick_value?: number;
  volume_min?: number;
  volume_max?: number;
  volume_step?: number;
  trade_stops_level?: number;
  visible?: boolean;
}

export interface Mt5DecisionDTO {
  symbol: string;
  bid?: string | null;
  ask?: string | null;
  spread?: string | null;
  quote_timestamp?: string | null;
  market_state?: 'LIVE' | 'MARKET_CLOSED';
  market_status?: 'OPEN' | 'CLOSED' | 'QUOTE_ONLY' | 'TRADE_DISABLED' | 'UNKNOWN';
  data_status?: 'LIVE' | 'STALE' | 'DISCONNECTED';
  session_open?: string | null;
  session_close?: string | null;
  next_session_open?: string | null;
  server_time?: string | null;
  local_time?: string | null;
  quote_age_seconds?: number | null;
  source?: string | null;
  market?: Record<string, unknown>;
  decision: 'BUY' | 'SELL' | 'HOLD' | 'NO_TRADE';
  confidence: number;
  opportunity_score: number;
  reasons: string[];
  reference_entry: string;
  current_price?: string | null;
  entry_strategy: 'MARKET_NOW' | 'PULLBACK' | 'BREAKOUT' | 'NO_ENTRY';
  entry_zone_low?: string | null;
  entry_zone_high?: string | null;
  trigger_price?: string | null;
  entry_reason?: string | null;
  valid_until?: string | null;
  current_entry_status?: 'WAITING' | 'READY' | 'TRIGGERED' | 'EXPIRED' | 'CANCELLED' | 'BLOCKED' | 'EXECUTED';
  stop_loss: string | null;
  take_profit: string | null;
  risk_reward: string | null;
  expected_holding_hours: number;
  signal_candle_timestamp: string;
  model_version: string;
  features: Record<string, unknown>;
}

export interface Mt5OrderRequestDTO {
  idempotency_key: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  volume: number;
  stop_loss: number;
  take_profit: number;
  deviation: number;
  comment?: string;
}

export async function getMt5Status(requestId?: string): Promise<Mt5StatusDTO> {
  return engineFetch('/mt5/status', requestId) as Promise<Mt5StatusDTO>;
}

export async function listMt5Symbols(requestId?: string): Promise<Mt5SymbolDTO[]> {
  return engineFetch('/mt5/symbols', requestId) as Promise<Mt5SymbolDTO[]>;
}

export async function analyzeMt5Symbol(symbol: string, requestId?: string): Promise<Mt5DecisionDTO> {
  return engineFetch(`/mt5/analyze/${encodeURIComponent(symbol)}`, requestId, { method: 'POST' }) as Promise<Mt5DecisionDTO>;
}

export async function getMt5MarketStatus(symbol: string, requestId?: string): Promise<Record<string, unknown>> {
  return engineFetch(`/mt5/market-status/${encodeURIComponent(symbol)}`, requestId) as Promise<Record<string, unknown>>;
}

export async function getMt5Tick(symbol: string, requestId?: string): Promise<Record<string, unknown>> {
  return engineFetch(`/mt5/tick/${encodeURIComponent(symbol)}`, requestId) as Promise<Record<string, unknown>>;
}

export async function listMt5Positions(requestId?: string): Promise<Record<string, unknown>[]> {
  return engineFetch('/mt5/positions', requestId) as Promise<Record<string, unknown>[]>;
}

export async function listMt5PendingOrders(requestId?: string): Promise<Record<string, unknown>[]> {
  return engineFetch('/mt5/orders', requestId) as Promise<Record<string, unknown>[]>;
}

export async function getMt5SymbolInfo(symbol: string, requestId?: string): Promise<Record<string, unknown>> {
  return engineFetch(`/mt5/symbol-info/${encodeURIComponent(symbol)}`, requestId) as Promise<Record<string, unknown>>;
}

export async function getMt5HistoryDeals(symbol: string, hours: number, requestId?: string): Promise<Record<string, unknown>[]> {
  return engineFetch(`/mt5/history-deals?symbol=${encodeURIComponent(symbol)}&hours=${encodeURIComponent(String(hours))}`, requestId) as Promise<Record<string, unknown>[]>;
}

export async function getMt5HistoryOrders(symbol: string, hours: number, requestId?: string): Promise<Record<string, unknown>[]> {
  return engineFetch(`/mt5/history-orders?symbol=${encodeURIComponent(symbol)}&hours=${encodeURIComponent(String(hours))}`, requestId) as Promise<Record<string, unknown>[]>;
}

export async function checkMt5Order(request: Mt5OrderRequestDTO, requestId?: string): Promise<Record<string, unknown>> {
  return engineFetch('/mt5/order-check', requestId, { method: 'POST', body: JSON.stringify(request) }) as Promise<Record<string, unknown>>;
}

export async function sendMt5Order(request: Mt5OrderRequestDTO, requestId?: string): Promise<Record<string, unknown>> {
  return engineFetch('/mt5/orders', requestId, { method: 'POST', body: JSON.stringify(request) }) as Promise<Record<string, unknown>>;
}

export async function getMt5Bars(symbol: string, timeframe: string, count: number, requestId?: string): Promise<Record<string, unknown>[]> {
  return engineFetch(`/mt5/bars/${encodeURIComponent(symbol)}?timeframe=${encodeURIComponent(timeframe)}&count=${count}`, requestId) as Promise<Record<string, unknown>[]>;
}

export interface Mt5ChartDTO {
  symbol: string;
  timeframe: string;
  bar_count: number;
  media_type: string;
  image_base64: string;
}

export async function getMt5Chart(symbol: string, timeframe: string, count: number, requestId?: string): Promise<Mt5ChartDTO> {
  return engineFetch(`/mt5/chart/${encodeURIComponent(symbol)}?timeframe=${encodeURIComponent(timeframe)}&count=${count}`, requestId) as Promise<Mt5ChartDTO>;
}

export interface Mt5PendingOrderRequestDTO {
  idempotency_key: string;
  symbol: string;
  order_type: 'BUY_LIMIT' | 'SELL_LIMIT' | 'BUY_STOP' | 'SELL_STOP';
  price: number;
  volume: number;
  stop_loss: number;
  take_profit: number;
  expiration?: string | null;
  comment?: string;
}

export async function checkMt5PendingOrder(request: Mt5PendingOrderRequestDTO, requestId?: string): Promise<Record<string, unknown>> {
  return engineFetch('/mt5/pending-order-check', requestId, { method: 'POST', body: JSON.stringify(request) }) as Promise<Record<string, unknown>>;
}

export async function sendMt5PendingOrder(request: Mt5PendingOrderRequestDTO, requestId?: string): Promise<Record<string, unknown>> {
  return engineFetch('/mt5/pending-orders', requestId, { method: 'POST', body: JSON.stringify(request) }) as Promise<Record<string, unknown>>;
}

export async function cancelMt5PendingOrder(ticket: string, requestId?: string): Promise<Record<string, unknown>> {
  return engineFetch(`/mt5/pending-orders/${encodeURIComponent(ticket)}`, requestId, { method: 'DELETE' }) as Promise<Record<string, unknown>>;
}
