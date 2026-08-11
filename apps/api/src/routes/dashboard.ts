import { Router, Request, Response } from 'express';
import { requireAuth } from '../auth/middleware';
import { getPool } from '../db/client';
import { listRecentFills } from '../db/repositories/fills';
import { listOrders } from '../db/repositories/orders';
import { findLatestSnapshot } from '../db/repositories/portfolio-snapshots';
import { findOpenPositions } from '../db/repositories/positions';
import { listRiskChecks } from '../db/repositories/risk-checks';
import { getSetting } from '../db/repositories/system-settings';
import { listProposals } from '../db/repositories/trade-proposals';
import {
  getAllMarketSnapshots,
  getBrokerOpenOrders,
  getBrokerHealth,
  getPaperAccount,
  TradingEngineError,
} from '../services/trading-engine-client';

export const dashboardRouter = Router();

dashboardRouter.use(requireAuth);

type ExternalStatus = 'CONNECTED' | 'UNAVAILABLE' | 'RATE_LIMITED';

function requestId(req: Request): string | undefined {
  return req.headers['x-request-id'] as string | undefined;
}

function statusFromError(err: unknown): ExternalStatus {
  return err instanceof TradingEngineError && err.status === 429 ? 'RATE_LIMITED' : 'UNAVAILABLE';
}

dashboardRouter.get('/paper', async (req: Request, res: Response) => {
  const pool = getPool();
  const [
    latestPortfolio,
    positions,
    pendingProposals,
    orders,
    fills,
    riskChecks,
    killSwitchSetting,
  ] = await Promise.all([
    findLatestSnapshot(pool),
    findOpenPositions(pool),
    listProposals(pool, { status: 'PENDING_APPROVAL', limit: 20 }),
    listOrders(pool, { limit: 20 }),
    listRecentFills(pool, 20),
    listRiskChecks(pool, 20),
    getSetting(pool, 'trading_kill_switch_enabled'),
  ]);

  const requestIdentifier = requestId(req);
  const [
    brokerHealthResult,
    paperAccountResult,
    marketSnapshotsResult,
    brokerOpenOrdersResult,
  ] = await Promise.allSettled([
    getBrokerHealth(requestIdentifier),
    getPaperAccount(requestIdentifier),
    getAllMarketSnapshots(requestIdentifier),
    getBrokerOpenOrders(requestIdentifier),
  ]);

  const brokerHealth = brokerHealthResult.status === 'fulfilled' ? brokerHealthResult.value : null;
  const paperAccount = paperAccountResult.status === 'fulfilled' ? paperAccountResult.value : null;
  const marketSnapshots = marketSnapshotsResult.status === 'fulfilled' ? marketSnapshotsResult.value : [];
  const brokerOpenOrders = brokerOpenOrdersResult.status === 'fulfilled'
    ? brokerOpenOrdersResult.value
    : [];

  const brokerStatus: ExternalStatus = brokerHealthResult.status === 'fulfilled' && brokerHealth?.available
    ? 'CONNECTED'
    : statusFromError(brokerHealthResult.status === 'rejected' ? brokerHealthResult.reason : undefined);
  const accountStatus: ExternalStatus = paperAccountResult.status === 'fulfilled'
    ? 'CONNECTED'
    : statusFromError(paperAccountResult.reason);
  const marketDataStatus: ExternalStatus = marketSnapshotsResult.status === 'fulfilled'
    ? 'CONNECTED'
    : statusFromError(marketSnapshotsResult.reason);
  const staleCount = marketSnapshots.filter((snapshot) => snapshot.is_stale).length;

  res.json({
    tradingMode: 'PAPER',
    paperTrading: true,
    broker: {
      provider: brokerHealth?.provider ?? process.env.BROKER_PROVIDER ?? 'local_paper',
      tradingMode: brokerHealth?.trading_mode ?? 'PAPER',
      status: brokerStatus,
      accountStatus,
      cash: paperAccount?.cash ?? latestPortfolio?.cashBalance ?? '0.00000000',
      buyingPower: paperAccount?.buying_power ?? paperAccount?.cash ?? latestPortfolio?.cashBalance ?? '0.00000000',
      accountId: paperAccount?.account_id ?? null,
      currency: paperAccount?.currency ?? null,
      alpacaStatus: paperAccount?.status ?? null,
    },
    portfolio: {
      cashBalance: latestPortfolio?.cashBalance ?? '0.00000000',
      portfolioEquity: latestPortfolio?.portfolioEquity ?? '0.00000000',
      realizedPnl: latestPortfolio?.realizedPnl ?? '0.00000000',
      unrealizedPnl: latestPortfolio?.unrealizedPnl ?? '0.00000000',
      dailyPnl: latestPortfolio?.dailyPnl ?? '0.00000000',
      lastUpdatedAt: latestPortfolio?.createdAt?.toISOString() ?? null,
    },
    marketData: {
      status: marketDataStatus,
      freshness: staleCount > 0 ? 'STALE' : 'FRESH',
      staleCount,
      snapshots: marketSnapshots.map((snapshot) => ({
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
      status: brokerStatus === 'CONNECTED' && accountStatus === 'CONNECTED' ? 'CONNECTED' : 'NEEDS_ATTENTION',
      checkedAt: new Date().toISOString(),
      openPositionCount: positions.length,
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
    positions,
  });
});
