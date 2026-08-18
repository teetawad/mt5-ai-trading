import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { signToken } from '../auth/tokens';
import { createApp } from '../app';

vi.mock('../services/mt5-client', () => ({
  getMt5Status: vi.fn(async () => ({
    connected: true,
    demo_verified: true,
    account: { login: 60124487, server: 'TradeMaxGlobal-Demo', balance: 300, equity: 300, free_margin: 300, margin_free: 300, leverage: 500 },
    terminal: { trade_allowed: true },
  })),
  listMt5Positions: vi.fn(async () => []),
  getMt5SymbolInfo: vi.fn(async (symbol: string) => ({
    symbol,
    point: 0.01,
    trade_tick_size: 0.01,
    trade_tick_value: 0.01,
    trade_tick_value_profit: 0.01,
    trade_tick_value_loss: 0.01,
    trade_contract_size: 1,
    volume_min: 0.01,
    volume_max: 50,
    volume_step: 0.01,
    trade_stops_level: 0,
    trade_freeze_level: 0,
    digits: 2,
  })),
  analyzeMt5Symbol: vi.fn(async (symbol: string) => ({
    symbol,
    bid: '100',
    ask: '100.1',
    spread: '10',
    quote_timestamp: new Date().toISOString(),
    market_status: symbol === 'CLOSED' ? 'CLOSED' : 'OPEN',
    data_status: symbol === 'STALE' ? 'STALE' : 'LIVE',
    session_open: new Date().toISOString(),
    session_close: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    next_session_open: new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString(),
    server_time: new Date().toISOString(),
    local_time: new Date().toISOString(),
    quote_age_seconds: symbol === 'STALE' ? 99 : 1,
    source: 'MT5_BROKER_SESSION',
    market: {},
    decision: symbol === 'WAIT' || symbol === 'CLOSED' ? 'NO_TRADE' : symbol === 'SELL' ? 'SELL' : 'BUY',
    confidence: symbol === 'WAIT' || symbol === 'CLOSED' ? 0 : 0.72,
    opportunity_score: symbol === 'WAIT' || symbol === 'CLOSED' ? 0 : 78,
    reasons: symbol === 'WAIT' ? ['Momentum is weak'] : ['H1 trend is rising', 'Spread is acceptable'],
    reference_entry: '100.1',
    current_price: '100.1',
    entry_strategy: symbol === 'PULLBACK' ? 'PULLBACK' : symbol === 'BREAKOUT' ? 'BREAKOUT' : symbol === 'WAIT' || symbol === 'CLOSED' ? 'NO_ENTRY' : 'MARKET_NOW',
    entry_zone_low: symbol === 'PULLBACK' ? '99.5' : null,
    entry_zone_high: symbol === 'PULLBACK' ? '99.8' : null,
    trigger_price: symbol === 'BREAKOUT' ? '101' : null,
    entry_reason: 'Test entry reason',
    stop_loss: symbol === 'WAIT' || symbol === 'CLOSED' ? null : '99',
    take_profit: symbol === 'WAIT' || symbol === 'CLOSED' ? null : '102',
    risk_reward: symbol === 'WAIT' || symbol === 'CLOSED' ? null : '2',
    expected_holding_hours: 4,
    signal_candle_timestamp: new Date().toISOString(),
    model_version: 'TEST',
    features: { trend: 'up' },
  })),
  getMt5MarketStatus: vi.fn(async () => ({ market_status: 'OPEN', data_status: 'LIVE' })),
  getMt5Tick: vi.fn(async () => ({ bid: 100, ask: 100.1 })),
  listMt5Symbols: vi.fn(async () => []),
  checkMt5Order: vi.fn(async () => ({})),
  sendMt5Order: vi.fn(async () => ({})),
}));

vi.mock('../db/client', () => ({
  getPool: vi.fn(() => ({
    query: vi.fn(async (sql: string) => {
      if (sql.includes('FROM instruments')) return { rows: [{ asset_class: 'FOREX', description: 'Test symbol' }], rowCount: 1 };
      if (sql.includes('count(*)::int AS c')) return { rows: [{ c: 0 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }),
  })),
}));

beforeEach(() => {
  process.env.SESSION_SECRET = 'test-secret-mt5-routes';
  process.env.MT5_AUTO_DEMO_ENABLED = 'false';
  process.env.MT5_KILL_SWITCH_ENABLED = 'false';
  process.env.MT5_MAX_RISK_PER_TRADE_PCT = '0.50';
  process.env.MT5_MAX_LOSS_PER_TRADE = '2.00';
  process.env.MT5_MAX_DAILY_LOSS = '10.00';
  process.env.MT5_MAX_DRAWDOWN_PCT = '5.00';
  process.env.MT5_MAX_SIMULTANEOUS_POSITIONS = '3';
  process.env.MT5_MAX_TRADES_PER_DAY = '6';
  process.env.MT5_MIN_RISK_REWARD = '1.50';
  process.env.MT5_MAX_SPREAD_POINTS = '50';
  process.env.MT5_QUOTE_STALENESS_SECONDS = '10';
  process.env.MT5_ALLOWED_DEVIATION_POINTS = '20';
  process.env.MT5_COOLDOWN_MINUTES = '60';
});

function ownerToken(): string {
  return signToken({ sub: 'owner-1', email: 'owner@example.com', role: 'owner' });
}

describe('MT5 route authentication', () => {
  it('rejects unauthenticated scanner requests', async () => {
    const res = await request(createApp()).get('/mt5/scanner');
    expect(res.status).toBe(401);
  });

  it('allows authenticated users to read MT5 status', async () => {
    const res = await request(createApp())
      .get('/mt5/status')
      .set('Authorization', `Bearer ${ownerToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(true);
    expect(res.body.account.login).toBe(60124487);
  });

  it('rejects unauthenticated assisted demo requests', async () => {
    const res = await request(createApp()).post('/mt5/assisted-demo/EURUSD');
    expect(res.status).toBe(401);
  });

  it('allows authenticated owners to read live MT5 positions', async () => {
    const res = await request(createApp())
      .get('/mt5/positions')
      .set('Authorization', `Bearer ${ownerToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.positions).toEqual([]);
  });

  it('returns active MT5 risk settings from environment', async () => {
    const res = await request(createApp())
      .get('/mt5/risk-settings')
      .set('Authorization', `Bearer ${ownerToken()}`);
    expect(res.status).toBe(200);
    const byKey = Object.fromEntries(res.body.map((row: { key: string; value: unknown }) => [row.key, row.value]));
    expect(byKey.mt5_kill_switch_enabled).toBe(false);
    expect(byKey.mt5_max_risk_per_trade_pct).toBe('0.50');
    expect(byKey.mt5_max_loss_per_trade).toBe('2.00');
    expect(byKey.mt5_max_daily_loss).toBe('10.00');
    expect(byKey.mt5_max_drawdown_pct).toBe('5.00');
    expect(byKey.mt5_max_simultaneous_positions).toBe(3);
    expect(byKey.mt5_max_trades_per_day).toBe(6);
    expect(byKey.mt5_min_risk_reward).toBe('1.50');
    expect(byKey.mt5_max_spread_points).toBe(50);
    expect(byKey.mt5_quote_staleness_seconds).toBe(10);
    expect(byKey.mt5_allowed_deviation_points).toBe(20);
    expect(byKey.mt5_cooldown_minutes).toBe(60);
  });

  it('keeps AUTO-DEMO OFF from environment', async () => {
    const res = await request(createApp())
      .get('/mt5/auto-demo')
      .set('Authorization', `Bearer ${ownerToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
  });

  it('returns a complete OPEN BUY trading plan with enabled demo trade button', async () => {
    const res = await request(createApp())
      .get('/mt5/analysis/BUY')
      .set('Authorization', `Bearer ${ownerToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.market.status).toBe('OPEN');
    expect(res.body.market.dataStatus).toBe('LIVE');
    expect(res.body.decision.action).toBe('BUY');
    expect(res.body.entryPlan.beginner_label).toBe('ENTER NOW');
    expect(res.body.protection.stopLoss).toBe('99');
    expect(res.body.positionSizing.recommendedLotSize).toBeTruthy();
    expect(res.body.risk.result).toBe('PASS');
    expect(res.body.tradeButton.enabled).toBe(true);
  });

  it('returns SELL, PULLBACK, BREAKOUT, WAIT, stale, and closed states without sending orders', async () => {
    const token = `Bearer ${ownerToken()}`;
    const sell = await request(createApp()).get('/mt5/analysis/SELL').set('Authorization', token);
    expect(sell.body.decision.action).toBe('SELL');

    const pullback = await request(createApp()).get('/mt5/analysis/PULLBACK').set('Authorization', token);
    expect(pullback.body.entryPlan.beginner_label).toBe('WAIT FOR PRICE');
    expect(pullback.body.tradeButton.enabled).toBe(false);

    const breakout = await request(createApp()).get('/mt5/analysis/BREAKOUT').set('Authorization', token);
    expect(breakout.body.entryPlan.beginner_label).toBe('WAIT FOR BREAKOUT');
    expect(breakout.body.tradeButton.enabled).toBe(false);

    const wait = await request(createApp()).get('/mt5/analysis/WAIT').set('Authorization', token);
    expect(wait.body.decision.action).toBe('WAIT');
    expect(wait.body.entryPlan.beginner_label).toBe('DO NOT ENTER');
    expect(wait.body.tradeButton.disabledReasons.map((reason: { rule: string }) => reason.rule)).toContain('NO_EXECUTABLE_DECISION');

    const stale = await request(createApp()).get('/mt5/analysis/STALE').set('Authorization', token);
    expect(stale.body.tradeButton.enabled).toBe(false);
    expect(stale.body.tradeButton.disabledReasons.map((reason: { rule: string }) => reason.rule)).toContain('STALE_PRICE_DATA');

    const closed = await request(createApp()).get('/mt5/analysis/CLOSED').set('Authorization', token);
    expect(closed.body.market.status).toBe('CLOSED');
    expect(closed.body.entryPlan.current_entry_status).toBe('BLOCKED_MARKET_CLOSED');
    expect(closed.body.tradeButton.disabledReasons.map((reason: { rule: string }) => reason.rule)).toContain('MARKET_CLOSED');
  });
});
