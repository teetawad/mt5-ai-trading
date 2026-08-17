import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { getTestPool, setupTestDb } from './db/setup';

const SKIP = !process.env.TEST_DATABASE_URL;

vi.mock('../services/mt5-client', () => ({
  getMt5Status: vi.fn(),
  getMt5Tick: vi.fn(),
  getMt5MarketStatus: vi.fn(),
  getMt5SymbolInfo: vi.fn(),
  listMt5Positions: vi.fn(),
  listMt5PendingOrders: vi.fn(),
  checkMt5Order: vi.fn(),
  sendMt5Order: vi.fn(),
  analyzeMt5Symbol: vi.fn(),
  listMt5Symbols: vi.fn(),
}));

import * as mt5Client from '../services/mt5-client';
import {
  canTransition,
  executeEntryPlanById,
  reconcileStuckExecutions,
  refreshPlanStatus,
  runEntryPlanWatcherTick,
  Mt5Actor,
} from '../services/mt5-entry-plan-watcher';

const ACTOR: Mt5Actor = { actorId: null, actorEmail: 'test@internal', requestId: 'test' };

const DEMO_STATUS = {
  connected: true,
  demo_verified: true,
  account: { login: 60124487, server: 'TradeMaxGlobal-Demo', equity: '10000', balance: '10000', margin_free: '9000', free_margin: '9000' },
  terminal: { trade_allowed: true },
};

const OPEN_LIVE_MARKET = { market_status: 'OPEN', data_status: 'LIVE', quote_age_seconds: 1 };

const SYMBOL_INFO = { point: 0.01, trade_tick_size: 0.01, trade_stops_level: 0, trade_freeze_level: 0, volume_min: 0.01, volume_max: 100, volume_step: 0.01 };

function mockHappyPath(overrides: { tick?: Record<string, unknown>; market?: Record<string, unknown> } = {}) {
  vi.mocked(mt5Client.getMt5Status).mockResolvedValue(DEMO_STATUS as never);
  vi.mocked(mt5Client.getMt5Tick).mockResolvedValue({ bid: 1900, ask: 1900.2, ...overrides.tick } as never);
  vi.mocked(mt5Client.getMt5MarketStatus).mockResolvedValue({ ...OPEN_LIVE_MARKET, ...overrides.market } as never);
  vi.mocked(mt5Client.getMt5SymbolInfo).mockResolvedValue(SYMBOL_INFO as never);
  vi.mocked(mt5Client.listMt5Positions).mockResolvedValue([]);
  vi.mocked(mt5Client.listMt5PendingOrders).mockResolvedValue([]);
  vi.mocked(mt5Client.checkMt5Order).mockResolvedValue({ retcode: 10009 } as never);
  vi.mocked(mt5Client.sendMt5Order).mockResolvedValue({ retcode: 10009, order: 555111, deal: 555222 } as never);
}

async function insertDecision(pool: Pool, symbol: string, side: 'BUY' | 'SELL') {
  const feature = await pool.query(
    `INSERT INTO feature_snapshots(symbol, timeframe, signal_candle_timestamp, features)
     VALUES($1,'H1',$2,'{}'::jsonb) RETURNING id`,
    [symbol, new Date().toISOString()],
  );
  const decision = await pool.query(
    `INSERT INTO ai_decisions(feature_snapshot_id, symbol, asset_class, decision, confidence,
        opportunity_score, reasons, reference_entry, stop_loss, take_profit, risk_reward,
        expected_holding_hours, signal_candle_timestamp, model_version)
     VALUES($1,$2,'CRYPTO_CFD',$3,0.7,80,'[]'::jsonb,1900,1890.66,1925.89,2.5,8,$4,'TEST_MODEL_V1')
     RETURNING id`,
    [feature.rows[0].id, symbol, side, new Date().toISOString()],
  );
  return decision.rows[0].id as string;
}

async function insertPlan(pool: Pool, overrides: Record<string, unknown> = {}) {
  const symbol = String(overrides.symbol ?? 'ETHUSD');
  const side = String(overrides.side ?? 'BUY') as 'BUY' | 'SELL';
  const aiDecisionId = overrides.ai_decision_id ?? (await insertDecision(pool, symbol, side));
  const base = {
    ai_decision_id: aiDecisionId,
    symbol: 'ETHUSD',
    side: 'BUY',
    entry_strategy: 'PULLBACK',
    status: 'WAITING',
    entry_zone_low: '1899.20',
    entry_zone_high: '1901.16',
    trigger_price: null,
    reference_entry: '1900.00',
    stop_loss: '1890.66',
    take_profit: '1925.89',
    risk_reward: '2.5',
    recommended_volume: '0.12',
    max_planned_loss: '1.50',
    confidence: 0.7,
    opportunity_score: 80,
    signal_candle_timestamp: new Date().toISOString(),
    valid_until: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    executing_at: null,
    execution_key: null,
    ...overrides,
  };
  const result = await pool.query(
    `INSERT INTO mt5_entry_plans(ai_decision_id, symbol, side, entry_strategy, status, entry_zone_low, entry_zone_high,
        trigger_price, reference_entry, stop_loss, take_profit, risk_reward, recommended_volume,
        max_planned_loss, confidence, opportunity_score, signal_candle_timestamp, valid_until,
        executing_at, execution_key)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
     RETURNING *`,
    [
      base.ai_decision_id, base.symbol, base.side, base.entry_strategy, base.status, base.entry_zone_low, base.entry_zone_high,
      base.trigger_price, base.reference_entry, base.stop_loss, base.take_profit, base.risk_reward,
      base.recommended_volume, base.max_planned_loss, base.confidence, base.opportunity_score,
      base.signal_candle_timestamp, base.valid_until, base.executing_at, base.execution_key,
    ],
  );
  return result.rows[0];
}

async function planStatus(pool: Pool, id: string): Promise<string> {
  const result = await pool.query('SELECT status FROM mt5_entry_plans WHERE id=$1', [id]);
  return result.rows[0]?.status;
}

describe.skipIf(SKIP)('EntryPlanWatcher', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = getTestPool();
    await setupTestDb(pool);
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.MT5_KILL_SWITCH_ENABLED = 'false';
    process.env.MT5_AUTO_DEMO_ENABLED = 'true';
    process.env.MT5_MAX_RISK_PER_TRADE_PCT = '1';
    process.env.MT5_MAX_LOSS_PER_TRADE = '100';
    process.env.MT5_MIN_RISK_REWARD = '1.5';
    process.env.MT5_MAX_SIMULTANEOUS_POSITIONS = '3';
    process.env.MT5_MAX_TRADES_PER_DAY = '10';
    process.env.MT5_MAX_SPREAD_POINTS = '500';
    process.env.MT5_QUOTE_STALENESS_SECONDS = '30';
    process.env.MT5_COOLDOWN_MINUTES = '0';
    process.env.MT5_ALLOWED_DEVIATION_POINTS = '20';
    await pool.query('DELETE FROM trade_outcomes');
    await pool.query('DELETE FROM risk_evaluations');
    await pool.query('DELETE FROM mt5_entry_plans');
    await pool.query('DELETE FROM ai_decisions');
    await pool.query('DELETE FROM feature_snapshots');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------
  // State machine
  // ---------------------------------------------------------------------
  describe('state machine', () => {
    it('allows the documented legal transitions', () => {
      expect(canTransition('WAITING', 'TRIGGERED')).toBe(true);
      expect(canTransition('TRIGGERED', 'EXECUTING')).toBe(true);
      expect(canTransition('EXECUTING', 'EXECUTED')).toBe(true);
      expect(canTransition('WAITING', 'EXPIRED')).toBe(true);
      expect(canTransition('TRIGGERED', 'BLOCKED')).toBe(true);
    });

    it('rejects illegal transitions, including EXECUTED -> EXECUTING', () => {
      expect(canTransition('EXECUTED', 'EXECUTING')).toBe(false);
      expect(canTransition('EXPIRED', 'TRIGGERED')).toBe(false);
      expect(canTransition('CANCELLED', 'WAITING')).toBe(false);
      expect(canTransition('BLOCKED', 'EXECUTED')).toBe(false);
    });

    it('keeps a plan sticky at TRIGGERED even if price oscillates back out of the zone', () => {
      const waitingInput = {
        symbol: 'ETHUSD',
        side: 'BUY' as const,
        entryStrategy: 'PULLBACK' as const,
        currentAsk: '1902.40',
        entryZoneLow: '1899.20',
        entryZoneHigh: '1901.16',
        confidence: 0.7,
        opportunityScore: 80,
        signalCandleTimestamp: new Date().toISOString(),
        validUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        marketStatus: 'OPEN',
        dataStatus: 'LIVE',
      };
      // Price back outside the zone would normally compute WAITING again.
      expect(refreshPlanStatus('TRIGGERED', waitingInput)).toBe('TRIGGERED');
      // But a fresh (never-triggered) plan correctly reports WAITING.
      expect(refreshPlanStatus('WAITING', waitingInput)).toBe('WAITING');
    });
  });

  // ---------------------------------------------------------------------
  // PULLBACK
  // ---------------------------------------------------------------------
  describe('PULLBACK entry', () => {
    it('stays WAITING while executable price is above the entry zone', async () => {
      const plan = await insertPlan(pool, { entry_strategy: 'PULLBACK', status: 'WAITING' });
      mockHappyPath({ tick: { bid: 1902, ask: 1902.4 } }); // above zone high 1901.16
      await runEntryPlanWatcherTick(pool, ACTOR, true);
      expect(await planStatus(pool, plan.id)).toBe('WAITING');
      expect(mt5Client.sendMt5Order).not.toHaveBeenCalled();
    });

    it('moves to TRIGGERED once executable price enters the zone, then executes exactly once with valid risk', async () => {
      const plan = await insertPlan(pool, { entry_strategy: 'PULLBACK', status: 'WAITING' });
      mockHappyPath({ tick: { bid: 1899.8, ask: 1900.0 } }); // inside 1899.20-1901.16
      const { outcomes } = await runEntryPlanWatcherTick(pool, ACTOR, true);
      expect(await planStatus(pool, plan.id)).toBe('EXECUTED');
      expect(outcomes.filter((o) => o.executed)).toHaveLength(1);
      expect(mt5Client.sendMt5Order).toHaveBeenCalledTimes(1);
      const trades = await pool.query('SELECT * FROM trade_outcomes WHERE entry_plan_id=$1', [plan.id]);
      expect(trades.rows).toHaveLength(1);
      expect(Number(trades.rows[0].actual_entry)).toBeCloseTo(1900.0, 5);
    });

    it('blocks on invalid risk (kill switch on) and never sends an order', async () => {
      const plan = await insertPlan(pool, { entry_strategy: 'PULLBACK', status: 'WAITING' });
      mockHappyPath({ tick: { bid: 1899.8, ask: 1900.0 } });
      process.env.MT5_KILL_SWITCH_ENABLED = 'true';
      await runEntryPlanWatcherTick(pool, ACTOR, true);
      expect(await planStatus(pool, plan.id)).toBe('BLOCKED');
      expect(mt5Client.sendMt5Order).not.toHaveBeenCalled();
    });

    it('expires a plan whose price never reached the zone before valid_until', async () => {
      const plan = await insertPlan(pool, {
        entry_strategy: 'PULLBACK',
        status: 'WAITING',
        valid_until: new Date(Date.now() - 60_000).toISOString(),
      });
      mockHappyPath({ tick: { bid: 1902, ask: 1902.4 } });
      await runEntryPlanWatcherTick(pool, ACTOR, true);
      expect(await planStatus(pool, plan.id)).toBe('EXPIRED');
      expect(mt5Client.sendMt5Order).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------
  // BREAKOUT
  // ---------------------------------------------------------------------
  describe('BREAKOUT entry', () => {
    it('stays WAITING below the trigger and executes exactly once after crossing it', async () => {
      const plan = await insertPlan(pool, {
        entry_strategy: 'BREAKOUT',
        status: 'WAITING',
        entry_zone_low: null,
        entry_zone_high: null,
        trigger_price: '1905.00',
      });
      mockHappyPath({ tick: { bid: 1903, ask: 1903.2 } });
      await runEntryPlanWatcherTick(pool, ACTOR, true);
      expect(await planStatus(pool, plan.id)).toBe('WAITING');

      mockHappyPath({ tick: { bid: 1905.5, ask: 1905.7 } });
      await runEntryPlanWatcherTick(pool, ACTOR, true);
      expect(await planStatus(pool, plan.id)).toBe('EXECUTED');
      expect(mt5Client.sendMt5Order).toHaveBeenCalledTimes(1);
    });

    it('does not re-trigger or re-order when price oscillates back below the trigger before AUTO-DEMO executes it', async () => {
      const plan = await insertPlan(pool, {
        entry_strategy: 'BREAKOUT',
        status: 'WAITING',
        entry_zone_low: null,
        entry_zone_high: null,
        trigger_price: '1905.00',
      });
      // AUTO-DEMO off: crosses trigger -> TRIGGERED but not executed.
      mockHappyPath({ tick: { bid: 1905.5, ask: 1905.7 } });
      await runEntryPlanWatcherTick(pool, ACTOR, false);
      expect(await planStatus(pool, plan.id)).toBe('TRIGGERED');

      // Price falls back below the trigger — must stay TRIGGERED, not WAITING.
      mockHappyPath({ tick: { bid: 1903, ask: 1903.2 } });
      await runEntryPlanWatcherTick(pool, ACTOR, false);
      expect(await planStatus(pool, plan.id)).toBe('TRIGGERED');

      // Now AUTO-DEMO turns on: exactly one order is sent, regardless of the oscillation.
      mockHappyPath({ tick: { bid: 1903, ask: 1903.2 } });
      await runEntryPlanWatcherTick(pool, ACTOR, true);
      expect(await planStatus(pool, plan.id)).toBe('EXECUTED');
      expect(mt5Client.sendMt5Order).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------
  // MARKET_NOW
  // ---------------------------------------------------------------------
  describe('MARKET_NOW entry', () => {
    it('executes a valid READY plan', async () => {
      const plan = await insertPlan(pool, {
        entry_strategy: 'MARKET_NOW',
        status: 'READY',
        entry_zone_low: null,
        entry_zone_high: null,
        trigger_price: null,
      });
      mockHappyPath();
      await runEntryPlanWatcherTick(pool, ACTOR, true);
      expect(await planStatus(pool, plan.id)).toBe('EXECUTED');
      expect(mt5Client.sendMt5Order).toHaveBeenCalledTimes(1);
    });

    it('blocks a READY plan when risk is invalid (missing take profit)', async () => {
      const plan = await insertPlan(pool, {
        entry_strategy: 'MARKET_NOW',
        status: 'READY',
        entry_zone_low: null,
        entry_zone_high: null,
        trigger_price: null,
        take_profit: null,
      });
      mockHappyPath();
      await runEntryPlanWatcherTick(pool, ACTOR, true);
      expect(await planStatus(pool, plan.id)).toBe('BLOCKED');
      expect(mt5Client.sendMt5Order).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------
  // Safety
  // ---------------------------------------------------------------------
  describe('safety', () => {
    it('blocks when MT5 is not DEMO-verified (covers real-account/wrong-login/wrong-server cases)', async () => {
      const plan = await insertPlan(pool, { entry_strategy: 'MARKET_NOW', status: 'READY' });
      mockHappyPath();
      vi.mocked(mt5Client.getMt5Status).mockResolvedValue({ connected: true, demo_verified: false, blocked_reason: 'MT5 login does not match configured demo account' } as never);
      await runEntryPlanWatcherTick(pool, ACTOR, true);
      expect(await planStatus(pool, plan.id)).toBe('BLOCKED');
      expect(mt5Client.sendMt5Order).not.toHaveBeenCalled();
    });

    it('AUTO-DEMO false never executes, even when TRIGGERED', async () => {
      const plan = await insertPlan(pool, { entry_strategy: 'MARKET_NOW', status: 'READY' });
      mockHappyPath();
      await runEntryPlanWatcherTick(pool, ACTOR, false);
      expect(await planStatus(pool, plan.id)).toBe('READY');
      expect(mt5Client.sendMt5Order).not.toHaveBeenCalled();
    });

    it('blocks on a stale quote', async () => {
      const plan = await insertPlan(pool, { entry_strategy: 'MARKET_NOW', status: 'READY' });
      mockHappyPath({ market: { data_status: 'STALE' } });
      await runEntryPlanWatcherTick(pool, ACTOR, true);
      expect(await planStatus(pool, plan.id)).toBe('BLOCKED');
      expect(mt5Client.sendMt5Order).not.toHaveBeenCalled();
    });

    it('blocks on a closed market', async () => {
      const plan = await insertPlan(pool, { entry_strategy: 'MARKET_NOW', status: 'READY' });
      mockHappyPath({ market: { market_status: 'CLOSED' } });
      await runEntryPlanWatcherTick(pool, ACTOR, true);
      expect(await planStatus(pool, plan.id)).toBe('BLOCKED');
      expect(mt5Client.sendMt5Order).not.toHaveBeenCalled();
    });

    it('blocks when the spread is too high', async () => {
      process.env.MT5_MAX_SPREAD_POINTS = '5';
      const plan = await insertPlan(pool, { entry_strategy: 'MARKET_NOW', status: 'READY' });
      mockHappyPath({ tick: { bid: 1900, ask: 1902 } }); // 200 points at point=0.01
      await runEntryPlanWatcherTick(pool, ACTOR, true);
      const row = await pool.query('SELECT status, block_reason FROM mt5_entry_plans WHERE id=$1', [plan.id]);
      expect(row.rows[0].status).toBe('BLOCKED');
      expect(row.rows[0].block_reason).toBe('SPREAD_TOO_HIGH');
      expect(mt5Client.sendMt5Order).not.toHaveBeenCalled();
    });

    it('blocks an invalid Stop Loss (on the wrong side of entry for BUY)', async () => {
      const plan = await insertPlan(pool, { entry_strategy: 'MARKET_NOW', status: 'READY', stop_loss: '1950.00' });
      mockHappyPath();
      await runEntryPlanWatcherTick(pool, ACTOR, true);
      const row = await pool.query('SELECT status, block_reason FROM mt5_entry_plans WHERE id=$1', [plan.id]);
      expect(row.rows[0].status).toBe('BLOCKED');
      expect(row.rows[0].block_reason).toBe('INVALID_SL');
      expect(mt5Client.sendMt5Order).not.toHaveBeenCalled();
    });

    it('blocks an invalid Take Profit (on the wrong side of entry for BUY)', async () => {
      const plan = await insertPlan(pool, { entry_strategy: 'MARKET_NOW', status: 'READY', take_profit: '1800.00' });
      mockHappyPath();
      await runEntryPlanWatcherTick(pool, ACTOR, true);
      const row = await pool.query('SELECT status, block_reason FROM mt5_entry_plans WHERE id=$1', [plan.id]);
      expect(row.rows[0].status).toBe('BLOCKED');
      expect(row.rows[0].block_reason).toBe('INVALID_TP');
      expect(mt5Client.sendMt5Order).not.toHaveBeenCalled();
    });

    it('blocks on insufficient margin', async () => {
      const plan = await insertPlan(pool, { entry_strategy: 'MARKET_NOW', status: 'READY' });
      mockHappyPath();
      vi.mocked(mt5Client.getMt5Status).mockResolvedValue({
        ...DEMO_STATUS,
        account: { ...DEMO_STATUS.account, margin_free: '0', free_margin: '0' },
      } as never);
      await runEntryPlanWatcherTick(pool, ACTOR, true);
      const row = await pool.query('SELECT status, block_reason FROM mt5_entry_plans WHERE id=$1', [plan.id]);
      expect(row.rows[0].status).toBe('BLOCKED');
      expect(row.rows[0].block_reason).toBe('MARGIN_INSUFFICIENT');
      expect(mt5Client.sendMt5Order).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------
  // Reliability / duplicate protection
  // ---------------------------------------------------------------------
  describe('duplicate protection and restart recovery', () => {
    it('never double-executes when the same TRIGGERED plan is processed concurrently (worker/API restart race)', async () => {
      const plan = await insertPlan(pool, { entry_strategy: 'BREAKOUT', status: 'TRIGGERED', trigger_price: '1900.00', entry_zone_low: null, entry_zone_high: null });
      mockHappyPath();
      const [first, second] = await Promise.all([
        executeEntryPlanById(pool, plan.id, ACTOR),
        executeEntryPlanById(pool, plan.id, ACTOR),
      ]);
      const executedCount = [first, second].filter((o) => o.executed).length;
      expect(executedCount).toBe(1);
      expect(mt5Client.sendMt5Order).toHaveBeenCalledTimes(1);
      expect(await planStatus(pool, plan.id)).toBe('EXECUTED');
    });

    it('an already-EXECUTED plan can never execute again', async () => {
      const plan = await insertPlan(pool, { entry_strategy: 'BREAKOUT', status: 'EXECUTED', trigger_price: '1900.00', entry_zone_low: null, entry_zone_high: null });
      mockHappyPath();
      const outcome = await executeEntryPlanById(pool, plan.id, ACTOR);
      expect(outcome.executed).toBe(false);
      expect(mt5Client.sendMt5Order).not.toHaveBeenCalled();
    });

    it('an EXPIRED plan can never execute', async () => {
      const plan = await insertPlan(pool, { entry_strategy: 'BREAKOUT', status: 'EXPIRED', trigger_price: '1900.00', entry_zone_low: null, entry_zone_high: null });
      mockHappyPath();
      const outcome = await executeEntryPlanById(pool, plan.id, ACTOR);
      expect(outcome.executed).toBe(false);
      expect(mt5Client.sendMt5Order).not.toHaveBeenCalled();
    });

    it('repeated watcher ticks after execution do not send a second order', async () => {
      const plan = await insertPlan(pool, { entry_strategy: 'MARKET_NOW', status: 'READY' });
      mockHappyPath();
      await runEntryPlanWatcherTick(pool, ACTOR, true);
      expect(await planStatus(pool, plan.id)).toBe('EXECUTED');
      await runEntryPlanWatcherTick(pool, ACTOR, true);
      await runEntryPlanWatcherTick(pool, ACTOR, true);
      expect(mt5Client.sendMt5Order).toHaveBeenCalledTimes(1);
    });

    it('recovers a WAITING plan left behind by a crash/restart without touching it until conditions are met', async () => {
      const plan = await insertPlan(pool, { entry_strategy: 'PULLBACK', status: 'WAITING' });
      mockHappyPath({ tick: { bid: 1902, ask: 1902.4 } });
      // Simulates the watcher's first tick after an API/worker restart.
      await runEntryPlanWatcherTick(pool, ACTOR, true);
      expect(await planStatus(pool, plan.id)).toBe('WAITING');
      expect(mt5Client.sendMt5Order).not.toHaveBeenCalled();
    });

    it('reconciles a plan stuck EXECUTING past the grace period by releasing it back to TRIGGERED when no order was ever placed', async () => {
      const plan = await insertPlan(pool, {
        entry_strategy: 'BREAKOUT',
        status: 'EXECUTING',
        trigger_price: '1900.00',
        entry_zone_low: null,
        entry_zone_high: null,
        executing_at: new Date(Date.now() - 5 * 60_000).toISOString(),
        execution_key: 'entry-plan:stuck:1',
      });
      vi.mocked(mt5Client.listMt5Positions).mockResolvedValue([]);
      await reconcileStuckExecutions(pool, ACTOR, 0);
      expect(await planStatus(pool, plan.id)).toBe('TRIGGERED');
    });

    it('reconciles a plan stuck EXECUTING by healing to EXECUTED when a matching live MT5 position is found (order_send timeout that actually succeeded)', async () => {
      const plan = await insertPlan(pool, {
        entry_strategy: 'BREAKOUT',
        status: 'EXECUTING',
        trigger_price: '1900.00',
        entry_zone_low: null,
        entry_zone_high: null,
        executing_at: new Date(Date.now() - 5 * 60_000).toISOString(),
        execution_key: 'entry-plan:stuck:2',
      });
      vi.mocked(mt5Client.listMt5Positions).mockResolvedValue([
        { ticket: 999888, symbol: 'ETHUSD', volume: 0.12, price_open: 1900.1, comment: `MT5_PLAN_${plan.id}` },
      ] as never);
      await reconcileStuckExecutions(pool, ACTOR, 0);
      expect(await planStatus(pool, plan.id)).toBe('EXECUTED');
      const trades = await pool.query('SELECT * FROM trade_outcomes WHERE entry_plan_id=$1', [plan.id]);
      expect(trades.rows).toHaveLength(1);
      expect(Number(trades.rows[0].actual_entry)).toBeCloseTo(1900.1, 5);
    });

    it('does not touch an EXECUTING plan still within the reconciliation grace period', async () => {
      const plan = await insertPlan(pool, {
        entry_strategy: 'BREAKOUT',
        status: 'EXECUTING',
        trigger_price: '1900.00',
        entry_zone_low: null,
        entry_zone_high: null,
        executing_at: new Date().toISOString(),
        execution_key: 'entry-plan:fresh:1',
      });
      await reconcileStuckExecutions(pool, ACTOR, 120);
      expect(await planStatus(pool, plan.id)).toBe('EXECUTING');
    });
  });
});
