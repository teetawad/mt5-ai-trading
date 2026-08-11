/**
 * HTTP client for the internal trading-engine service.
 *
 * All requests include X-Internal-Token for service-to-service auth.
 * If TRADING_ENGINE_URL is not set, every call throws a configuration error.
 */

import { Pool, PoolClient } from 'pg';
import { createRiskCheck } from '../db/repositories/risk-checks';
import { RiskCheck } from '../db/types';

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

export interface MarketBarDTO {
  symbol: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: number;
  timestamp: string;
  trade_count?: number | null;
  vwap?: string | null;
}

export interface MarketQuoteDTO {
  symbol: string;
  bid: string;
  ask: string;
  bid_size: number;
  ask_size: number;
  timestamp: string;
  is_stale: boolean;
}

export interface MarketTradeDTO {
  symbol: string;
  price: string;
  size: number;
  timestamp: string;
  exchange?: string | null;
  trade_id?: number | string | null;
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

async function engineFetch(
  path: string,
  requestId?: string,
  options: Omit<RequestInit, 'headers' | 'signal'> = {},
): Promise<Response> {
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
    return await fetch(url, { ...options, headers, signal: controller.signal });
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

export async function getHistoricalBars(
  symbol: string,
  params: {
    timeframe: string;
    start: string;
    end?: string;
    limit?: number;
  },
  requestId?: string,
): Promise<MarketBarDTO[]> {
  const query = new URLSearchParams({
    timeframe: params.timeframe,
    start: params.start,
    limit: String(params.limit ?? 100),
  });
  if (params.end) query.set('end', params.end);
  const res = await engineFetch(
    `/market-data/bars/${encodeURIComponent(symbol)}?${query.toString()}`,
    requestId,
  );
  if (!res.ok) {
    throw new TradingEngineError(`Trading engine error: ${res.status}`, res.status);
  }
  return res.json() as Promise<MarketBarDTO[]>;
}

export async function getLatestQuote(
  symbol: string,
  requestId?: string,
): Promise<MarketQuoteDTO | null> {
  const res = await engineFetch(`/market-data/quote/${encodeURIComponent(symbol)}`, requestId);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new TradingEngineError(`Trading engine error: ${res.status}`, res.status);
  }
  return res.json() as Promise<MarketQuoteDTO>;
}

export async function getLatestTrade(
  symbol: string,
  requestId?: string,
): Promise<MarketTradeDTO | null> {
  const res = await engineFetch(`/market-data/trade/${encodeURIComponent(symbol)}`, requestId);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new TradingEngineError(`Trading engine error: ${res.status}`, res.status);
  }
  return res.json() as Promise<MarketTradeDTO>;
}

// ── Broker ────────────────────────────────────────────────────────────────────

export type OrderSide = 'BUY' | 'SELL';
export type OrderType = 'MARKET' | 'LIMIT';
export type OrderStatus =
  | 'PENDING'
  | 'SUBMITTED'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'CANCELLED'
  | 'REJECTED'
  | 'ERROR';

export interface OrderRequestDTO {
  idempotency_key: string;
  symbol: string;
  side: OrderSide;
  quantity: string;
  order_type: OrderType;
  limit_price?: string;
}

export interface FillEventDTO {
  order_id: string;
  fill_id: string;
  quantity: string;
  price: string;
  fee: string;
  is_partial: boolean;
  filled_at: string;
}

export interface OrderResultDTO {
  broker_order_id: string;
  status: OrderStatus;
  fills: FillEventDTO[];
  rejected_reason?: string;
  error_message?: string;
}

export interface PaperPortfolioDTO {
  cash: string;
  positions: Record<string, string>;
}

export async function submitOrder(
  request: OrderRequestDTO,
  requestId?: string,
): Promise<OrderResultDTO> {
  const res = await engineFetch('/broker/orders', requestId, {
    method: 'POST',
    body: JSON.stringify(request),
  });
  if (!res.ok) {
    throw new TradingEngineError(`Trading engine error: ${res.status}`, res.status);
  }
  return res.json() as Promise<OrderResultDTO>;
}

export async function getOrder(
  brokerOrderId: string,
  requestId?: string,
): Promise<OrderResultDTO | null> {
  const res = await engineFetch(
    `/broker/orders/${encodeURIComponent(brokerOrderId)}`,
    requestId,
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new TradingEngineError(`Trading engine error: ${res.status}`, res.status);
  }
  return res.json() as Promise<OrderResultDTO>;
}

export async function getBrokerOpenOrders(requestId?: string): Promise<OrderResultDTO[]> {
  const res = await engineFetch('/broker/open-orders', requestId);
  if (!res.ok) {
    throw new TradingEngineError(`Trading engine error: ${res.status}`, res.status);
  }
  return res.json() as Promise<OrderResultDTO[]>;
}

export async function cancelOrder(
  brokerOrderId: string,
  requestId?: string,
): Promise<OrderResultDTO | null> {
  const res = await engineFetch(
    `/broker/orders/${encodeURIComponent(brokerOrderId)}/cancel`,
    requestId,
    { method: 'POST' },
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new TradingEngineError(`Trading engine error: ${res.status}`, res.status);
  }
  return res.json() as Promise<OrderResultDTO>;
}

export async function getBrokerHealth(
  requestId?: string,
): Promise<{ available: boolean; provider?: string; trading_mode?: string }> {
  const res = await engineFetch('/broker/health', requestId);
  if (!res.ok) {
    throw new TradingEngineError(`Trading engine error: ${res.status}`, res.status);
  }
  return res.json() as Promise<{ available: boolean; provider?: string; trading_mode?: string }>;
}

export async function getPaperPortfolio(requestId?: string): Promise<PaperPortfolioDTO> {
  const res = await engineFetch('/broker/paper-portfolio', requestId);
  if (!res.ok) {
    throw new TradingEngineError(`Trading engine error: ${res.status}`, res.status);
  }
  return res.json() as Promise<PaperPortfolioDTO>;
}

export interface PaperAccountDTO {
  cash: string;
  buying_power: string;
  account_id?: string | null;
  currency?: string | null;
  status?: string | null;
}

export async function getPaperAccount(requestId?: string): Promise<PaperAccountDTO> {
  const res = await engineFetch('/broker/paper-account', requestId);
  if (!res.ok) {
    throw new TradingEngineError(`Trading engine error: ${res.status}`, res.status);
  }
  return res.json() as Promise<PaperAccountDTO>;
}

// ── Signals ───────────────────────────────────────────────────────────────────

export type SignalSide = 'BUY' | 'SELL';
export type SignalType = 'MARKET' | 'LIMIT';

export interface SignalDTO {
  signal_id: string;
  strategy_name: string;
  symbol: string;
  side: SignalSide;
  quantity: string;
  signal_type: SignalType;
  limit_price?: string;
  reference_price: string;
  confidence: number;
  generated_at: string;
  metadata: Record<string, string>;
}

export async function generateSignals(
  strategyName?: string,
  requestId?: string,
): Promise<SignalDTO[]> {
  const res = await engineFetch('/signals/generate', requestId, {
    method: 'POST',
    body: JSON.stringify({ strategy_name: strategyName ?? null }),
  });
  if (!res.ok) {
    throw new TradingEngineError(`Trading engine error: ${res.status}`, res.status);
  }
  return res.json() as Promise<SignalDTO[]>;
}

export async function listStrategies(requestId?: string): Promise<string[]> {
  const res = await engineFetch('/signals/strategies', requestId);
  if (!res.ok) {
    throw new TradingEngineError(`Trading engine error: ${res.status}`, res.status);
  }
  return res.json() as Promise<string[]>;
}

// ── Risk Engine ───────────────────────────────────────────────────────────────

export type EvaluationStage = 'PRE_PROPOSAL' | 'PRE_EXECUTION';
export type RuleOutcome = 'PASS' | 'REJECT';
export type TradeSideRisk = 'BUY' | 'SELL';

export interface ProposalInputDTO {
  symbol: string;
  side: TradeSideRisk;
  quantity: string;
  reference_price: string;
  expires_at?: string;
}

export interface MarketInputDTO {
  symbol: string;
  price: string;
  is_stale: boolean;
  timestamp: string;
}

export interface PortfolioInputDTO {
  cash: string;
  positions: Record<string, string>;
  equity: string;
  daily_pnl: string;
}

export interface PendingProposalInputDTO {
  symbol: string;
  side: TradeSideRisk;
}

export interface RiskConfigDTO {
  kill_switch_enabled?: boolean;
  trading_mode?: string;
  market_data_staleness_seconds?: number;
  price_drift_threshold_pct?: string;
  max_order_notional_usd?: string;
  max_position_size_usd?: string;
  max_portfolio_concentration_pct?: string;
  max_open_positions?: number;
  max_daily_loss_usd?: string;
  proposal_ttl_seconds?: number;
  trading_session_start?: string;
  trading_session_end?: string;
  cooldown_between_trades_seconds?: number;
}

export interface RiskEvaluationRequestDTO {
  stage: EvaluationStage;
  proposal: ProposalInputDTO;
  market: MarketInputDTO;
  portfolio: PortfolioInputDTO;
  config?: RiskConfigDTO;
  pending_proposals?: PendingProposalInputDTO[];
  last_fill_times?: Record<string, string>;
}

export interface RiskResultDTO {
  result: RuleOutcome;
  stage: EvaluationStage;
  rules_checked: string[];
  failed_rules: string[];
  reason: string | null;
  market_snapshot: MarketInputDTO;
  portfolio_snapshot: PortfolioInputDTO;
  evaluated_at: string;
}

export async function evaluateRisk(
  request: RiskEvaluationRequestDTO,
  requestId?: string,
): Promise<RiskResultDTO> {
  const res = await engineFetch('/risk/evaluate', requestId, {
    method: 'POST',
    body: JSON.stringify(request),
  });
  if (!res.ok) {
    throw new TradingEngineError(`Trading engine error: ${res.status}`, res.status);
  }
  return res.json() as Promise<RiskResultDTO>;
}

export async function evaluateAndPersistRisk(
  db: Pool | PoolClient,
  request: RiskEvaluationRequestDTO,
  ids: { signalId?: string | null; proposalId?: string | null } = {},
  requestId?: string,
): Promise<RiskCheck> {
  const result = await evaluateRisk(request, requestId);
  return createRiskCheck(db, {
    signalId: ids.signalId ?? null,
    proposalId: ids.proposalId ?? null,
    stage: result.stage,
    result: result.result,
    rulesChecked: result.rules_checked,
    failedRules: result.failed_rules,
    reason: result.reason,
    marketSnapshot: { ...result.market_snapshot },
    portfolioSnapshot: { ...result.portfolio_snapshot },
  });
}
