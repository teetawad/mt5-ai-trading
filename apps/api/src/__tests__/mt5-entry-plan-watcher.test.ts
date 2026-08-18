import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { getTestPool, setupTestDb } from './db/setup';

const SKIP = !process.env.TEST_DATABASE_URL;

vi.mock('../services/mt5-client', () => ({
  getMt5Status: vi.fn(),
  getMt5Tick: vi.fn(),
  getMt5MarketStatus: vi.fn(),
  getMt5SymbolInfo: vi.fn(),
  getMt5HistoryDeals: vi.fn(),
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
  reconcileOpenTradeOutcomes,
  reconcileStuckExecutions,
  refreshPlanStatus,
  runEntryPlanWatcherTick,
  sendMt5DemoTestOrder,
  Mt5Actor,
} from '../services/mt5-entry-plan-watcher';
import { executeAssistedDemo, executeAutoDemo } from '../services/mt5-demo-lab-service';

const ACTOR: Mt5Actor = { actorId: null, actorEmail: 'test@internal', requestId: 'test' };

const DEMO_STATUS = {
  connected: true,
  demo_verified: true,
  account: { login: 60124487, server: 'TradeMaxGlobal-Demo', equity: '10000', balance: '10000', margin_free: '9000', free_margin: '9000', leverage: 1000 },
  terminal: { trade_allowed: true },
};

const OPEN_LIVE_MARKET = { market_status: 'OPEN', data_status: 'LIVE', quote_age_seconds: 1 };

// contract_size=1 with tick_value == tick_size makes the broker-aware loss
// calculation (riskDistance / tickSize * tickValue) numerically equal to a
// plain price-difference-per-lot for these fixtures — i.e. exactly the
// "provably correct for this symbol" case, not a coincidence being papered
// over. volume_max is intentionally realistic (not 100) so a mis-sized
// request is still bounded by something plausible for a crypto CFD.
const SYMBOL_INFO = {
  point: 0.01, trade_tick_size: 0.01, trade_stops_level: 0, trade_freeze_level: 0,
  volume_min: 0.01, volume_max: 50, volume_step: 0.01,
  trade_contract_size: 1, trade_tick_value: 0.01, trade_tick_value_profit: 0.01, trade_tick_value_loss: 0.01,
};

function mockHappyPath(overrides: { tick?: Record<string, unknown>; market?: Record<string, unknown> } = {}) {
  vi.mocked(mt5Client.getMt5Status).mockResolvedValue(DEMO_STATUS as never);
  vi.mocked(mt5Client.getMt5Tick).mockResolvedValue({ bid: 1900, ask: 1900.2, ...overrides.tick } as never);
  vi.mocked(mt5Client.getMt5MarketStatus).mockResolvedValue({ ...OPEN_LIVE_MARKET, ...overrides.market } as never);
  vi.mocked(mt5Client.getMt5SymbolInfo).mockResolvedValue(SYMBOL_INFO as never);
  vi.mocked(mt5Client.listMt5Positions).mockResolvedValue([]);
  vi.mocked(mt5Client.listMt5PendingOrders).mockResolvedValue([]);
  vi.mocked(mt5Client.checkMt5Order).mockResolvedValue({ retcode: 10009 } as never);
  vi.mocked(mt5Client.sendMt5Order).mockResolvedValue({
    retcode: 10009,
    order: 555111,
    deal: 555222,
    confirmed_position: { ticket: 555111, price_open: 1900.0, volume: 0.12 },
  } as never);
  vi.mocked(mt5Client.getMt5HistoryDeals).mockResolvedValue([]);
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
      // MT5 comments are truncated to a short plan reference (see
      // planCommentRef in mt5-entry-plan-watcher.ts) — this broker rejects
      // any comment over ~28 chars, so reconciliation can only match on that
      // short reference, never the full UUID.
      const shortRef = String(plan.id).replaceAll('-', '').slice(0, 16);
      vi.mocked(mt5Client.listMt5Positions).mockResolvedValue([
        { ticket: 999888, symbol: 'ETHUSD', volume: 0.12, price_open: 1900.1, comment: `P${shortRef}` },
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

    it('order_send returning a rejected retcode never marks the plan OPEN/EXECUTED and never inserts trade_outcomes', async () => {
      const plan = await insertPlan(pool, { entry_strategy: 'MARKET_NOW', status: 'READY' });
      mockHappyPath();
      vi.mocked(mt5Client.sendMt5Order).mockResolvedValue({ retcode: 10006, comment: 'rejected' } as never);
      await runEntryPlanWatcherTick(pool, ACTOR, true);
      expect(await planStatus(pool, plan.id)).toBe('BLOCKED');
      const trades = await pool.query('SELECT * FROM trade_outcomes WHERE entry_plan_id=$1', [plan.id]);
      expect(trades.rows).toHaveLength(0);
    });

    it('order_send success with no order/deal ticket (the historical false-OPEN bug shape) is rejected, never treated as OPEN', async () => {
      // 0 is an accepted retcode (this broker reports it for genuine
      // successes — see mt5/adapter.py), so retcode alone cannot be the
      // safety net. A result with no ticket at all is the exact shape of
      // the original bug and must still be blocked regardless of retcode.
      const plan = await insertPlan(pool, { entry_strategy: 'MARKET_NOW', status: 'READY' });
      mockHappyPath();
      vi.mocked(mt5Client.sendMt5Order).mockResolvedValue({ retcode: 0 } as never);
      await runEntryPlanWatcherTick(pool, ACTOR, true);
      expect(await planStatus(pool, plan.id)).toBe('BLOCKED');
      const trades = await pool.query('SELECT * FROM trade_outcomes WHERE entry_plan_id=$1', [plan.id]);
      expect(trades.rows).toHaveLength(0);
    });

    it('order_send with retcode 0, a real ticket, and a confirmed position marks the plan EXECUTED', async () => {
      const plan = await insertPlan(pool, { entry_strategy: 'MARKET_NOW', status: 'READY' });
      mockHappyPath();
      vi.mocked(mt5Client.sendMt5Order).mockResolvedValue({
        retcode: 0,
        order: 888111,
        deal: 888222,
        confirmed_position: { ticket: 888111, price_open: 1902.5, volume: 0.12 },
      } as never);
      await runEntryPlanWatcherTick(pool, ACTOR, true);
      expect(await planStatus(pool, plan.id)).toBe('EXECUTED');
      const trades = await pool.query('SELECT * FROM trade_outcomes WHERE entry_plan_id=$1', [plan.id]);
      expect(trades.rows).toHaveLength(1);
      expect(trades.rows[0].order_ticket).toBe('888111');
    });

    it('order_send throwing (Gateway could not confirm a real position) leaves the plan EXECUTING, never falsely OPEN', async () => {
      const plan = await insertPlan(pool, { entry_strategy: 'MARKET_NOW', status: 'READY' });
      mockHappyPath();
      vi.mocked(mt5Client.sendMt5Order).mockRejectedValue(new Error('MT5 order_send succeeded but no matching position was found'));
      await runEntryPlanWatcherTick(pool, ACTOR, true);
      expect(await planStatus(pool, plan.id)).toBe('EXECUTING');
      const trades = await pool.query('SELECT * FROM trade_outcomes WHERE entry_plan_id=$1', [plan.id]);
      expect(trades.rows).toHaveLength(0);
      expect(mt5Client.sendMt5Order).toHaveBeenCalledTimes(1);
    });

    it('a successful retcode with a confirmed MT5 position marks the plan EXECUTED using the confirmed position fields', async () => {
      const plan = await insertPlan(pool, { entry_strategy: 'MARKET_NOW', status: 'READY' });
      mockHappyPath();
      vi.mocked(mt5Client.sendMt5Order).mockResolvedValue({
        retcode: 10009,
        order: 777888,
        deal: 777999,
        confirmed_position: { ticket: 777888, price_open: 1901.23, volume: 0.12 },
      } as never);
      await runEntryPlanWatcherTick(pool, ACTOR, true);
      expect(await planStatus(pool, plan.id)).toBe('EXECUTED');
      const trades = await pool.query('SELECT * FROM trade_outcomes WHERE entry_plan_id=$1', [plan.id]);
      expect(trades.rows).toHaveLength(1);
      expect(trades.rows[0].order_ticket).toBe('777888');
      expect(Number(trades.rows[0].actual_entry)).toBeCloseTo(1901.23, 5);
    });
  });

  // ---------------------------------------------------------------------
  // Ongoing reconciliation of trade_outcomes against MT5 reality
  // ---------------------------------------------------------------------
  describe('reconcileOpenTradeOutcomes', () => {
    async function insertOpenTradeOutcome(pool: Pool, overrides: Record<string, unknown> = {}) {
      const base = {
        symbol: 'ETHUSD',
        order_ticket: '555111',
        side: 'BUY',
        volume: '0.12',
        expected_entry: '1900.00',
        actual_entry: '1900.00',
        stop_loss: '1890.00',
        take_profit: '1925.00',
        opened_at: new Date().toISOString(),
        ...overrides,
      };
      const result = await pool.query(
        `INSERT INTO trade_outcomes(symbol, order_ticket, side, volume, expected_entry, actual_entry, stop_loss, take_profit, opened_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [base.symbol, base.order_ticket, base.side, base.volume, base.expected_entry, base.actual_entry, base.stop_loss, base.take_profit, base.opened_at],
      );
      return result.rows[0];
    }

    it('marks a non-numeric order_ticket (never a real MT5 ticket) as RECONCILIATION_FAILED — reproduces and proves the fix for the false ETHUSD OPEN bug', async () => {
      const trade = await insertOpenTradeOutcome(pool, { order_ticket: 'entry-plan:210e1c04-2cc9-4447-93fe-90adc76f6972:1786943920474' });
      vi.mocked(mt5Client.listMt5Positions).mockResolvedValue([]);
      await reconcileOpenTradeOutcomes(pool, ACTOR);
      const row = await pool.query('SELECT closed_at, exit_reason FROM trade_outcomes WHERE id=$1', [trade.id]);
      expect(row.rows[0].closed_at).not.toBeNull();
      expect(row.rows[0].exit_reason).toBe('RECONCILIATION_FAILED');
    });

    it('leaves a trade open when its numeric ticket is still a live MT5 position', async () => {
      const trade = await insertOpenTradeOutcome(pool);
      vi.mocked(mt5Client.listMt5Positions).mockResolvedValue([{ ticket: 555111, symbol: 'ETHUSD' }] as never);
      await reconcileOpenTradeOutcomes(pool, ACTOR);
      const row = await pool.query('SELECT closed_at FROM trade_outcomes WHERE id=$1', [trade.id]);
      expect(row.rows[0].closed_at).toBeNull();
    });

    it('closes a trade with the real exit reason and realized P&L from MT5 deal history when the position is no longer live (e.g. closed externally)', async () => {
      const trade = await insertOpenTradeOutcome(pool);
      vi.mocked(mt5Client.listMt5Positions).mockResolvedValue([]);
      vi.mocked(mt5Client.getMt5HistoryDeals).mockResolvedValue([
        { position_id: '555111', entry: 1, reason: 4, profit: 12.5, commission: -0.2, swap: -0.1, time: Math.floor(Date.now() / 1000) },
      ] as never);
      await reconcileOpenTradeOutcomes(pool, ACTOR);
      const row = await pool.query('SELECT closed_at, exit_reason, realized_pnl, fees FROM trade_outcomes WHERE id=$1', [trade.id]);
      expect(row.rows[0].closed_at).not.toBeNull();
      expect(row.rows[0].exit_reason).toBe('STOP_LOSS');
      expect(Number(row.rows[0].realized_pnl)).toBeCloseTo(12.5, 5);
      expect(Number(row.rows[0].fees)).toBeCloseTo(0.3, 5);
    });

    it('marks RECONCILIATION_FAILED when the position is no longer live and no closing deal history can be found', async () => {
      const trade = await insertOpenTradeOutcome(pool);
      vi.mocked(mt5Client.listMt5Positions).mockResolvedValue([]);
      vi.mocked(mt5Client.getMt5HistoryDeals).mockResolvedValue([]);
      await reconcileOpenTradeOutcomes(pool, ACTOR);
      const row = await pool.query('SELECT closed_at, exit_reason FROM trade_outcomes WHERE id=$1', [trade.id]);
      expect(row.rows[0].closed_at).not.toBeNull();
      expect(row.rows[0].exit_reason).toBe('RECONCILIATION_FAILED');
    });

    it('never guesses when MT5 is unreachable — leaves open rows untouched for the next tick', async () => {
      const trade = await insertOpenTradeOutcome(pool);
      vi.mocked(mt5Client.listMt5Positions).mockRejectedValue(new Error('MT5 unreachable'));
      await reconcileOpenTradeOutcomes(pool, ACTOR);
      const row = await pool.query('SELECT closed_at FROM trade_outcomes WHERE id=$1', [trade.id]);
      expect(row.rows[0].closed_at).toBeNull();
    });
  });

  // ---------------------------------------------------------------------
  // Manual DEMO test order (developer/diagnostic path)
  // ---------------------------------------------------------------------
  describe('sendMt5DemoTestOrder', () => {
    it('executes through the same checkMt5Order/sendMt5Order path and records a real ticket', async () => {
      mockHappyPath();
      const result = await sendMt5DemoTestOrder(pool, 'ETHUSD', 'BUY', ACTOR);
      expect(result.executed).toBe(true);
      expect(result.orderTicket).toBe('555111');
      expect(mt5Client.checkMt5Order).toHaveBeenCalledTimes(1);
      expect(mt5Client.sendMt5Order).toHaveBeenCalledTimes(1);
      const trades = await pool.query('SELECT * FROM trade_outcomes WHERE order_ticket=$1', ['555111']);
      expect(trades.rows).toHaveLength(1);
      expect(trades.rows[0].entry_plan_id).toBeNull();
    });

    it('refuses to send when the kill switch is ON', async () => {
      mockHappyPath();
      process.env.MT5_KILL_SWITCH_ENABLED = 'true';
      await expect(sendMt5DemoTestOrder(pool, 'ETHUSD', 'BUY', ACTOR)).rejects.toThrow(/kill switch/i);
      expect(mt5Client.sendMt5Order).not.toHaveBeenCalled();
    });

    it('refuses to send when a position already exists for the symbol', async () => {
      mockHappyPath();
      vi.mocked(mt5Client.listMt5Positions).mockResolvedValue([{ ticket: 1, symbol: 'ETHUSD' }] as never);
      await expect(sendMt5DemoTestOrder(pool, 'ETHUSD', 'BUY', ACTOR)).rejects.toThrow(/already exists/i);
      expect(mt5Client.sendMt5Order).not.toHaveBeenCalled();
    });

    it('refuses to send when MT5 is not DEMO-verified', async () => {
      mockHappyPath();
      vi.mocked(mt5Client.getMt5Status).mockResolvedValue({ connected: true, demo_verified: false, blocked_reason: 'wrong login' } as never);
      await expect(sendMt5DemoTestOrder(pool, 'ETHUSD', 'BUY', ACTOR)).rejects.toThrow(/wrong login/i);
      expect(mt5Client.sendMt5Order).not.toHaveBeenCalled();
    });

    it('propagates a rejected order_send retcode as a clear error and records nothing', async () => {
      mockHappyPath();
      vi.mocked(mt5Client.sendMt5Order).mockResolvedValue({ retcode: 10019 } as never);
      await expect(sendMt5DemoTestOrder(pool, 'ETHUSD', 'BUY', ACTOR)).rejects.toThrow(/retcode 10019/);
      const trades = await pool.query("SELECT * FROM trade_outcomes WHERE symbol='ETHUSD'");
      expect(trades.rows).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------
  // Bug 1: ASSISTED_DEMO (owner "Trade in Demo") vs AUTO_DEMO (background)
  // ---------------------------------------------------------------------
  describe('assisted vs auto-demo execution', () => {
    function mockAssistedAnalysis(symbol: string, overrides: Record<string, unknown> = {}) {
      vi.mocked(mt5Client.analyzeMt5Symbol).mockResolvedValue({
        symbol,
        bid: '1900',
        ask: '1900.2',
        spread: '20',
        quote_timestamp: new Date().toISOString(),
        market_status: 'OPEN',
        data_status: 'LIVE',
        session_open: new Date().toISOString(),
        session_close: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        next_session_open: new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString(),
        server_time: new Date().toISOString(),
        local_time: new Date().toISOString(),
        quote_age_seconds: 1,
        source: 'MT5_BROKER_SESSION',
        market: {},
        decision: 'BUY',
        confidence: 0.7,
        opportunity_score: 80,
        reasons: ['H1 trend is rising'],
        reference_entry: '1900.00',
        current_price: '1900.2',
        entry_strategy: 'MARKET_NOW',
        entry_zone_low: null,
        entry_zone_high: null,
        trigger_price: null,
        entry_reason: 'Test entry reason',
        stop_loss: '1890.66',
        take_profit: '1925.89',
        risk_reward: '2.5',
        expected_holding_hours: 4,
        signal_candle_timestamp: new Date().toISOString(),
        model_version: 'TEST_MODEL_V1',
        features: { trend: 'up' },
        ...overrides,
      } as never);
    }

    it('ASSISTED_DEMO executes even when AUTO-DEMO is OFF — a manual, owner-approved trade is not gated by the automatic-execution switch', async () => {
      process.env.MT5_AUTO_DEMO_ENABLED = 'false';
      mockHappyPath();
      mockAssistedAnalysis('ETHUSD');
      const outcome = await executeAssistedDemo(pool, 'ETHUSD', ACTOR);
      expect(outcome.executed).toBe(true);
      expect(outcome.allowed).toBe(true);
      expect(outcome.code).toBeNull();
      expect(mt5Client.sendMt5Order).toHaveBeenCalledTimes(1);
    });

    it('AUTO_DEMO refuses to execute in the background when AUTO-DEMO is OFF, with a specific code and no live MT5 calls', async () => {
      process.env.MT5_AUTO_DEMO_ENABLED = 'false';
      const outcome = await executeAutoDemo(pool, 'ETHUSD', ACTOR);
      expect(outcome.executed).toBe(false);
      expect(outcome.allowed).toBe(false);
      expect(outcome.code).toBe('AUTO_DEMO_DISABLED');
      expect(mt5Client.getMt5Status).not.toHaveBeenCalled();
      expect(mt5Client.analyzeMt5Symbol).not.toHaveBeenCalled();
      expect(mt5Client.sendMt5Order).not.toHaveBeenCalled();
    });

    it('AUTO_DEMO executes when AUTO-DEMO is ON', async () => {
      process.env.MT5_AUTO_DEMO_ENABLED = 'true';
      mockHappyPath();
      mockAssistedAnalysis('ETHUSD');
      const outcome = await executeAutoDemo(pool, 'ETHUSD', ACTOR);
      expect(outcome.executed).toBe(true);
      expect(mt5Client.sendMt5Order).toHaveBeenCalledTimes(1);
    });

    it('analysis-time RISK PASS but execution-time spread now too high is blocked with the exact rule (SPREAD_TOO_HIGH), never a generic rejection', async () => {
      process.env.MT5_AUTO_DEMO_ENABLED = 'false';
      process.env.MT5_MAX_SPREAD_POINTS = '5';
      mockHappyPath({ tick: { bid: 1900, ask: 1905 } }); // 500-point spread at execution time
      mockAssistedAnalysis('ETHUSD', { spread: '1' }); // analysis-time view looked fine
      const outcome = await executeAssistedDemo(pool, 'ETHUSD', ACTOR);
      expect(outcome.executed).toBe(false);
      expect(outcome.allowed).toBe(false);
      expect(outcome.code).toBe('SPREAD_TOO_HIGH');
      expect(outcome.reason).toBeTruthy();
      expect(mt5Client.sendMt5Order).not.toHaveBeenCalled();
    });

    it('blocks with DEMO_VERIFICATION_FAILED and the exact reason reaching the caller when MT5 is not demo-verified, without running analysis', async () => {
      vi.mocked(mt5Client.getMt5Status).mockResolvedValue({ connected: true, demo_verified: false, blocked_reason: 'MT5 login does not match configured demo account' } as never);
      const outcome = await executeAssistedDemo(pool, 'ETHUSD', ACTOR);
      expect(outcome.executed).toBe(false);
      expect(outcome.code).toBe('DEMO_VERIFICATION_FAILED');
      expect(outcome.reason).toMatch(/login/i);
      expect(mt5Client.analyzeMt5Symbol).not.toHaveBeenCalled();
    });

    it('a successful assisted order is only ever marked EXECUTED with a real MT5 ticket and a confirmed position', async () => {
      process.env.MT5_AUTO_DEMO_ENABLED = 'false';
      mockHappyPath();
      mockAssistedAnalysis('ETHUSD');
      const outcome = await executeAssistedDemo(pool, 'ETHUSD', ACTOR);
      expect(outcome.executed).toBe(true);
      expect((outcome.entryPlan as Record<string, unknown> | null)?.order_ticket).toBeTruthy();
      const trades = await pool.query("SELECT * FROM trade_outcomes WHERE symbol='ETHUSD'");
      expect(trades.rows).toHaveLength(1);
      expect(trades.rows[0].order_ticket).toBeTruthy();
    });

    // Regression test for the actual root cause found by testing against the
    // live connected MT5 DEMO terminal: this broker's terminal hard-rejects
    // any order comment over ~28 characters (order_check/order_send return
    // None, last_error() (-2, 'Invalid "comment" argument')).
    // `MT5_PLAN_<uuid>` (45 chars) exceeded this on every single execution
    // attempt — the actual reason "Trade in Demo" always failed. The fix
    // (planCommentRef) must keep every order comment well under that limit.
    it('every order comment sent to MT5 stays short enough for the broker to accept (regression: MT5_PLAN_<uuid> was 45 chars and always rejected)', async () => {
      process.env.MT5_AUTO_DEMO_ENABLED = 'false';
      mockHappyPath();
      mockAssistedAnalysis('ETHUSD');
      await executeAssistedDemo(pool, 'ETHUSD', ACTOR);
      expect(mt5Client.checkMt5Order).toHaveBeenCalledTimes(1);
      const [request] = vi.mocked(mt5Client.checkMt5Order).mock.calls[0];
      expect(typeof request.comment).toBe('string');
      expect((request.comment as string).length).toBeLessThanOrEqual(28);
      expect(mt5Client.sendMt5Order).toHaveBeenCalledTimes(1);
      const [sendRequest] = vi.mocked(mt5Client.sendMt5Order).mock.calls[0];
      expect((sendRequest.comment as string).length).toBeLessThanOrEqual(28);
    });

    it('an order_check exception is reported as ORDER_CHECK_FAILED with the real MT5 error, never mislabeled as a demo-verification problem', async () => {
      process.env.MT5_AUTO_DEMO_ENABLED = 'false';
      mockHappyPath();
      mockAssistedAnalysis('ETHUSD');
      vi.mocked(mt5Client.checkMt5Order).mockRejectedValue(new Error('MT5 order_check returned no result (terminal error: (-2, \'Invalid "comment" argument\'))'));
      const outcome = await executeAssistedDemo(pool, 'ETHUSD', ACTOR);
      expect(outcome.executed).toBe(false);
      expect(outcome.code).toBe('ORDER_CHECK_FAILED');
      expect(outcome.reason).toMatch(/comment/i);
      expect(mt5Client.sendMt5Order).not.toHaveBeenCalled();
    });

    it('an order_check retcode of 10030 (unsupported filling mode) is reported as INVALID_FILLING_MODE, not a generic rejection', async () => {
      process.env.MT5_AUTO_DEMO_ENABLED = 'false';
      mockHappyPath();
      mockAssistedAnalysis('ETHUSD');
      vi.mocked(mt5Client.checkMt5Order).mockResolvedValue({ retcode: 10030, comment: 'Unsupported filling mode' } as never);
      const outcome = await executeAssistedDemo(pool, 'ETHUSD', ACTOR);
      expect(outcome.executed).toBe(false);
      expect(outcome.code).toBe('INVALID_FILLING_MODE');
      expect(mt5Client.sendMt5Order).not.toHaveBeenCalled();
    });

    it('an order_send exception (MT5 could not confirm the order) is reported as EXECUTION_UNCONFIRMED and never marks the plan OPEN', async () => {
      process.env.MT5_AUTO_DEMO_ENABLED = 'false';
      mockHappyPath();
      mockAssistedAnalysis('ETHUSD');
      vi.mocked(mt5Client.sendMt5Order).mockRejectedValue(new Error('order_send reported success but positions_get() could not confirm a real position'));
      const outcome = await executeAssistedDemo(pool, 'ETHUSD', ACTOR);
      expect(outcome.executed).toBe(false);
      expect(outcome.code).toBe('EXECUTION_UNCONFIRMED');
      const trades = await pool.query("SELECT * FROM trade_outcomes WHERE symbol='ETHUSD'");
      expect(trades.rows).toHaveLength(0);
    });

    // Reproduces and proves the fix for the reported bug: a plan that was
    // blocked once (any reason — cooldown, spread, etc.) held a stale
    // execution_key forever, so even after conditions genuinely cleared and
    // AI re-analysis correctly brought its status back to READY, a second
    // "Trade in Demo" click still failed to claim it and returned
    // ALREADY_PROCESSING — with the UI showing a plan that looked perfectly
    // tradeable. persistEntryPlan() must clear the stale lock together with
    // the status the moment the plan becomes re-eligible.
    it('a plan blocked once (e.g. by spread) and then genuinely re-eligible executes successfully on the next "Trade in Demo" click — the stale lock does not persist forever', async () => {
      process.env.MT5_AUTO_DEMO_ENABLED = 'false';
      process.env.MT5_MAX_SPREAD_POINTS = '5';
      mockHappyPath({ tick: { bid: 1900, ask: 1902 } }); // 200-point spread: blocks
      mockAssistedAnalysis('ETHUSD');
      const blocked = await executeAssistedDemo(pool, 'ETHUSD', ACTOR);
      expect(blocked.executed).toBe(false);
      expect(blocked.code).toBe('SPREAD_TOO_HIGH');
      const blockedRow = await pool.query("SELECT status, execution_key FROM mt5_entry_plans WHERE symbol='ETHUSD'");
      expect(blockedRow.rows[0].status).toBe('BLOCKED');
      expect(blockedRow.rows[0].execution_key).not.toBeNull(); // the stale lock, set by the blocked claim attempt

      // Conditions clear (spread narrows back to normal) and the owner
      // clicks "Trade in Demo" again — this must re-analyze, correctly
      // clear the stale lock, and actually execute this time.
      process.env.MT5_MAX_SPREAD_POINTS = '500';
      mockHappyPath();
      mockAssistedAnalysis('ETHUSD');
      const retried = await executeAssistedDemo(pool, 'ETHUSD', ACTOR);
      expect(retried.executed).toBe(true);
      expect(retried.code).toBeNull();
      expect(retried.allowed).toBe(true);
      expect(mt5Client.sendMt5Order).toHaveBeenCalledTimes(1);
    });

    it('double-clicking "Trade in Demo" while the first request is still executing never sends a second MT5 order, and reports EXECUTION_IN_PROGRESS, not a generic rejection', async () => {
      const plan = await insertPlan(pool, { symbol: 'ETHUSD', entry_strategy: 'MARKET_NOW', status: 'READY' });
      // Simulate a first request that already claimed this exact plan for
      // execution (status=EXECUTING, execution_key set) and has not
      // resolved yet — this is the real DB state a concurrent duplicate
      // click would race against.
      await pool.query(
        `UPDATE mt5_entry_plans SET status='EXECUTING', executing_at=now(), execution_key=$2 WHERE id=$1`,
        [plan.id, `entry-plan:${plan.id}:in-flight`],
      );
      const outcome = await executeEntryPlanById(pool, plan.id, ACTOR);
      expect(outcome.executed).toBe(false);
      expect(outcome.code).toBe('EXECUTION_IN_PROGRESS');
      expect(mt5Client.sendMt5Order).not.toHaveBeenCalled();
    });
  });
});
