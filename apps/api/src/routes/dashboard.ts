import { Router, Request, Response } from 'express';
import Decimal from 'decimal.js';
import { requireAuth } from '../auth/middleware';
import { getPool } from '../db/client';
import { listRecentFills } from '../db/repositories/fills';
import { listOrders } from '../db/repositories/orders';
import { listRiskChecks } from '../db/repositories/risk-checks';
import { getSetting, getSettingValue } from '../db/repositories/system-settings';
import { expireOpenProposals, listProposals } from '../db/repositories/trade-proposals';
import {
  ensureDayStartSnapshot,
  getDayStartEquity,
  getLivePortfolioView,
  reconcileBracketOrders,
  reconcileIntradayTimeExits,
} from '../services/trade-execution-service';
import {
  getBrokerOpenOrders,
  getBrokerHealth,
  getPaperAccount,
  TradingEngineError,
} from '../services/trading-engine-client';

export const dashboardRouter = Router();

dashboardRouter.use(requireAuth);

type ExternalStatus = 'CONNECTED' | 'UNAVAILABLE' | 'RATE_LIMITED';
type ReconciliationStatus = 'MATCH' | 'MISMATCH' | 'UNKNOWN';

function requestId(req: Request): string | undefined {
  return req.headers['x-request-id'] as string | undefined;
}

function statusFromError(err: unknown): ExternalStatus {
  return err instanceof TradingEngineError && err.status === 429 ? 'RATE_LIMITED' : 'UNAVAILABLE';
}

function money(value: Decimal): string {
  return value.toDecimalPlaces(8).toFixed(8);
}

function decimal(value: string | null | undefined): Decimal {
  return new Decimal(value ?? '0');
}

function cashReconciliation(
  accountStatus: ExternalStatus,
  brokerCash: string | null | undefined,
  internalCash: string | null | undefined,
): { status: ReconciliationStatus; difference: string } {
  if (accountStatus !== 'CONNECTED' || brokerCash === undefined || brokerCash === null || !internalCash) {
    return { status: 'UNKNOWN', difference: '0.00000000' };
  }
  const difference = decimal(brokerCash).minus(decimal(internalCash));
  return {
    status: difference.isZero() ? 'MATCH' : 'MISMATCH',
    difference: money(difference),
  };
}

dashboardRouter.get('/paper', async (req: Request, res: Response) => {
  const pool = getPool();
  const requestIdentifier = requestId(req);
  await reconcileBracketOrders(pool, undefined, requestIdentifier);
  await reconcileIntradayTimeExits(pool, undefined, requestIdentifier);
  // Must run before listProposals below so a proposal whose expiresAt has
  // passed is flipped to EXPIRED here too — otherwise this endpoint's
  // "pending" count can disagree with GET /trade-proposals (which already
  // expires-on-read) purely based on which endpoint the client hit last.
  await expireOpenProposals(pool);

  const [
    view,
    pendingProposals,
    orders,
    fills,
    riskChecks,
    killSwitchSetting,
    initialCashSetting,
  ] = await Promise.all([
    getLivePortfolioView(pool, requestIdentifier),
    listProposals(pool, { status: 'PENDING_APPROVAL', limit: 20 }),
    listOrders(pool, { limit: 20 }),
    listRecentFills(pool, 20),
    listRiskChecks(pool, 20),
    getSetting(pool, 'trading_kill_switch_enabled'),
    getSettingValue(pool, 'initial_paper_cash_usd'),
  ]);

  const [brokerHealthResult, paperAccountResult, brokerOpenOrdersResult] = await Promise.allSettled([
    getBrokerHealth(requestIdentifier),
    getPaperAccount(requestIdentifier),
    getBrokerOpenOrders(requestIdentifier),
  ]);

  const brokerHealth = brokerHealthResult.status === 'fulfilled' ? brokerHealthResult.value : null;
  const paperAccount = paperAccountResult.status === 'fulfilled' ? paperAccountResult.value : null;
  const brokerOpenOrders = brokerOpenOrdersResult.status === 'fulfilled'
    ? brokerOpenOrdersResult.value
    : [];

  const brokerStatus: ExternalStatus = brokerHealthResult.status === 'fulfilled' && brokerHealth?.available
    ? 'CONNECTED'
    : statusFromError(brokerHealthResult.status === 'rejected' ? brokerHealthResult.reason : undefined);
  const accountStatus: ExternalStatus = paperAccountResult.status === 'fulfilled'
    ? 'CONNECTED'
    : statusFromError(paperAccountResult.reason);
  const marketDataStatus: ExternalStatus = view.marketFetchError
    ? statusFromError(view.marketFetchError)
    : 'CONNECTED';
  const staleCount = view.marketSnapshots.filter((snapshot) => snapshot.is_stale).length;
  await ensureDayStartSnapshot(pool, view);
  const dayStartEquity = await getDayStartEquity(
    pool,
    new Date(),
    String(initialCashSetting ?? '100000'),
  );
  const dailyPnl = new Decimal(view.portfolioEquity).minus(dayStartEquity).toDecimalPlaces(8).toFixed(8);
  const internalCash = view.cashBalance;
  const internalEquity = view.portfolioEquity;
  const brokerCash = paperAccount?.cash ?? null;
  const brokerBuyingPower = paperAccount?.buying_power ?? paperAccount?.cash ?? null;
  const reconciliation = cashReconciliation(accountStatus, brokerCash, internalCash);

  res.json({
    tradingMode: 'PAPER',
    paperTrading: true,
    broker: {
      source: 'ALPACA_PAPER_ACCOUNT',
      provider: brokerHealth?.provider ?? process.env.BROKER_PROVIDER ?? 'local_paper',
      tradingMode: brokerHealth?.trading_mode ?? 'PAPER',
      status: brokerStatus,
      accountStatus,
      cash: brokerCash ?? '0.00000000',
      buyingPower: brokerBuyingPower ?? '0.00000000',
      accountId: paperAccount?.account_id ?? null,
      currency: paperAccount?.currency ?? null,
      alpacaStatus: paperAccount?.status ?? null,
    },
    portfolio: {
      source: 'INTERNAL_LEDGER',
      cashBalance: internalCash,
      portfolioEquity: internalEquity,
      realizedPnl: view.realizedPnl,
      unrealizedPnl: view.unrealizedPnl,
      dailyPnl,
      lastUpdatedAt: view.asOf,
    },
    marketData: {
      status: marketDataStatus,
      freshness: staleCount > 0 ? 'STALE' : 'FRESH',
      staleCount,
      // Stream connection state (Python trading-engine <-> Alpaca WebSocket).
      // Distinct from `status` above, which is Node <-> trading-engine reachability.
      streamMode: view.marketDataStatus.mode,
      streamConnected: view.marketDataStatus.connected,
      streamLastMessageAt: view.marketDataStatus.last_message_at,
      snapshots: view.marketSnapshots.map((snapshot) => ({
        symbol: snapshot.symbol,
        price: snapshot.price,
        bid: snapshot.bid,
        ask: snapshot.ask,
        volume: snapshot.volume,
        timestamp: snapshot.timestamp,
        isStale: snapshot.is_stale,
      })),
    },
    reconciliation: {
      status: reconciliation.status,
      checkedAt: view.asOf,
      brokerCash: brokerCash ?? null,
      brokerBuyingPower: brokerBuyingPower ?? null,
      internalCash,
      internalEquity,
      cashDifference: reconciliation.difference,
      sourceOfTruth: 'INTERNAL_LEDGER',
      comparedSource: 'ALPACA_PAPER_ACCOUNT',
      openPositionCount: view.positions.length,
      pendingOrderCount: brokerOpenOrders.length,
    },
    killSwitch: {
      enabled: killSwitchSetting?.value !== false,
    },
    pendingProposals,
    riskResults: riskChecks,
    orders,
    brokerOpenOrders,
    fills,
    positions: view.positions,
  });
});
