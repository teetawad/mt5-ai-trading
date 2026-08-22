import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { getTestPool, setupTestDb } from './db/setup';

const SKIP = !process.env.TEST_DATABASE_URL;

vi.mock('../services/mt5-client', () => ({
  getMt5Bars: vi.fn(),
}));

import * as mt5Client from '../services/mt5-client';
import { runShadowTradeWatcherTick } from '../services/trading-ai/shadow-trade-watcher';

describe('shadow-trade-watcher — never calls order_send/position/pending-order MT5 endpoints', () => {
  it('only ever imports getMt5Bars from mt5-client', () => {
    const source = readFileSync(path.resolve(__dirname, '../services/trading-ai/shadow-trade-watcher.ts'), 'utf-8');
    const importBlock = source.match(/import\s*{([^}]*)}\s*from\s*'\.\.\/mt5-client'/);
    expect(importBlock).not.toBeNull();
    const imported = importBlock![1].split(',').map((s) => s.trim()).filter(Boolean);
    expect(imported).toEqual(['getMt5Bars']);
  });
});

function bar(secondsAgoFromNow: number, o: number, h: number, l: number, c: number) {
  return { time: Math.floor(Date.now() / 1000) - secondsAgoFromNow, open: o, high: h, low: l, close: c, tick_volume: 100 };
}

describe.skipIf(SKIP)('runShadowTradeWatcherTick', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = getTestPool();
    await setupTestDb(pool);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await pool.query(`DELETE FROM shadow_trades WHERE symbol LIKE 'TESTWATCH%'`);
    await pool.query(`DELETE FROM ai_trade_plans WHERE symbol LIKE 'TESTWATCH%'`);
    await pool.query(`DELETE FROM ai_analysis_runs WHERE symbol LIKE 'TESTWATCH%'`);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function seedShadowTrade(symbol: string, overrides: Record<string, unknown> = {}): Promise<string> {
    const runRow = await pool.query(
      `INSERT INTO ai_analysis_runs(symbol, asset_class, ai_provider, ai_model, ai_prompt_version, market_analysis_package, decision, action, trigger_source)
       VALUES($1,'FOREX','openai','gpt-test','TEST','{}'::jsonb,'BUY','ENTER_NOW','M5_CYCLE') RETURNING id`,
      [symbol],
    );
    const planRow = await pool.query(
      `INSERT INTO ai_trade_plans(analysis_run_id, symbol, asset_class, ai_provider, ai_model, ai_prompt_version, decision, entry_type, pending_order_type,
         entry_price, stop_loss, take_profit, risk_reward, max_planned_loss, target_profit, plan_expiry, risk_result, action, action_reason, status)
       VALUES($1,$2,'FOREX','openai','gpt-test','TEST','BUY','MARKET_NOW','NONE',
         1.1,1.09,1.12,2,'10.00000000','20.00000000', now() + interval '1 hour', 'PASS','ENTER_NOW','MARKET_ENTRY_READY','WAITING_FOR_APPROVAL')
       RETURNING id`,
      [runRow.rows[0].id, symbol],
    );

    const fields: Record<string, unknown> = {
      ai_trade_plan_id: planRow.rows[0].id, analysis_run_id: runRow.rows[0].id, symbol, asset_class: 'FOREX',
      m5_candle_timestamp: new Date().toISOString(),
      direction: 'BUY', action: 'ENTER_NOW', order_type: 'MARKET',
      stop_loss: 1.09, take_profit: 1.12, risk_reward: 2,
      plan_expiry: new Date(Date.now() + 30 * 60_000).toISOString(),
      status: 'ENTERED', actual_shadow_entry: 1.1, entered_at: new Date(Date.now() - 20 * 60_000).toISOString(),
      created_at: new Date(Date.now() - 20 * 60_000).toISOString(),
      ...overrides,
    };
    const cols = Object.keys(fields);
    const values = Object.values(fields);
    const placeholders = cols.map((_, i) => `$${i + 1}`);
    const saved = await pool.query(`INSERT INTO shadow_trades(${cols.join(',')}) VALUES(${placeholders.join(',')}) RETURNING id`, values);
    return saved.rows[0].id as string;
  }

  it('triggers a BUY_LIMIT when a candle low touches the trigger level', async () => {
    const id = await seedShadowTrade('TESTWATCHBUYLIMIT', {
      status: 'AWAITING_TRIGGER', order_type: 'BUY_LIMIT', trigger_price: 1.095, actual_shadow_entry: null, entered_at: null,
    });
    vi.mocked(mt5Client.getMt5Bars).mockResolvedValue([bar(600, 1.1, 1.101, 1.099, 1.1), bar(300, 1.099, 1.1, 1.094, 1.096)] as never);
    await runShadowTradeWatcherTick(pool);
    const saved = await pool.query('SELECT * FROM shadow_trades WHERE id = $1', [id]);
    expect(saved.rows[0].status).toBe('ENTERED');
    expect(Number(saved.rows[0].actual_shadow_entry)).toBe(1.095);
  });

  it('triggers a SELL_LIMIT when a candle high touches the trigger level', async () => {
    // SL/TP inverted vs a BUY (SL above entry, TP below) — the same tick's
    // ENTERED-phase evaluates this same candle immediately after entry, so
    // both must be genuinely out of reach or this would spuriously close.
    const id = await seedShadowTrade('TESTWATCHSELLLIMIT', {
      status: 'AWAITING_TRIGGER', direction: 'SELL', order_type: 'SELL_LIMIT', trigger_price: 1.105,
      stop_loss: 1.11, take_profit: 1.09, actual_shadow_entry: null, entered_at: null,
    });
    vi.mocked(mt5Client.getMt5Bars).mockResolvedValue([bar(300, 1.1, 1.106, 1.099, 1.104)] as never);
    await runShadowTradeWatcherTick(pool);
    const saved = await pool.query('SELECT * FROM shadow_trades WHERE id = $1', [id]);
    expect(saved.rows[0].status).toBe('ENTERED');
    expect(Number(saved.rows[0].actual_shadow_entry)).toBe(1.105);
  });

  it('triggers a BUY_STOP when a candle high touches the trigger level', async () => {
    const id = await seedShadowTrade('TESTWATCHBUYSTOP', {
      status: 'AWAITING_TRIGGER', order_type: 'BUY_STOP', trigger_price: 1.105, actual_shadow_entry: null, entered_at: null,
    });
    vi.mocked(mt5Client.getMt5Bars).mockResolvedValue([bar(300, 1.1, 1.106, 1.099, 1.104)] as never);
    await runShadowTradeWatcherTick(pool);
    const saved = await pool.query('SELECT * FROM shadow_trades WHERE id = $1', [id]);
    expect(saved.rows[0].status).toBe('ENTERED');
    expect(Number(saved.rows[0].actual_shadow_entry)).toBe(1.105);
  });

  it('triggers a SELL_STOP when a candle low touches the trigger level', async () => {
    const id = await seedShadowTrade('TESTWATCHSELLSTOP', {
      status: 'AWAITING_TRIGGER', direction: 'SELL', order_type: 'SELL_STOP', trigger_price: 1.095,
      stop_loss: 1.10, take_profit: 1.08, actual_shadow_entry: null, entered_at: null,
    });
    vi.mocked(mt5Client.getMt5Bars).mockResolvedValue([bar(300, 1.1, 1.099, 1.094, 1.096)] as never);
    await runShadowTradeWatcherTick(pool);
    const saved = await pool.query('SELECT * FROM shadow_trades WHERE id = $1', [id]);
    expect(saved.rows[0].status).toBe('ENTERED');
    expect(Number(saved.rows[0].actual_shadow_entry)).toBe(1.095);
  });

  it('expires an untriggered pending shadow trade past its plan_expiry — never counted as WIN/LOSS', async () => {
    const id = await seedShadowTrade('TESTWATCHEXPIRE', {
      status: 'AWAITING_TRIGGER', order_type: 'BUY_LIMIT', trigger_price: 1.05, actual_shadow_entry: null, entered_at: null,
      plan_expiry: new Date(Date.now() - 60_000).toISOString(),
    });
    vi.mocked(mt5Client.getMt5Bars).mockResolvedValue([] as never);
    await runShadowTradeWatcherTick(pool);
    const saved = await pool.query('SELECT * FROM shadow_trades WHERE id = $1', [id]);
    expect(saved.rows[0].status).toBe('EXPIRED_NOT_TRIGGERED');
    expect(saved.rows[0].exit_reason).toBeNull();
  });

  it('closes TAKE_PROFIT when a candle high touches TP (BUY) without touching SL', async () => {
    const id = await seedShadowTrade('TESTWATCHTP');
    vi.mocked(mt5Client.getMt5Bars).mockResolvedValue([bar(300, 1.1, 1.125, 1.1, 1.12)] as never);
    await runShadowTradeWatcherTick(pool);
    const saved = await pool.query('SELECT * FROM shadow_trades WHERE id = $1', [id]);
    expect(saved.rows[0].status).toBe('CLOSED');
    expect(saved.rows[0].exit_reason).toBe('TAKE_PROFIT');
    expect(Number(saved.rows[0].actual_shadow_exit)).toBe(1.12);
    // entry 1.1, SL 1.09 (risk 0.01), TP 1.12 -> r_multiple = (1.12-1.1)/0.01 = 2
    expect(Number(saved.rows[0].r_multiple)).toBeCloseTo(2, 5);
    expect(Number(saved.rows[0].net_result_estimate)).toBeCloseTo(20, 5); // 2R * $10 max_planned_loss
  });

  it('closes STOP_LOSS when a candle low touches SL (BUY) without touching TP', async () => {
    const id = await seedShadowTrade('TESTWATCHSL');
    vi.mocked(mt5Client.getMt5Bars).mockResolvedValue([bar(300, 1.1, 1.101, 1.08, 1.085)] as never);
    await runShadowTradeWatcherTick(pool);
    const saved = await pool.query('SELECT * FROM shadow_trades WHERE id = $1', [id]);
    expect(saved.rows[0].status).toBe('CLOSED');
    expect(saved.rows[0].exit_reason).toBe('STOP_LOSS');
    expect(Number(saved.rows[0].r_multiple)).toBeCloseTo(-1, 5);
    expect(Number(saved.rows[0].net_result_estimate)).toBeCloseTo(-10, 5);
  });

  it('marks AMBIGUOUS_OUTCOME when a single M5 candle touches both SL and TP and M1 data cannot resolve order', async () => {
    const id = await seedShadowTrade('TESTWATCHAMBIG');
    // M5 candle low <= SL (1.09) AND high >= TP (1.12).
    vi.mocked(mt5Client.getMt5Bars).mockImplementation(async (_symbol, timeframe) => {
      if (timeframe === 'M5') return [bar(300, 1.1, 1.13, 1.08, 1.1)] as never;
      return [] as never; // no M1 data available -> cannot disambiguate
    });
    await runShadowTradeWatcherTick(pool);
    const saved = await pool.query('SELECT * FROM shadow_trades WHERE id = $1', [id]);
    expect(saved.rows[0].status).toBe('CLOSED');
    expect(saved.rows[0].exit_reason).toBe('AMBIGUOUS_OUTCOME');
    // Never guessed as a win: no r_multiple/net_result_estimate recorded.
    expect(saved.rows[0].r_multiple).toBeNull();
  });

  it('resolves a same-M5-candle SL+TP touch using finer M1 data when it clearly shows SL first', async () => {
    const id = await seedShadowTrade('TESTWATCHM1RESOLVE');
    vi.mocked(mt5Client.getMt5Bars).mockImplementation(async (_symbol, timeframe) => {
      if (timeframe === 'M5') return [bar(300, 1.1, 1.13, 1.08, 1.1)] as never;
      // M1 bars within that 5-minute window: first minute only touches SL.
      const m5Time = Math.floor(Date.now() / 1000) - 300;
      return [
        { time: m5Time, open: 1.1, high: 1.101, low: 1.085, close: 1.088, tick_volume: 10 },
        { time: m5Time + 60, open: 1.088, high: 1.13, low: 1.088, close: 1.12, tick_volume: 10 },
      ] as never;
    });
    await runShadowTradeWatcherTick(pool);
    const saved = await pool.query('SELECT * FROM shadow_trades WHERE id = $1', [id]);
    expect(saved.rows[0].status).toBe('CLOSED');
    expect(saved.rows[0].exit_reason).toBe('STOP_LOSS');
  });

  it('updates running MFE/MAE without closing while neither TP nor SL is touched', async () => {
    const id = await seedShadowTrade('TESTWATCHMFE');
    // Favorable excursion to 1.115 (0.5R), adverse to 1.095 (-0.5R relative to entry 1.1/SL 1.09).
    vi.mocked(mt5Client.getMt5Bars).mockResolvedValue([bar(300, 1.1, 1.115, 1.095, 1.1)] as never);
    await runShadowTradeWatcherTick(pool);
    const saved = await pool.query('SELECT * FROM shadow_trades WHERE id = $1', [id]);
    expect(saved.rows[0].status).toBe('ENTERED');
    expect(Number(saved.rows[0].mfe_r)).toBeCloseTo(1.5, 5); // (1.115-1.1)/0.01
    expect(Number(saved.rows[0].mae_r)).toBeCloseTo(-0.5, 5); // (1.095-1.1)/0.01
  });

  it('closes TIME_EXIT once the max holding window elapses without TP/SL', async () => {
    const id = await seedShadowTrade('TESTWATCHTIMEEXIT', {
      entered_at: new Date(Date.now() - 200 * 60_000).toISOString(), // older than default 180-minute max holding
    });
    vi.mocked(mt5Client.getMt5Bars).mockResolvedValue([bar(300, 1.1, 1.105, 1.098, 1.102)] as never);
    await runShadowTradeWatcherTick(pool);
    const saved = await pool.query('SELECT * FROM shadow_trades WHERE id = $1', [id]);
    expect(saved.rows[0].status).toBe('CLOSED');
    expect(saved.rows[0].exit_reason).toBe('TIME_EXIT');
  });
});
