import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { requireAuth, requireOwner } from '../../auth/middleware';
import { signToken } from '../../auth/tokens';
import { _clearDenylistForTest, denyToken } from '../../auth/denylist';

beforeEach(() => {
  process.env.SESSION_SECRET = 'test-secret-middleware';
  _clearDenylistForTest();
});

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  app.get('/protected', requireAuth, (req, res) => {
    res.json({ userId: req.user!.sub, role: req.user!.role });
  });

  app.get('/owner-only', requireAuth, requireOwner, (req, res) => {
    res.json({ ok: true });
  });

  return app;
}

describe('requireAuth middleware', () => {
  it('rejects a request with no token', async () => {
    const res = await request(makeApp()).get('/protected');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('accepts a valid Bearer token', async () => {
    const token = signToken({ sub: 'user-1', email: 'o@t.com', role: 'owner' });
    const res = await request(makeApp())
      .get('/protected')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe('user-1');
  });

  it('accepts a valid session cookie', async () => {
    const token = signToken({ sub: 'user-2', email: 'o@t.com', role: 'owner' });
    const res = await request(makeApp())
      .get('/protected')
      .set('Cookie', `session=${token}`);
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe('user-2');
  });

  it('rejects a tampered token', async () => {
    const token = signToken({ sub: 'u', email: 'a@b.com', role: 'owner' });
    const bad = token.slice(0, -5) + 'ZZZZZ';
    const res = await request(makeApp())
      .get('/protected')
      .set('Authorization', `Bearer ${bad}`);
    expect(res.status).toBe(401);
  });

  it('rejects a denied (logged-out) token', async () => {
    const token = signToken({ sub: 'u', email: 'a@b.com', role: 'owner' });
    const decoded = (await import('../../auth/tokens')).verifyToken(token);
    denyToken(decoded.jti, decoded.exp);
    const res = await request(makeApp())
      .get('/protected')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.message).toContain('invalidated');
  });
});

describe('requireOwner middleware', () => {
  it('allows owner role', async () => {
    const token = signToken({ sub: 'u', email: 'o@t.com', role: 'owner' });
    const res = await request(makeApp())
      .get('/owner-only')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it('rejects non-owner role', async () => {
    const token = signToken({ sub: 'u', email: 'r@t.com', role: 'viewer' });
    const res = await request(makeApp())
      .get('/owner-only')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });
});
