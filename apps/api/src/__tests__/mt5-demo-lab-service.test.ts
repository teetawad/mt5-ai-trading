import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { getTestPool, setupTestDb } from './db/setup';
import { describeExecutionEligibility, listMt5TradeHistory } from '../services/mt5-demo-lab-service';

const SKIP = !process.env.TEST_DATABASE_URL;

async function insertTradeOutcome(pool: Pool, overrides: Record<string, unknown> = {}) {
  const base = {
    symbol: 'ETHUSD',
    side: 'BUY',
    volume: '0.10',
    order_ticket: '123456',
    opened_at: new Date(Date.now() - 3_600_000).toISOString(),
    closed_at: null,
    exit_reason: null,
    realized_pnl: null,
    account_equity_at_entry: null,
    ...overrides,
  };
  const result = await pool.query(
    `INSERT INTO trade_outcomes(symbol, side, volume, order_ticket, opened_at, closed_at, exit_reason, realized_pnl, account_equity_at_entry)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [
      base.symbol, base.side, base.volume, base.order_ticket, base.opened_at, base.closed_at,
      base.exit_reason, base.realized_pnl, base.account_equity_at_entry,
    ],
  );
  return result.rows[0];
}

// Bug 2: an EXECUTION_FAILED/RECONCILIATION_FAILED row (MT5 never confirmed
// a real position) must never be counted as a closed trade, win, or loss —
// this is the exact shape of the reported "TOTAL CLOSED TRADES=2, WINS/
// LOSSES=0/0, Exit Reason Breakdown: RECONCILIATION_FAILED=2" bug.
describe.skipIf(SKIP)('mt5-demo-lab-service history statistics', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = getTestPool();
    await setupTestDb(pool);
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM trade_outcomes');
  });

  it('an EXECUTION_FAILED (RECONCILIATION_FAILED) row is not counted as a closed trade', async () => {
    await insertTradeOutcome(pool, {
      closed_at: new Date().toISOString(),
      exit_reason: 'RECONCILIATION_FAILED',
      realized_pnl: null,
      order_ticket: 'entry-plan:abc:123',
    });
    const { trades, statistics } = await listMt5TradeHistory(pool);
    expect(trades[0].result_type).toBe('EXECUTION_FAILED');
    expect(statistics.totalClosedTrades).toBe(0);
    expect(statistics.wins).toBe(0);
    expect(statistics.losses).toBe(0);
    expect(statistics.executionFailures).toBe(1);
  });

  it('a real MT5-confirmed closed trade with positive net P&L is a WIN', async () => {
    await insertTradeOutcome(pool, { closed_at: new Date().toISOString(), exit_reason: 'TAKE_PROFIT', realized_pnl: '2.83' });
    const { statistics } = await listMt5TradeHistory(pool);
    expect(statistics.totalClosedTrades).toBe(1);
    expect(statistics.wins).toBe(1);
    expect(statistics.losses).toBe(0);
    expect(statistics.totalPnl).toBeCloseTo(2.83);
  });

  it('a real MT5-confirmed closed trade with negative net P&L is a LOSS', async () => {
    await insertTradeOutcome(pool, { closed_at: new Date().toISOString(), exit_reason: 'STOP_LOSS', realized_pnl: '-1.47' });
    const { statistics } = await listMt5TradeHistory(pool);
    expect(statistics.losses).toBe(1);
    expect(statistics.wins).toBe(0);
    expect(statistics.totalPnl).toBeCloseTo(-1.47);
  });

  it('breakeven (net P&L within a tiny rounding tolerance of zero) is neither a win nor a loss, but still counts as closed', async () => {
    await insertTradeOutcome(pool, { closed_at: new Date().toISOString(), exit_reason: 'MANUAL_CLOSE', realized_pnl: '0.00000001' });
    const { trades, statistics } = await listMt5TradeHistory(pool);
    expect(trades[0].result_type).toBe('BREAKEVEN');
    expect(statistics.totalClosedTrades).toBe(1);
    expect(statistics.wins).toBe(0);
    expect(statistics.losses).toBe(0);
    expect(statistics.breakeven).toBe(1);
  });

  it('an open position (no closed_at) is not counted as a closed trade', async () => {
    await insertTradeOutcome(pool, { closed_at: null, exit_reason: null, realized_pnl: null });
    const { statistics } = await listMt5TradeHistory(pool);
    expect(statistics.totalClosedTrades).toBe(0);
  });

  it('win rate is wins / (wins + losses) — breakeven and execution failures are excluded from both sides of the ratio', async () => {
    await insertTradeOutcome(pool, { order_ticket: '1', closed_at: new Date().toISOString(), exit_reason: 'TAKE_PROFIT', realized_pnl: '5' }); // WIN
    await insertTradeOutcome(pool, { order_ticket: '2', closed_at: new Date().toISOString(), exit_reason: 'STOP_LOSS', realized_pnl: '-3' }); // LOSS
    await insertTradeOutcome(pool, { order_ticket: '3', closed_at: new Date().toISOString(), exit_reason: 'MANUAL_CLOSE', realized_pnl: '0' }); // BREAKEVEN
    await insertTradeOutcome(pool, { order_ticket: '4', closed_at: new Date().toISOString(), exit_reason: 'RECONCILIATION_FAILED', realized_pnl: null }); // EXECUTION_FAILED
    const { statistics } = await listMt5TradeHistory(pool);
    expect(statistics.totalClosedTrades).toBe(3);
    expect(statistics.wins).toBe(1);
    expect(statistics.losses).toBe(1);
    expect(statistics.breakeven).toBe(1);
    expect(statistics.executionFailures).toBe(1);
    expect(statistics.winRate).toBeCloseTo(0.5); // 1 / (1 + 1), not 1/3 and not 1/4
  });

  it('the exit-reason breakdown never surfaces RECONCILIATION_FAILED as if it were a real trading exit', async () => {
    await insertTradeOutcome(pool, { closed_at: new Date().toISOString(), exit_reason: 'RECONCILIATION_FAILED', realized_pnl: null });
    const { statistics } = await listMt5TradeHistory(pool);
    expect(statistics.exitReasons.some((row) => row.label === 'RECONCILIATION_FAILED')).toBe(false);
  });

  it('duplicate/re-run reconciliation of the same closed position is not double-counted (one row, one outcome)', async () => {
    const row = await insertTradeOutcome(pool, { closed_at: new Date().toISOString(), exit_reason: 'TAKE_PROFIT', realized_pnl: '4.20' });
    // Simulate a second reconciliation pass attempting to touch the same
    // already-closed row: the WHERE closed_at IS NULL guard used in
    // production code means this must be a no-op, not a new row.
    await pool.query(`UPDATE trade_outcomes SET realized_pnl=$2 WHERE id=$1 AND closed_at IS NULL`, [row.id, '999']);
    const { trades, statistics } = await listMt5TradeHistory(pool);
    expect(trades).toHaveLength(1);
    expect(statistics.totalClosedTrades).toBe(1);
    expect(statistics.totalPnl).toBeCloseTo(4.2);
  });

  it('computes % account return from the stored equity-at-entry basis, never from unrelated current equity', async () => {
    await insertTradeOutcome(pool, {
      closed_at: new Date().toISOString(),
      exit_reason: 'TAKE_PROFIT',
      realized_pnl: '5.00',
      account_equity_at_entry: '500.00',
    });
    const { trades } = await listMt5TradeHistory(pool);
    expect(trades[0].account_return_pct).toBeCloseTo(1.0); // 5 / 500 * 100
  });

  it('does not invent a % account return for trades with no stored equity-at-entry basis (older rows)', async () => {
    await insertTradeOutcome(pool, {
      closed_at: new Date().toISOString(),
      exit_reason: 'TAKE_PROFIT',
      realized_pnl: '5.00',
      account_equity_at_entry: null,
    });
    const { trades } = await listMt5TradeHistory(pool);
    expect(trades[0].account_return_pct).toBeNull();
  });

  it('profit factor is gross profit / gross loss, and holding time averages only real closed trades', async () => {
    const opened = new Date(Date.now() - 60 * 60_000).toISOString(); // 60 min ago
    await insertTradeOutcome(pool, { order_ticket: '1', opened_at: opened, closed_at: new Date().toISOString(), exit_reason: 'TAKE_PROFIT', realized_pnl: '10' });
    await insertTradeOutcome(pool, { order_ticket: '2', opened_at: opened, closed_at: new Date().toISOString(), exit_reason: 'STOP_LOSS', realized_pnl: '-4' });
    const { statistics } = await listMt5TradeHistory(pool);
    expect(statistics.profitFactor).toBeCloseTo(2.5); // 10 / 4
    expect(statistics.averageHoldingMinutes).toBeGreaterThan(55);
    expect(statistics.averageHoldingMinutes).toBeLessThan(65);
  });

  it('profit factor is null (not Infinity or 0) when there are no losses to divide by', async () => {
    await insertTradeOutcome(pool, { closed_at: new Date().toISOString(), exit_reason: 'TAKE_PROFIT', realized_pnl: '10' });
    const { statistics } = await listMt5TradeHistory(pool);
    expect(statistics.profitFactor).toBeNull();
  });
});

// Single source of truth for "Trade in Demo" eligibility: canExecute must be
// grounded in the real persisted plan row (status + execution_key), never
// only AI BUY/RISK PASS/MARKET OPEN. Pure function — no DB needed.
describe('describeExecutionEligibility', () => {
  const enabledButton = { enabled: true, disabledReasons: [] };
  const blockedButton = { enabled: false, disabledReasons: [{ rule: 'SPREAD_TOO_HIGH', explanation: 'The spread is too expensive right now.' }] };

  it('READY with no stale lock and tradeButton enabled -> canExecute true', () => {
    const result = describeExecutionEligibility({ status: 'READY', execution_key: null }, enabledButton);
    expect(result).toEqual({ canExecute: true, entryStatus: 'READY', blockCode: null, blockMessage: null });
  });

  it('TRIGGERED with no stale lock and tradeButton enabled -> canExecute true', () => {
    const result = describeExecutionEligibility({ status: 'TRIGGERED', execution_key: null }, enabledButton);
    expect(result.canExecute).toBe(true);
    expect(result.entryStatus).toBe('TRIGGERED');
  });

  it('WAITING -> canExecute false, WAITING_ENTRY', () => {
    const result = describeExecutionEligibility({ status: 'WAITING' }, enabledButton);
    expect(result.canExecute).toBe(false);
    expect(result.blockCode).toBe('WAITING_ENTRY');
  });

  it('EXECUTING -> canExecute false, EXECUTION_IN_PROGRESS', () => {
    const result = describeExecutionEligibility({ status: 'EXECUTING' }, enabledButton);
    expect(result.canExecute).toBe(false);
    expect(result.blockCode).toBe('EXECUTION_IN_PROGRESS');
  });

  it('EXECUTED -> canExecute false, ALREADY_EXECUTED', () => {
    const result = describeExecutionEligibility({ status: 'EXECUTED', order_ticket: '123' }, enabledButton);
    expect(result.canExecute).toBe(false);
    expect(result.blockCode).toBe('ALREADY_EXECUTED');
  });

  it('EXPIRED -> canExecute false, PLAN_EXPIRED', () => {
    const result = describeExecutionEligibility({ status: 'EXPIRED' }, enabledButton);
    expect(result.canExecute).toBe(false);
    expect(result.blockCode).toBe('PLAN_EXPIRED');
  });

  it('CANCELLED -> canExecute false, PLAN_CANCELLED', () => {
    const result = describeExecutionEligibility({ status: 'CANCELLED' }, enabledButton);
    expect(result.canExecute).toBe(false);
    expect(result.blockCode).toBe('PLAN_CANCELLED');
  });

  it('BLOCKED -> canExecute false, exposes the real block_reason code', () => {
    const result = describeExecutionEligibility({ status: 'BLOCKED', block_reason: 'COOLDOWN' }, blockedButton);
    expect(result.canExecute).toBe(false);
    expect(result.blockCode).toBe('COOLDOWN');
  });

  it('regression: READY status but a stale execution_key lock still present -> canExecute false, not silently true', () => {
    // This is the exact shape of the reported bug if it were ever to recur:
    // status looks eligible, but the row is still holding a claim lock.
    const result = describeExecutionEligibility({ status: 'READY', execution_key: 'entry-plan:stale:123' }, enabledButton);
    expect(result.canExecute).toBe(false);
    expect(result.blockCode).toBe('EXECUTION_IN_PROGRESS');
  });

  it('READY but tradeButton itself is disabled (risk/market conditions) -> canExecute false, surfaces that reason', () => {
    const result = describeExecutionEligibility({ status: 'READY', execution_key: null }, blockedButton);
    expect(result.canExecute).toBe(false);
    expect(result.blockCode).toBe('SPREAD_TOO_HIGH');
  });

  it('no persisted row yet for this symbol -> falls back to the live tradeButton read', () => {
    expect(describeExecutionEligibility(undefined, enabledButton).canExecute).toBe(true);
    expect(describeExecutionEligibility(undefined, blockedButton).canExecute).toBe(false);
  });
});
