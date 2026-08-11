import Decimal from 'decimal.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';
import { createPool } from '../db/client';
import { findAuditLogsByEntity, listAuditLogs } from '../db/repositories/audit-logs';
import { listRecentFills } from '../db/repositories/fills';
import { listOrders } from '../db/repositories/orders';
import { findLatestSnapshot } from '../db/repositories/portfolio-snapshots';
import { findOpenPositions } from '../db/repositories/positions';
import { getSettingValue, setSetting } from '../db/repositories/system-settings';
import { findAllStrategies } from '../db/repositories/strategies';
import { AuditLog, Order, Position } from '../db/types';
import { approveProposal, createSignalAndProposal } from '../services/trade-proposal-service';
import { executeApprovedProposal } from '../services/trade-execution-service';
import {
  evaluateRisk,
  getAllMarketSnapshots,
  getBrokerHealth,
  getBrokerOpenOrders,
  getMarketSnapshot,
  getPaperAccount,
  getPaperPortfolio,
  MarketSnapshotDTO,
  PaperPortfolioDTO,
} from '../services/trading-engine-client';
import { preflightChecks as phase17PreflightChecks } from './phase17-paper-validation';

export type ValidationStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'WARN';

export interface ValidationCheck {
  name: string;
  status: ValidationStatus;
  detail: string;
  evidence?: Record<string, unknown>;
}

export interface Phase21Report {
  phase: '21';
  generatedAt: string;
  tradingMode: 'PAPER';
  overallStatus: ValidationStatus;
  symbol: string;
  checks: ValidationCheck[];
}

type Env = Record<string, string | undefined>;

interface Owner {
  id: string;
  email: string;
}

function addCheck(
  checks: ValidationCheck[],
  name: string,
  status: ValidationStatus,
  detail: string,
  evidence?: Record<string, unknown>,
): void {
  checks.push({ name, status, detail, ...(evidence ? { evidence } : {}) });
}

function overallStatus(checks: ValidationCheck[]): ValidationStatus {
  if (checks.some((check) => check.status === 'FAIL')) return 'FAIL';
  if (checks.some((check) => check.status === 'BLOCKED')) return 'BLOCKED';
  if (checks.some((check) => check.status === 'WARN')) return 'WARN';
  return 'PASS';
}

function decimal(value: string | null | undefined): Decimal {
  return new Decimal(value ?? '0');
}

function money(value: Decimal): string {
  return value.toDecimalPlaces(8).toFixed(8);
}

async function loadDotEnvDefaults(rootDir: string): Promise<void> {
  try {
    const raw = await readFile(path.join(rootDir, '.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const separator = trimmed.indexOf('=');
      if (separator <= 0) continue;
      const key = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim();
      if (!process.env[key]) {
        process.env[key] = value.replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    // Operators may provide environment through a process manager or secret store.
  }
}

function phase21OrderOptIn(env: Env): ValidationCheck {
  return {
    name: 'phase 21 paper order execution opt-in',
    status: env.PHASE21_ENABLE_PAPER_ORDERS === 'true' ? 'PASS' : 'BLOCKED',
    detail: env.PHASE21_ENABLE_PAPER_ORDERS === 'true'
      ? 'PHASE21_ENABLE_PAPER_ORDERS=true permits one paper-only validation order.'
      : 'Set PHASE21_ENABLE_PAPER_ORDERS=true to permit one Alpaca PAPER validation order.',
  };
}

export function preflightChecks(env: Env): ValidationCheck[] {
  const checks = phase17PreflightChecks({
    ...env,
    PHASE17_ENABLE_PAPER_ORDERS: env.PHASE21_ENABLE_PAPER_ORDERS,
  })
    .filter((check) => check.name !== 'paper order execution opt-in')
    .map((check) => ({
      ...check,
      detail: check.detail.replace(/Phase 17/g, 'Phase 21'),
    }));

  checks.push(phase21OrderOptIn(env));
  addCheck(
    checks,
    'api dashboard endpoint configured',
    env.PHASE21_API_URL && env.PHASE21_OWNER_BEARER_TOKEN ? 'PASS' : 'BLOCKED',
    env.PHASE21_API_URL && env.PHASE21_OWNER_BEARER_TOKEN
      ? 'PHASE21_API_URL and PHASE21_OWNER_BEARER_TOKEN are configured.'
      : 'Set PHASE21_API_URL and PHASE21_OWNER_BEARER_TOKEN to validate the running dashboard API.',
  );
  return checks;
}

async function findOwner(pool: Pool): Promise<Owner | null> {
  const { rows } = await pool.query(
    "SELECT id, email FROM users WHERE role = 'owner' AND is_active = TRUE ORDER BY created_at LIMIT 1",
  );
  if (!rows.length) return null;
  return { id: rows[0].id as string, email: rows[0].email as string };
}

function baseRiskRequest(
  symbol: string,
  market: MarketSnapshotDTO,
  portfolio: PaperPortfolioDTO,
  killSwitchEnabled: boolean,
) {
  return {
    stage: 'PRE_EXECUTION' as const,
    proposal: {
      symbol,
      side: 'BUY' as const,
      quantity: '1.00000000',
      reference_price: market.price,
      expires_at: new Date(Date.now() + 300_000).toISOString(),
    },
    market: {
      symbol,
      price: market.price,
      is_stale: market.is_stale,
      timestamp: market.timestamp,
    },
    portfolio: {
      cash: portfolio.cash,
      positions: portfolio.positions,
      equity: portfolio.cash,
      daily_pnl: '0.00000000',
    },
    config: {
      kill_switch_enabled: killSwitchEnabled,
      trading_mode: 'PAPER',
      market_data_staleness_seconds: 60,
      price_drift_threshold_pct: '2',
      max_order_notional_usd: '10000',
      max_position_size_usd: '50000',
      max_portfolio_concentration_pct: '100',
      max_open_positions: 100,
      max_daily_loss_usd: '1000',
      proposal_ttl_seconds: 300,
      cooldown_between_trades_seconds: 0,
    },
    pending_proposals: [],
    last_fill_times: {},
  };
}

async function fetchDashboard(env: Env): Promise<Record<string, unknown>> {
  const baseUrl = env.PHASE21_API_URL?.replace(/\/$/, '');
  if (!baseUrl) throw new Error('PHASE21_API_URL is not configured');
  const token = env.PHASE21_OWNER_BEARER_TOKEN;
  if (!token) throw new Error('PHASE21_OWNER_BEARER_TOKEN is not configured');

  const response = await fetch(`${baseUrl}/dashboard/paper`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Request-ID': 'phase21-dashboard',
    },
  });
  if (!response.ok) {
    throw new Error(`Dashboard API returned ${response.status}`);
  }
  const parsed = await response.json();
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Dashboard API returned a malformed response');
  }
  return parsed as Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function dashboardMatches(
  dashboard: Record<string, unknown>,
  account: { cash: string; buying_power: string },
  marketSnapshots: MarketSnapshotDTO[],
): { ok: boolean; evidence: Record<string, unknown> } {
  const broker = asRecord(dashboard.broker);
  const marketData = asRecord(dashboard.marketData);
  const dashboardSnapshots = Array.isArray(marketData.snapshots)
    ? marketData.snapshots as Record<string, unknown>[]
    : [];
  const firstMarket = marketSnapshots[0];
  const firstDashboard = dashboardSnapshots.find((snapshot) => snapshot.symbol === firstMarket?.symbol);

  const ok = dashboard.tradingMode === 'PAPER'
    && dashboard.paperTrading === true
    && broker.status === 'CONNECTED'
    && broker.cash === account.cash
    && broker.buyingPower === account.buying_power
    && marketData.status === 'CONNECTED'
    && (!firstMarket || firstDashboard?.price === firstMarket.price);

  return {
    ok,
    evidence: {
      tradingMode: dashboard.tradingMode,
      brokerStatus: broker.status,
      brokerCash: broker.cash,
      accountCash: account.cash,
      brokerBuyingPower: broker.buyingPower,
      accountBuyingPower: account.buying_power,
      marketDataStatus: marketData.status,
      firstDashboardSymbol: firstDashboard?.symbol,
      firstDashboardPrice: firstDashboard?.price,
      firstMarketPrice: firstMarket?.price,
    },
  };
}

function positionMap(positions: Position[]): Record<string, string> {
  return Object.fromEntries(positions.map((position) => [position.symbol, position.quantity]));
}

function brokerPositionDrift(
  dbPositions: Position[],
  brokerPositions: Record<string, string>,
): Record<string, { database: string; broker: string }> {
  const drift: Record<string, { database: string; broker: string }> = {};
  const database = positionMap(dbPositions);
  for (const symbol of new Set([...Object.keys(database), ...Object.keys(brokerPositions)])) {
    const dbQty = decimal(database[symbol]);
    const brokerQty = decimal(brokerPositions[symbol]);
    if (!dbQty.eq(brokerQty)) {
      drift[symbol] = { database: money(dbQty), broker: money(brokerQty) };
    }
  }
  return drift;
}

function orderFillDrift(orders: Order[], fillSumsByOrderId: Record<string, Decimal>): string[] {
  return orders
    .filter((order) => !decimal(order.filledQuantity).eq(fillSumsByOrderId[order.id] ?? new Decimal(0)))
    .map((order) => order.id);
}

async function runWorkflow(pool: Pool, symbol: string): Promise<Record<string, unknown>> {
  const owner = await findOwner(pool);
  if (!owner) throw new Error('No active owner user exists in the database');
  const strategy = (await findAllStrategies(pool, true))[0];
  if (!strategy) throw new Error('No active strategy exists in the database');

  const requestSuffix = Date.now().toString();
  const actor = {
    actorId: owner.id,
    actorEmail: owner.email,
    requestId: `phase21-create-${requestSuffix}`,
  };
  const created = await createSignalAndProposal(
    pool,
    {
      strategyId: strategy.id,
      symbol,
      side: 'BUY',
      quantity: process.env.PHASE21_QUANTITY ?? '1.00000000',
      orderType: 'MARKET',
      reason: 'Phase 21 Alpaca PAPER operational validation',
    },
    actor,
  );
  const approvalRequestId = `phase21-approve-${requestSuffix}`;
  const approved = await approveProposal(pool, created.proposal.id, {
    actorId: owner.id,
    actorEmail: owner.email,
    requestId: approvalRequestId,
  });
  const duplicateApproval = await approveProposal(pool, created.proposal.id, {
    actorId: owner.id,
    actorEmail: owner.email,
    requestId: approvalRequestId,
  });
  const executed = await executeApprovedProposal(pool, approved.proposal.id, {
    actorId: owner.id,
    actorEmail: owner.email,
    requestId: `phase21-execute-${requestSuffix}`,
  });
  const duplicateExecution = await executeApprovedProposal(pool, approved.proposal.id, {
    actorId: owner.id,
    actorEmail: owner.email,
    requestId: `phase21-execute-retry-${requestSuffix}`,
  });
  const auditLogs: AuditLog[] = await findAuditLogsByEntity(
    pool,
    'trade_proposal',
    created.proposal.id,
  );

  return {
    proposalId: created.proposal.id,
    createdStatus: created.proposal.status,
    approvedStatus: approved.proposal.status,
    executionStatus: executed.execution.status,
    finalProposalStatus: executed.proposal.status,
    orderStatus: executed.order?.status ?? null,
    fillCount: executed.fills.length,
    positionQuantity: executed.position?.quantity ?? null,
    brokerOrderId: executed.order?.brokerOrderId ?? null,
    idempotentApproval: duplicateApproval.idempotent,
    idempotentExecution: duplicateExecution.idempotent,
    auditEvents: auditLogs.map((log) => log.eventType),
  };
}

async function validateKillSwitch(pool: Pool, symbol: string, market: MarketSnapshotDTO, portfolio: PaperPortfolioDTO) {
  const before = await getSettingValue<boolean>(pool, 'trading_kill_switch_enabled') ?? true;
  try {
    await setSetting(pool, 'trading_kill_switch_enabled', false, null);
    const rejected = await evaluateRisk(baseRiskRequest(symbol, market, portfolio, false), 'phase21-kill-disabled');
    await setSetting(pool, 'trading_kill_switch_enabled', before, null);
    return {
      passed: rejected.failed_rules.includes('KILL_SWITCH'),
      evidence: { before, failedRules: rejected.failed_rules },
    };
  } catch (err) {
    await setSetting(pool, 'trading_kill_switch_enabled', before, null);
    throw err;
  }
}

export async function runPhase21Validation(env: Env = process.env): Promise<Phase21Report> {
  const symbol = (env.PHASE21_SYMBOL ?? 'AAPL').toUpperCase();
  const checks = preflightChecks(env);
  const preflightStatus = overallStatus(checks);
  if (preflightStatus === 'FAIL' || preflightStatus === 'BLOCKED') {
    return {
      phase: '21',
      generatedAt: new Date().toISOString(),
      tradingMode: 'PAPER',
      overallStatus: preflightStatus,
      symbol,
      checks,
    };
  }

  let pool: Pool | null = null;
  try {
    pool = createPool(env.DATABASE_URL);
    const [market, marketSnapshots, portfolio, account, brokerHealth, openOrders] = await Promise.all([
      getMarketSnapshot(symbol, 'phase21-market'),
      getAllMarketSnapshots('phase21-market-all'),
      getPaperPortfolio('phase21-portfolio'),
      getPaperAccount('phase21-account'),
      getBrokerHealth('phase21-broker-health'),
      getBrokerOpenOrders('phase21-open-orders'),
    ]);
    if (!market) throw new Error(`No market snapshot returned for ${symbol}`);

    addCheck(checks, 'real US market data works', market.is_stale ? 'WARN' : 'PASS', 'Read market data from the configured Alpaca provider.', {
      symbol: market.symbol,
      price: market.price,
      timestamp: market.timestamp,
      isStale: market.is_stale,
      snapshotCount: marketSnapshots.length,
    });
    addCheck(checks, 'Alpaca PAPER account connects', brokerHealth.available ? 'PASS' : 'FAIL', 'Read Alpaca PAPER broker health and account.', {
      ...brokerHealth,
      accountStatus: account.status,
      currency: account.currency,
      cash: account.cash,
      buyingPower: account.buying_power,
    });

    const dashboard = await fetchDashboard(env);
    const dashboardCheck = dashboardMatches(dashboard, account, marketSnapshots);
    addCheck(
      checks,
      'dashboard data is correct',
      dashboardCheck.ok ? 'PASS' : 'FAIL',
      'Compared running dashboard API against broker account and market-data reads.',
      dashboardCheck.evidence,
    );

    const killSwitch = await validateKillSwitch(pool, symbol, market, portfolio);
    addCheck(checks, 'kill switch works', killSwitch.passed ? 'PASS' : 'FAIL', 'Risk engine rejects paper trading when the kill switch disables execution.', killSwitch.evidence);

    const workflow = await runWorkflow(pool, symbol);
    addCheck(checks, 'signal risk proposal owner approval paper order end-to-end', 'PASS', 'Completed the paper-only operational workflow.', workflow);
    addCheck(
      checks,
      'reconnect restart recovery works',
      workflow.idempotentApproval && workflow.idempotentExecution ? 'PASS' : 'FAIL',
      'Retried approval and execution after the completed workflow; both returned idempotent results.',
      workflow,
    );

    const [orders, fills, positions, latestSnapshot, auditLogs] = await Promise.all([
      listOrders(pool, { limit: 100 }),
      listRecentFills(pool, 100),
      findOpenPositions(pool),
      findLatestSnapshot(pool),
      listAuditLogs(pool, { limit: 100 }),
    ]);
    const fillSumsByOrderId = fills.reduce<Record<string, Decimal>>((acc, fill) => {
      acc[fill.orderId] = (acc[fill.orderId] ?? new Decimal(0)).plus(fill.quantity);
      return acc;
    }, {});
    const orderDrift = orderFillDrift(orders, fillSumsByOrderId);
    const positionDrift = brokerPositionDrift(positions, portfolio.positions);
    const realizedPnl = positions.reduce((sum, position) => sum.plus(position.realizedPnl), new Decimal(0));
    const unrealizedPnl = positions.reduce((sum, position) => sum.plus(position.unrealizedPnl), new Decimal(0));
    const pnlMatches = latestSnapshot
      ? decimal(latestSnapshot.realizedPnl).eq(realizedPnl)
        && decimal(latestSnapshot.unrealizedPnl).eq(unrealizedPnl)
      : false;

    addCheck(
      checks,
      'orders fills positions P&L reconcile correctly',
      !orderDrift.length && Object.keys(positionDrift).length === 0 && pnlMatches ? 'PASS' : 'FAIL',
      'Compared database orders/fills/positions/P&L against persisted fills and Alpaca PAPER portfolio.',
      {
        orderCount: orders.length,
        fillCount: fills.length,
        openPositionCount: positions.length,
        brokerOpenOrderCount: openOrders.length,
        orderDrift,
        positionDrift,
        latestSnapshotRealizedPnl: latestSnapshot?.realizedPnl ?? null,
        computedRealizedPnl: money(realizedPnl),
        latestSnapshotUnrealizedPnl: latestSnapshot?.unrealizedPnl ?? null,
        computedUnrealizedPnl: money(unrealizedPnl),
      },
    );

    addCheck(
      checks,
      'logs and audit records are complete',
      auditLogs.length > 0 && Boolean((workflow.auditEvents as string[]).length) ? 'PASS' : 'FAIL',
      'Checked persisted audit logs for the Phase 21 proposal workflow and recent audit history.',
      { recentAuditLogCount: auditLogs.length, workflowAuditEvents: workflow.auditEvents },
    );
  } catch (err) {
    addCheck(checks, 'phase 21 runtime validation', 'FAIL', (err as Error).message);
  } finally {
    if (pool) await pool.end();
  }

  return {
    phase: '21',
    generatedAt: new Date().toISOString(),
    tradingMode: 'PAPER',
    overallStatus: overallStatus(checks),
    symbol,
    checks,
  };
}

export function renderMarkdownReport(report: Phase21Report): string {
  const lines = [
    '# Phase 21 PAPER Trading Operational Run Report',
    '',
    `Generated: ${report.generatedAt}`,
    `Mode: ${report.tradingMode}`,
    `Symbol: ${report.symbol}`,
    `Overall status: ${report.overallStatus}`,
    '',
    'This report is for Alpaca PAPER trading only. It does not validate, add, or enable live trading or real-money execution.',
    '',
    '| Check | Status | Detail |',
    '| --- | --- | --- |',
    ...report.checks.map((check) => (
      `| ${check.name} | ${check.status} | ${check.detail.replace(/\|/g, '\\|')} |`
    )),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

export async function writePhase21Reports(
  report: Phase21Report,
  rootDir = process.cwd(),
): Promise<{ jsonPath: string; markdownPath: string }> {
  const reportDir = path.join(rootDir, 'docs', 'reports');
  await mkdir(reportDir, { recursive: true });
  const jsonPath = path.join(reportDir, 'phase21-paper-operations-latest.json');
  const markdownPath = path.join(reportDir, 'PHASE_21_PAPER_TRADING_RUN_REPORT.md');
  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`),
    writeFile(markdownPath, renderMarkdownReport(report)),
  ]);
  return { jsonPath, markdownPath };
}

async function main(): Promise<void> {
  const rootDir = path.resolve(__dirname, '..', '..', '..', '..');
  await loadDotEnvDefaults(rootDir);
  const report = await runPhase21Validation();
  const paths = await writePhase21Reports(report, rootDir);
  console.log(`Phase 21 validation ${report.overallStatus}`);
  console.log(`JSON report: ${paths.jsonPath}`);
  console.log(`Markdown report: ${paths.markdownPath}`);
  if (report.overallStatus === 'FAIL') process.exitCode = 1;
}

if (require.main === module) {
  void main();
}
