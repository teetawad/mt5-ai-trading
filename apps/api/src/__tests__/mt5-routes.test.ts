import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { signToken } from '../auth/tokens';
import { createApp } from '../app';

vi.mock('../services/mt5-client', () => ({
  getMt5Status: vi.fn(async () => ({
    connected: true,
    demo_verified: true,
    account: { login: 60124487, server: 'TradeMaxGlobal-Demo', balance: 300, equity: 300 },
    terminal: { trade_allowed: true },
  })),
}));

beforeEach(() => {
  process.env.SESSION_SECRET = 'test-secret-mt5-routes';
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
});
