import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { createApp } from '../app';
import { signToken } from '../auth/tokens';
import { _clearDenylistForTest } from '../auth/denylist';
import { closePool } from '../db/client';
import { getTestPool, setupTestDb } from './db/setup';
import {
  CryptoAnalysisDTO,
  analyzeCrypto,
  cancelOrder,
  evaluateRisk,
  getMarketSnapshot,
  getPaperPortfolio,
  getTrackedSymbols,
  submitOrder,
} from '../services/trading-engine-client';

vi.mock('../services/trading-engine-client', async () => {
  const actual = await vi.importActual<typeof import('../services/trading-engine-client')>(
    '../services/trading-engine-client',
  );
  return {
    ...actual,
    getMarketSnapshot: vi.fn(),
    getPaperPortfolio: vi.fn(),
    getTrackedSymbols: vi.fn(),
    evaluateRisk: vi.fn(),
    submitOrder: vi.fn(),
    cancelOrder: vi.fn(),
    analyzeCrypto: vi.fn(),
  };
});

const SKIP = !process.env.TEST_DATABASE_URL;
const OWNER_ID = '00000000-0000-4000-8000-000000000260';
const BROKER_RUN_ID = `crypto-${Date.now()}-${process.pid}`;
let brokerOrderSequence = 0;

function token() {
  process.env.SESSION_SECRET = 'test-secret-phase-26';
  return signToken({ sub: OWNER_ID, email: 'phase26-owner@test.example.com', role: 'owner' });
}

function buyAnalysis(overrides: Partial<CryptoAnalysisDTO> = {}): CryptoAnalysisDTO {
  return {
    symbol: 'BTC/USD',
    as_of: '2024-01-15T15:00:00.000Z',
    decision: 'BUY',
    confidence: 0.75,
    reasons: ['1h trend UP, 15m setup confirmed, 5m entry timing confirmed'],
    trend_direction: 'UP',
    trend_strength_pct: '1.50000000',
    setup_momentum_pct: '0.80000000',
    setup_volume_ratio: '1.20000000',
    setup_confirmed: true,
    entry_momentum_pct: '0.30000000',
    entry_volume_ratio: '1.10000000',
    entry_confirmed: true,
    volume_signal: 'CONFIRMED',
    atr: '500.00000000',
    atr_pct: '0.83000000',
    spread_pct: '0.05000000',
    liquidity_ok: true,
    entry_price: '60000.00000000',
    stop_loss: '59250.00000000',
    take_profit: '61500.00000000',
    risk_reward: '2.00000000',
    market_status: 'OPEN_24_7',
    ...overrides,
  };
}

function sellAnalysis(overrides: Partial<CryptoAnalysisDTO> = {}): CryptoAnalysisDTO {
  return {
    ...buyAnalysis(),
    decision: 'SELL',
    stop_loss: null,
    take_profit: null,
    risk_reward: null,
    reasons: ['1h trend reversed DOWN, 15m setup confirmed, 5m entry timing confirmed: closing existing long position'],
    ...overrides,
  };
}

function holdAnalysis(overrides: Partial<CryptoAnalysisDTO> = {}): CryptoAnalysisDTO {
  return {
    ...buyAnalysis(),
    decision: 'HOLD',
    confidence: 0.2,
    reasons: ['5m entry timing (momentum + volume) not triggered'],
    stop_loss: null,
    take_profit: null,
    risk_reward: null,
    ...overrides,
  };
}

function mockEngine(positions: Record<string, string> = {}) {
  vi.mocked(getMarketSnapshot).mockResolvedValue({
    symbol: 'BTC/USD',
    price: '60000.00000000',
    bid: '59985.00000000',
    ask: '60015.00000000',
    volume: 1000,
    timestamp: '2024-01-15T15:00:00.000Z',
    is_stale: false,
  });
  vi.mocked(getPaperPortfolio).mockResolvedValue({
    cash: '50000.00000000',
    positions,
  });
  vi.mocked(getTrackedSymbols).mockResolvedValue(['AAPL', 'MSFT']);
  vi.mocked(evaluateRisk).mockResolvedValue({
    result: 'PASS',
    stage: 'PRE_PROPOSAL',
    rules_checked: ['KILL_SWITCH', 'TRADING_MODE'],
    failed_rules: [],
    reason: null,
    market_snapshot: {
      symbol: 'BTC/USD',
      price: '60000.00000000',
      is_stale: false,
      timestamp: '2024-01-15T15:00:00.000Z',
    },
    portfolio_snapshot: {
      cash: '50000.00000000',
      positions,
      equity: '50000.00000000',
      daily_pnl: '0.00000000',
    },
    evaluated_at: '2024-01-15T15:00:00.000Z',
  });
  vi.mocked(cancelOrder).mockResolvedValue(null);
  vi.mocked(submitOrder).mockImplementation(async (req) => {
    brokerOrderSequence += 1;
    const brokerOrderId = `${BROKER_RUN_ID}-${brokerOrderSequence}`;
    return {
      broker_order_id: brokerOrderId,
      status: 'FILLED',
      ...(req.bracket
        ? {
          bracket_order_ids: {
            parent: brokerOrderId,
            take_profit: `${brokerOrderId}-tp`,
            stop_loss: `${brokerOrderId}-sl`,
          },
        }
        : {}),
      fills: [
        {
          order_id: brokerOrderId,
          fill_id: `${brokerOrderId}-fill`,
          quantity: req.quantity,
          price: req.side === 'BUY' ? '60000.00000000' : '60100.00000000',
          fee: '0.60000000',
          is_partial: false,
          filled_at: '2024-01-15T15:01:00.000Z',
        },
      ],
    };
  });
}

async function resetTradingLedger(pool: Pool) {
  await pool.query(
    `TRUNCATE audit_logs, fills, orders, executions, trade_approvals, risk_checks,
     trade_proposals, signals, positions, portfolio_snapshots
     RESTART IDENTITY CASCADE`,
  );
}

describe('Phase 26 crypto trading mode', () => {
  let pool: Pool;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    if (SKIP) return;
    process.env.SESSION_SECRET = 'test-secret-phase-26';
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    pool = getTestPool();
    await setupTestDb(pool);
    await pool.query(
      `INSERT INTO users (id, email, display_name, password_hash, role, is_active)
       VALUES ($1, 'phase26-owner@test.example.com', 'Phase 26 Owner', 'hash', 'owner', true)
       ON CONFLICT (id) DO NOTHING`,
      [OWNER_ID],
    );
    await pool.query("UPDATE system_settings SET value = '50000'::jsonb WHERE key = 'initial_paper_cash_usd'");
    await pool.query("UPDATE system_settings SET value = 'true'::jsonb WHERE key = 'phase26_crypto_trading_enabled'");
    await pool.query("UPDATE system_settings SET value = '5'::jsonb WHERE key = 'phase26_max_trades_per_symbol_per_day'");
    app = createApp();
  });

  afterAll(async () => {
    await closePool();
    if (pool) {
      await resetTradingLedger(pool);
      await pool.query("UPDATE system_settings SET value = '100000'::jsonb WHERE key = 'initial_paper_cash_usd'");
      await pool.query("UPDATE system_settings SET value = 'false'::jsonb WHERE key = 'phase26_crypto_trading_enabled'");
      await pool.query("UPDATE system_settings SET value = '5'::jsonb WHERE key = 'phase26_max_trades_per_symbol_per_day'");
      await pool.query("UPDATE system_settings SET value = 'true'::jsonb WHERE key = 'trading_kill_switch_enabled'");
      await pool.query('UPDATE system_settings SET updated_by = NULL WHERE updated_by = $1', [OWNER_ID]);
      await pool.query('DELETE FROM users WHERE id = $1', [OWNER_ID]);
      await pool.end();
    }
  });

  beforeEach(async () => {
    _clearDenylistForTest();
    vi.clearAllMocks();
    mockEngine();
    await resetTradingLedger(pool);
    await pool.query("UPDATE system_settings SET value = 'true'::jsonb WHERE key = 'trading_kill_switch_enabled'");
  });

  it.skipIf(SKIP)('rejects when crypto trading mode is disabled', async () => {
    await pool.query("UPDATE system_settings SET value = 'false'::jsonb WHERE key = 'phase26_crypto_trading_enabled'");
    vi.mocked(analyzeCrypto).mockResolvedValue(buyAnalysis());

    const res = await request(app)
      .post('/signals/crypto-decision')
      .set('Authorization', `Bearer ${token()}`)
      .send({ symbol: 'BTC/USD' });

    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/disabled/i);

    await pool.query("UPDATE system_settings SET value = 'true'::jsonb WHERE key = 'phase26_crypto_trading_enabled'");
  });

  it.skipIf(SKIP)('rejects an unsupported symbol', async () => {
    const res = await request(app)
      .post('/signals/crypto-decision')
      .set('Authorization', `Bearer ${token()}`)
      .send({ symbol: 'DOGE/USD' });

    expect(res.status).toBe(422);
  });

  it.skipIf(SKIP)('HOLD decision creates no proposal', async () => {
    vi.mocked(analyzeCrypto).mockResolvedValue(holdAnalysis());

    const res = await request(app)
      .post('/signals/crypto-decision')
      .set('Authorization', `Bearer ${token()}`)
      .send({ symbol: 'BTC/USD' });

    expect(res.status).toBe(200);
    expect(res.body.proposal).toBeNull();
    expect(res.body.analysis.decision).toBe('HOLD');
  });

  it.skipIf(SKIP)('BUY decision creates a PENDING_APPROVAL proposal with a fractional ATR-derived phase26 bracket', async () => {
    vi.mocked(analyzeCrypto).mockResolvedValue(buyAnalysis());

    const res = await request(app)
      .post('/signals/crypto-decision')
      .set('Authorization', `Bearer ${token()}`)
      .send({ symbol: 'BTC/USD' });

    expect(res.status).toBe(201);
    expect(res.body.proposal.status).toBe('PENDING_APPROVAL');
    expect(res.body.proposal.side).toBe('BUY');
    expect(res.body.proposal.assetClass).toBe('CRYPTO');
    expect(res.body.proposal.riskSnapshot.phase26).toMatchObject({
      assetClass: 'CRYPTO',
      orderClass: 'BRACKET',
      marketStatus: 'OPEN_24_7',
      stopLoss: '59250.00000000',
      takeProfit: '61500.00000000',
      result: 'PASS',
    });
    // fractional (8dp) quantity — not rounded down to a whole unit
    expect(Number(res.body.proposal.quantity)).toBeGreaterThan(0);
    expect(Number(res.body.proposal.quantity)).toBeLessThan(1);
  });

  it.skipIf(SKIP)('approval submits a fractional, fee_bps-tagged bracket order', async () => {
    vi.mocked(analyzeCrypto).mockResolvedValue(buyAnalysis());
    const created = await request(app)
      .post('/signals/crypto-decision')
      .set('Authorization', `Bearer ${token()}`)
      .send({ symbol: 'BTC/USD' });

    const approved = await request(app)
      .post(`/trade-proposals/${created.body.proposal.id}/approve`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ requestId: 'phase26-approve' });

    expect(approved.status).toBe(200);
    expect(approved.body.proposal.status).toBe('FILLED');
    const submittedOrder = vi.mocked(submitOrder).mock.calls[0][0];
    expect(submittedOrder.bracket).toMatchObject({
      stop_loss_price: '59250.00000000',
      take_profit_price: '61500.00000000',
    });
    expect(submittedOrder.fractionable).toBe(true);
    expect(submittedOrder.fee_bps).toBe(10);
  });

  it.skipIf(SKIP)('SELL with an existing position closes it without a bracket', async () => {
    mockEngine({ 'BTC/USD': '0.05000000' });
    vi.mocked(analyzeCrypto).mockResolvedValue(sellAnalysis());

    const res = await request(app)
      .post('/signals/crypto-decision')
      .set('Authorization', `Bearer ${token()}`)
      .send({ symbol: 'BTC/USD' });

    expect(res.status).toBe(201);
    expect(res.body.proposal.side).toBe('SELL');
    expect(res.body.proposal.quantity).toBe('0.05000000');
    expect(res.body.proposal.riskSnapshot.phase26.orderClass).toBe('SINGLE');
  });

  it.skipIf(SKIP)('SELL without an open position is rejected before any order is built', async () => {
    // Zero position -> zero requested SELL quantity -> rejected by the same
    // positive-quantity validation every signal path uses, before the risk
    // engine round-trip. (In production this never happens in the first
    // place — analyze_crypto_multi_timeframe only emits SELL when the
    // caller confirms has_open_position — this exercises the Node-side
    // defense-in-depth for a mocked engine that returns SELL anyway.)
    vi.mocked(analyzeCrypto).mockResolvedValue(sellAnalysis());

    const res = await request(app)
      .post('/signals/crypto-decision')
      .set('Authorization', `Bearer ${token()}`)
      .send({ symbol: 'BTC/USD' });

    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/quantity/i);
    expect(vi.mocked(submitOrder)).not.toHaveBeenCalled();
  });

  it.skipIf(SKIP)('rejects when estimated slippage exceeds the configured maximum', async () => {
    await pool.query("UPDATE system_settings SET value = '5'::jsonb WHERE key = 'phase26_estimated_slippage_pct'");
    vi.mocked(analyzeCrypto).mockResolvedValue(buyAnalysis());

    const res = await request(app)
      .post('/signals/crypto-decision')
      .set('Authorization', `Bearer ${token()}`)
      .send({ symbol: 'BTC/USD' });

    expect(res.status).toBe(201);
    expect(res.body.proposal.status).toBe('RISK_REJECTED');
    expect(res.body.proposal.riskSnapshot.phase26.failedRules).toContain('PHASE26_ESTIMATED_SLIPPAGE');

    await pool.query("UPDATE system_settings SET value = '0.10'::jsonb WHERE key = 'phase26_estimated_slippage_pct'");
  });

  it.skipIf(SKIP)('rejects once the per-symbol daily trade limit is reached', async () => {
    await pool.query("UPDATE system_settings SET value = '1'::jsonb WHERE key = 'phase26_max_trades_per_symbol_per_day'");
    vi.mocked(analyzeCrypto).mockResolvedValue(buyAnalysis());

    const first = await request(app)
      .post('/signals/crypto-decision')
      .set('Authorization', `Bearer ${token()}`)
      .send({ symbol: 'BTC/USD' });
    const second = await request(app)
      .post('/signals/crypto-decision')
      .set('Authorization', `Bearer ${token()}`)
      .send({ symbol: 'BTC/USD' });

    expect(first.status).toBe(201);
    expect(first.body.proposal.status).toBe('PENDING_APPROVAL');
    expect(second.status).toBe(201);
    expect(second.body.proposal.status).toBe('RISK_REJECTED');
    expect(second.body.riskCheck.failedRules).toContain('PHASE26_MAX_TRADES_PER_SYMBOL_PER_DAY');

    await pool.query("UPDATE system_settings SET value = '5'::jsonb WHERE key = 'phase26_max_trades_per_symbol_per_day'");
  });

  it.skipIf(SKIP)('GET /crypto/analysis/:symbol returns the analysis and a sizing preview', async () => {
    vi.mocked(analyzeCrypto).mockResolvedValue(buyAnalysis());

    const res = await request(app)
      .get('/crypto/analysis/BTC%2FUSD')
      .set('Authorization', `Bearer ${token()}`);

    expect(res.status).toBe(200);
    expect(res.body.analysis.decision).toBe('BUY');
    expect(res.body.sizingPreview.passed).toBe(true);
    expect(res.body.sizingPreview.snapshot.stopLoss).toBe('59250.00000000');
    expect(res.body.hasOpenPosition).toBe(false);
  });

  it.skipIf(SKIP)('GET /crypto/symbols returns the configured symbol list and enabled flag', async () => {
    const res = await request(app)
      .get('/crypto/symbols')
      .set('Authorization', `Bearer ${token()}`);

    expect(res.status).toBe(200);
    expect(res.body.symbols).toEqual(expect.arrayContaining(['BTC/USD', 'ETH/USD']));
    expect(res.body.enabled).toBe(true);
  });

  it.skipIf(SKIP)('a rejected crypto trade does not affect US stock proposal flow (asset classes isolated)', async () => {
    vi.mocked(analyzeCrypto).mockResolvedValue(buyAnalysis());
    await pool.query("UPDATE system_settings SET value = 'false'::jsonb WHERE key = 'phase26_crypto_trading_enabled'");

    const cryptoRes = await request(app)
      .post('/signals/crypto-decision')
      .set('Authorization', `Bearer ${token()}`)
      .send({ symbol: 'BTC/USD' });
    expect(cryptoRes.status).toBe(422);

    const stockOptions = await request(app)
      .get('/signals/manual-test/options')
      .set('Authorization', `Bearer ${token()}`);
    expect(stockOptions.status).toBe(200);

    await pool.query("UPDATE system_settings SET value = 'true'::jsonb WHERE key = 'phase26_crypto_trading_enabled'");
  });
});
