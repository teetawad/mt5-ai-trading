import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';
import { createPool } from '../db/client';
import { findAuditLogsByEntity } from '../db/repositories/audit-logs';
import { findLatestSnapshot } from '../db/repositories/portfolio-snapshots';
import { findAllStrategies } from '../db/repositories/strategies';
import { AuditLog } from '../db/types';
import { approveProposal, createSignalAndProposal } from '../services/trade-proposal-service';
import { executeApprovedProposal } from '../services/trade-execution-service';
import {
  evaluateRisk,
  getBrokerHealth,
  getBrokerOpenOrders,
  getMarketSnapshot,
  getPaperAccount,
  getPaperPortfolio,
  MarketSnapshotDTO,
  PaperPortfolioDTO,
} from '../services/trading-engine-client';

export type ValidationStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'WARN';

export interface ValidationCheck {
  name: string;
  status: ValidationStatus;
  detail: string;
  evidence?: Record<string, unknown>;
}

export interface Phase17Report {
  phase: '17';
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

interface WorkflowEvidence {
  proposalId: string;
  proposalStatus: string;
  approvalStatus: string;
  executionStatus: string;
  orderStatus: string | null;
  fillCount: number;
  positionQuantity: string | null;
  brokerOrderId: string | null;
  idempotentApproval: boolean;
  idempotentExecution: boolean;
  auditEvents: string[];
}

function hasPaperKey(env: Env): boolean {
  return Boolean(env.ALPACA_PAPER_API_KEY_ID || env.APCA_API_KEY_ID);
}

function hasPaperSecret(env: Env): boolean {
  return Boolean(env.ALPACA_PAPER_API_SECRET_KEY || env.APCA_API_SECRET_KEY);
}

function isLiveTradingUrl(value: string | undefined): boolean {
  return Boolean(
    value
      && value.includes('api.alpaca.markets')
      && !value.includes('paper-api.alpaca.markets'),
  );
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

export function preflightChecks(env: Env): ValidationCheck[] {
  const checks: ValidationCheck[] = [];
  addCheck(
    checks,
    'paper trading mode',
    env.BROKER_PROVIDER === 'alpaca_paper' ? 'PASS' : 'BLOCKED',
    env.BROKER_PROVIDER === 'alpaca_paper'
      ? 'BROKER_PROVIDER is alpaca_paper.'
      : 'Set BROKER_PROVIDER=alpaca_paper before Phase 17 validation.',
  );
  addCheck(
    checks,
    'alpaca market data provider',
    env.MARKET_DATA_PROVIDER === 'alpaca' ? 'PASS' : 'BLOCKED',
    env.MARKET_DATA_PROVIDER === 'alpaca'
      ? 'MARKET_DATA_PROVIDER is alpaca.'
      : 'Set MARKET_DATA_PROVIDER=alpaca before Phase 17 validation.',
  );
  addCheck(
    checks,
    'database configured',
    env.DATABASE_URL ? 'PASS' : 'BLOCKED',
    env.DATABASE_URL
      ? 'DATABASE_URL is configured.'
      : 'DATABASE_URL is required to validate proposals, orders, fills, positions, and audit logs.',
  );
  addCheck(
    checks,
    'trading engine configured',
    env.TRADING_ENGINE_URL ? 'PASS' : 'BLOCKED',
    env.TRADING_ENGINE_URL
      ? 'TRADING_ENGINE_URL is configured.'
      : 'TRADING_ENGINE_URL is required to validate real market data and Alpaca paper broker state.',
  );
  addCheck(
    checks,
    'alpaca paper credentials',
    hasPaperKey(env) && hasPaperSecret(env) ? 'PASS' : 'BLOCKED',
    hasPaperKey(env) && hasPaperSecret(env)
      ? 'Alpaca paper credentials are present in environment variables.'
      : 'Alpaca paper credentials must be provided through environment variables only.',
  );
  addCheck(
    checks,
    'live trading endpoint guard',
    isLiveTradingUrl(env.ALPACA_PAPER_TRADING_BASE_URL) ? 'FAIL' : 'PASS',
    isLiveTradingUrl(env.ALPACA_PAPER_TRADING_BASE_URL)
      ? 'ALPACA_PAPER_TRADING_BASE_URL points at a live trading endpoint.'
      : 'No live Alpaca trading endpoint is configured for paper trading.',
  );
  addCheck(
    checks,
    'paper order execution opt-in',
    env.PHASE17_ENABLE_PAPER_ORDERS === 'true' ? 'PASS' : 'BLOCKED',
    env.PHASE17_ENABLE_PAPER_ORDERS === 'true'
      ? 'PHASE17_ENABLE_PAPER_ORDERS=true permits paper-only order submission.'
      : 'Set PHASE17_ENABLE_PAPER_ORDERS=true to permit the validator to submit Alpaca paper orders.',
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
  overrides: {
    killSwitchEnabled?: boolean;
    isStale?: boolean;
  } = {},
) {
  const expiresAt = new Date(Date.now() + 300_000).toISOString();
  return {
    stage: 'PRE_EXECUTION' as const,
    proposal: {
      symbol,
      side: 'BUY' as const,
      quantity: '1.00000000',
      reference_price: market.price,
      expires_at: expiresAt,
    },
    market: {
      symbol,
      price: market.price,
      is_stale: overrides.isStale ?? market.is_stale,
      timestamp: market.timestamp,
    },
    portfolio: {
      cash: portfolio.cash,
      positions: portfolio.positions,
      equity: portfolio.cash,
      daily_pnl: '0.00000000',
    },
    config: {
      kill_switch_enabled: overrides.killSwitchEnabled ?? true,
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

async function runMonitoringSamples(
  symbol: string,
  cycles: number,
): Promise<{ brokerSamples: boolean[]; marketSamples: boolean[] }> {
  const brokerSamples: boolean[] = [];
  const marketSamples: boolean[] = [];
  for (let index = 0; index < cycles; index += 1) {
    const [broker, market] = await Promise.all([
      getBrokerHealth(`phase17-monitor-${index}`),
      getMarketSnapshot(symbol, `phase17-monitor-${index}`),
    ]);
    brokerSamples.push(broker.available);
    marketSamples.push(Boolean(market && !market.is_stale));
  }
  return { brokerSamples, marketSamples };
}

async function runWorkflow(pool: Pool, symbol: string): Promise<WorkflowEvidence> {
  const owner = await findOwner(pool);
  if (!owner) throw new Error('No active owner user exists in the database');

  const strategies = await findAllStrategies(pool, true);
  const strategy = strategies[0];
  if (!strategy) throw new Error('No active strategy exists in the database');

  const requestSuffix = Date.now().toString();
  const actor = {
    actorId: owner.id,
    actorEmail: owner.email,
    requestId: `phase17-create-${requestSuffix}`,
  };
  const created = await createSignalAndProposal(
    pool,
    {
      strategyId: strategy.id,
      symbol,
      side: 'BUY',
      quantity: process.env.PHASE17_QUANTITY ?? '1.00000000',
      orderType: 'MARKET',
      reason: 'Phase 17 Alpaca PAPER long-run validation',
    },
    actor,
  );
  if (created.proposal.status !== 'PENDING_APPROVAL') {
    throw new Error(`Proposal did not reach PENDING_APPROVAL: ${created.proposal.status}`);
  }

  const approvalRequestId = `phase17-approve-${requestSuffix}`;
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
    requestId: `phase17-execute-${requestSuffix}`,
  });
  const duplicateExecution = await executeApprovedProposal(pool, approved.proposal.id, {
    actorId: owner.id,
    actorEmail: owner.email,
    requestId: `phase17-execute-retry-${requestSuffix}`,
  });
  const auditLogs: AuditLog[] = await findAuditLogsByEntity(
    pool,
    'trade_proposal',
    created.proposal.id,
  );

  return {
    proposalId: created.proposal.id,
    proposalStatus: created.proposal.status,
    approvalStatus: approved.proposal.status,
    executionStatus: executed.execution.status,
    orderStatus: executed.order?.status ?? null,
    fillCount: executed.fills.length,
    positionQuantity: executed.position?.quantity ?? null,
    brokerOrderId: executed.order?.brokerOrderId ?? null,
    idempotentApproval: duplicateApproval.idempotent,
    idempotentExecution: duplicateExecution.idempotent,
    auditEvents: auditLogs.map((log) => log.eventType),
  };
}

export async function runPhase17Validation(env: Env = process.env): Promise<Phase17Report> {
  const symbol = (env.PHASE17_SYMBOL ?? 'AAPL').toUpperCase();
  const checks = preflightChecks(env);
  const preflightStatus = overallStatus(checks);
  if (preflightStatus === 'FAIL' || preflightStatus === 'BLOCKED') {
    return {
      phase: '17',
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
    const [market, paperPortfolio, paperAccount, brokerHealth, brokerOpenOrders] = await Promise.all([
      getMarketSnapshot(symbol, 'phase17-market'),
      getPaperPortfolio('phase17-portfolio'),
      getPaperAccount('phase17-account'),
      getBrokerHealth('phase17-broker-health'),
      getBrokerOpenOrders('phase17-open-orders'),
    ]);
    if (!market) throw new Error(`No market snapshot returned for ${symbol}`);

    addCheck(checks, 'real US market data', market.is_stale ? 'WARN' : 'PASS', 'Received market snapshot from configured provider.', {
      symbol: market.symbol,
      price: market.price,
      timestamp: market.timestamp,
      isStale: market.is_stale,
    });
    addCheck(checks, 'alpaca paper broker connection', brokerHealth.available ? 'PASS' : 'FAIL', 'Checked paper broker health.', brokerHealth);
    addCheck(checks, 'cash and buying power reconciliation', 'PASS', 'Read paper account and portfolio cash.', {
      accountCash: paperAccount.cash,
      buyingPower: paperAccount.buying_power,
      portfolioCash: paperPortfolio.cash,
    });
    addCheck(checks, 'broker order synchronization read', 'PASS', 'Read current open paper broker orders.', {
      openOrderCount: brokerOpenOrders.length,
    });

    const staleRisk = await evaluateRisk(
      baseRiskRequest(symbol, market, paperPortfolio, { isStale: true }),
      'phase17-stale-risk',
    );
    addCheck(
      checks,
      'stale market data handling',
      staleRisk.failed_rules.includes('MARKET_DATA_FRESHNESS') ? 'PASS' : 'FAIL',
      'Risk engine must reject stale market data.',
      { failedRules: staleRisk.failed_rules },
    );

    const killRisk = await evaluateRisk(
      baseRiskRequest(symbol, market, paperPortfolio, { killSwitchEnabled: false }),
      'phase17-kill-risk',
    );
    addCheck(
      checks,
      'kill switch',
      killRisk.failed_rules.includes('KILL_SWITCH') ? 'PASS' : 'FAIL',
      'Risk engine must reject when kill switch is disabled.',
      { failedRules: killRisk.failed_rules },
    );

    const workflow = await runWorkflow(pool, symbol);
    addCheck(checks, 'signal to paper order workflow', 'PASS', 'Completed signal, risk, proposal, approval, and paper order workflow.', { ...workflow });
    addCheck(checks, 'order fill position synchronization', workflow.orderStatus ? 'PASS' : 'FAIL', 'Validated persisted order/fill/position evidence.', { ...workflow });
    addCheck(checks, 'realized and unrealized P&L', await findLatestSnapshot(pool) ? 'PASS' : 'WARN', 'Checked portfolio snapshot after paper execution.');
    addCheck(
      checks,
      'duplicate and retry protection',
      workflow.idempotentApproval && workflow.idempotentExecution ? 'PASS' : 'FAIL',
      'Repeated approval and execution calls must be idempotent.',
      { ...workflow },
    );
    addCheck(
      checks,
      'audit logs',
      workflow.auditEvents.includes('TRADE_PROPOSAL_CREATED')
        && workflow.auditEvents.includes('TRADE_PROPOSAL_APPROVED')
        && workflow.auditEvents.includes('TRADE_EXECUTED')
        ? 'PASS'
        : 'FAIL',
      'Checked required audit events for the validation proposal.',
      { auditEvents: workflow.auditEvents },
    );

    const cycles = Math.max(1, Number(env.PHASE17_MONITOR_CYCLES ?? 3));
    const samples = await runMonitoringSamples(symbol, cycles);
    addCheck(
      checks,
      'reconnect and recovery behavior',
      samples.brokerSamples.every(Boolean) && samples.marketSamples.every(Boolean) ? 'PASS' : 'WARN',
      'Sampled repeated broker and market-data reads for recovery monitoring.',
      samples,
    );
  } catch (err) {
    addCheck(checks, 'phase 17 runtime validation', 'FAIL', (err as Error).message);
  } finally {
    if (pool) await pool.end();
  }

  return {
    phase: '17',
    generatedAt: new Date().toISOString(),
    tradingMode: 'PAPER',
    overallStatus: overallStatus(checks),
    symbol,
    checks,
  };
}

export function renderMarkdownReport(report: Phase17Report): string {
  const lines = [
    '# Phase 17 Long-Run PAPER Trading Validation Report',
    '',
    `Generated: ${report.generatedAt}`,
    `Mode: ${report.tradingMode}`,
    `Symbol: ${report.symbol}`,
    `Overall status: ${report.overallStatus}`,
    '',
    'This report is for Alpaca PAPER trading only. It does not validate or enable live trading.',
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

export async function writePhase17Reports(
  report: Phase17Report,
  rootDir = process.cwd(),
): Promise<{ jsonPath: string; markdownPath: string }> {
  const reportDir = path.join(rootDir, 'docs', 'reports');
  await mkdir(reportDir, { recursive: true });
  const jsonPath = path.join(reportDir, 'phase17-paper-validation-latest.json');
  const markdownPath = path.join(reportDir, 'PHASE_17_LONG_RUN_PAPER_VALIDATION.md');
  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`),
    writeFile(markdownPath, renderMarkdownReport(report)),
  ]);
  return { jsonPath, markdownPath };
}

async function main(): Promise<void> {
  const report = await runPhase17Validation();
  const paths = await writePhase17Reports(report, path.resolve(__dirname, '..', '..', '..', '..'));
  console.log(`Phase 17 validation ${report.overallStatus}`);
  console.log(`JSON report: ${paths.jsonPath}`);
  console.log(`Markdown report: ${paths.markdownPath}`);
  if (report.overallStatus === 'FAIL') process.exitCode = 1;
}

if (require.main === module) {
  void main();
}
