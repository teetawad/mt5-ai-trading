/**
 * HTTP client for the internal trading-engine service.
 *
 * All requests include X-Internal-Token for service-to-service auth.
 * If TRADING_ENGINE_URL is not set, every call throws a configuration error.
 */

export class TradingEngineError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'TradingEngineError';
  }
}

export interface MarketSnapshotDTO {
  symbol: string;
  price: string;
  bid: string;
  ask: string;
  volume: number;
  timestamp: string;
  is_stale: boolean;
}

function getBaseUrl(): string {
  const url = process.env.TRADING_ENGINE_URL;
  if (!url) throw new TradingEngineError('TRADING_ENGINE_URL is not configured');
  return url.replace(/\/$/, '');
}

function getToken(): string {
  return process.env.INTERNAL_SERVICE_TOKEN ?? '';
}

async function engineFetch(path: string, requestId?: string): Promise<Response> {
  const url = `${getBaseUrl()}${path}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const token = getToken();
  if (token) headers['X-Internal-Token'] = token;
  if (requestId) headers['X-Request-ID'] = requestId;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    return await fetch(url, { headers, signal: controller.signal });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new TradingEngineError('Trading engine request timed out');
    }
    throw new TradingEngineError(`Trading engine unreachable: ${(err as Error).message}`);
  } finally {
    clearTimeout(timeout);
  }
}

export async function getMarketSnapshot(
  symbol: string,
  requestId?: string,
): Promise<MarketSnapshotDTO | null> {
  const res = await engineFetch(`/market-data/snapshot/${encodeURIComponent(symbol)}`, requestId);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new TradingEngineError(`Trading engine error: ${res.status}`, res.status);
  }
  return res.json() as Promise<MarketSnapshotDTO>;
}

export async function getAllMarketSnapshots(
  requestId?: string,
): Promise<MarketSnapshotDTO[]> {
  const res = await engineFetch('/market-data/snapshots', requestId);
  if (!res.ok) {
    throw new TradingEngineError(`Trading engine error: ${res.status}`, res.status);
  }
  return res.json() as Promise<MarketSnapshotDTO[]>;
}

export async function getTrackedSymbols(requestId?: string): Promise<string[]> {
  const res = await engineFetch('/market-data/symbols', requestId);
  if (!res.ok) {
    throw new TradingEngineError(`Trading engine error: ${res.status}`, res.status);
  }
  return res.json() as Promise<string[]>;
}
