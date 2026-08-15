import { TradingEngineError } from './trading-engine-client';

function getBaseUrl(): string {
  const url = process.env.TRADING_ENGINE_URL;
  if (!url) throw new TradingEngineError('TRADING_ENGINE_URL is not configured');
  return url.replace(/\/$/, '');
}

function getToken(): string {
  return process.env.INTERNAL_SERVICE_TOKEN ?? '';
}

async function engineFetch(path: string, requestId?: string, init: Omit<RequestInit, 'headers' | 'signal'> = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = getToken();
    if (token) headers['X-Internal-Token'] = token;
    if (requestId) headers['X-Request-ID'] = requestId;
    const res = await fetch(`${getBaseUrl()}${path}`, { ...init, headers, signal: controller.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new TradingEngineError(`Trading engine MT5 error: ${res.status} ${body}`, res.status);
    }
    return res.json() as Promise<unknown>;
  } catch (err) {
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
  decision: 'BUY' | 'SELL' | 'HOLD' | 'NO_TRADE';
  confidence: number;
  opportunity_score: number;
  reasons: string[];
  reference_entry: string;
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

export async function listMt5Positions(requestId?: string): Promise<Record<string, unknown>[]> {
  return engineFetch('/mt5/positions', requestId) as Promise<Record<string, unknown>[]>;
}

export async function checkMt5Order(request: Mt5OrderRequestDTO, requestId?: string): Promise<Record<string, unknown>> {
  return engineFetch('/mt5/order-check', requestId, { method: 'POST', body: JSON.stringify(request) }) as Promise<Record<string, unknown>>;
}

export async function sendMt5Order(request: Mt5OrderRequestDTO, requestId?: string): Promise<Record<string, unknown>> {
  return engineFetch('/mt5/orders', requestId, { method: 'POST', body: JSON.stringify(request) }) as Promise<Record<string, unknown>>;
}
