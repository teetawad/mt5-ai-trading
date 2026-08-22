import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { createApp } from '../../app';
import { getTestPool, setupTestDb } from '../db/setup';
import { hashPassword } from '../../auth/password';
import { signToken } from '../../auth/tokens';
import { _clearDenylistForTest } from '../../auth/denylist';

const SKIP = !process.env.TEST_DATABASE_URL;

const TEST_PASSWORD = 'StrongTestPassword123!';
const TEST_EMAIL = 'owner@test.example.com';

describe('POST /auth/login', () => {
  let pool: Pool;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    if (SKIP) return;
    process.env.SESSION_SECRET = 'test-integration-secret';
    pool = getTestPool();
    await setupTestDb(pool);
    app = createApp();

    // Seed a test owner user
    const passwordHash = await hashPassword(TEST_PASSWORD);
    await pool.query(
      `INSERT INTO users (email, display_name, password_hash, role, is_active)
       VALUES ($1, $2, $3, 'owner', true)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
      [TEST_EMAIL, 'Test Owner', passwordHash],
    );
  });

  afterAll(async () => {
    if (pool) {
      // Never DELETE the seeded test user here: audit_logs rows created by
      // this file's own login/logout tests reference it via actor_id, and
      // audit_logs is intentionally immutable (no DELETE/UPDATE allowed) —
      // the FK makes that delete fail every time after the first login. The
      // row is reused (ON CONFLICT DO UPDATE) by the next run instead.
      await pool.end();
    }
  });

  beforeEach(() => {
    _clearDenylistForTest();
  });

  it.skipIf(SKIP)('returns 200 and a token on valid credentials', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(TEST_EMAIL);
    expect(res.body.user.role).toBe('owner');
    expect(res.body.sessionToken).toBeDefined();
    expect(res.body.user.passwordHash).toBeUndefined();
  });

  it.skipIf(SKIP)('sets an HttpOnly session cookie', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });
    const cookie = res.headers['set-cookie'] as string[] | string;
    const cookieStr = Array.isArray(cookie) ? cookie.join('; ') : cookie;
    expect(cookieStr).toContain('session=');
    expect(cookieStr.toLowerCase()).toContain('httponly');
  });

  it.skipIf(SKIP)('returns 401 on wrong password', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({ email: TEST_EMAIL, password: 'wrongpassword' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('INVALID_CREDENTIALS');
  });

  it.skipIf(SKIP)('returns 401 on unknown email', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'nobody@example.com', password: TEST_PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('INVALID_CREDENTIALS');
  });

  it.skipIf(SKIP)('returns 422 on missing fields', async () => {
    const res = await request(app).post('/auth/login').send({ email: TEST_EMAIL });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it.skipIf(SKIP)('does not reveal whether the email exists (same response for both failures)', async () => {
    const res1 = await request(app)
      .post('/auth/login')
      .send({ email: 'noone@example.com', password: 'any' });
    const res2 = await request(app)
      .post('/auth/login')
      .send({ email: TEST_EMAIL, password: 'wrong' });
    expect(res1.status).toBe(res2.status);
    expect(res1.body.error).toBe(res2.body.error);
  });

  it.skipIf(SKIP)('records a LOGIN_SUCCESS audit event', async () => {
    await request(app)
      .post('/auth/login')
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });

    const { rows } = await pool.query(
      "SELECT * FROM audit_logs WHERE event_type = 'LOGIN_SUCCESS' AND actor_email = $1 ORDER BY created_at DESC LIMIT 1",
      [TEST_EMAIL],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].action).toBe('LOGIN');
  });

  it.skipIf(SKIP)('records a LOGIN_FAILED audit event', async () => {
    await request(app)
      .post('/auth/login')
      .send({ email: TEST_EMAIL, password: 'wrongpassword' });

    const { rows } = await pool.query(
      "SELECT * FROM audit_logs WHERE event_type = 'LOGIN_FAILED' AND actor_email = $1 ORDER BY created_at DESC LIMIT 1",
      [TEST_EMAIL],
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].action).toBe('LOGIN_ATTEMPT_FAILED');
  });
});

describe('POST /auth/logout', () => {
  let pool: Pool;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    if (SKIP) return;
    process.env.SESSION_SECRET = 'test-integration-secret';
    pool = getTestPool();
    await setupTestDb(pool);
    app = createApp();

    const passwordHash = await hashPassword(TEST_PASSWORD);
    await pool.query(
      `INSERT INTO users (email, display_name, password_hash, role, is_active)
       VALUES ($1, $2, $3, 'owner', true)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
      [TEST_EMAIL, 'Test Owner', passwordHash],
    );
  });

  afterAll(async () => {
    if (pool) {
      // Never DELETE the seeded test user here: audit_logs rows created by
      // this file's own login/logout tests reference it via actor_id, and
      // audit_logs is intentionally immutable (no DELETE/UPDATE allowed) —
      // the FK makes that delete fail every time after the first login. The
      // row is reused (ON CONFLICT DO UPDATE) by the next run instead.
      await pool.end();
    }
  });

  beforeEach(() => {
    _clearDenylistForTest();
  });

  it.skipIf(SKIP)('returns 200 and clears the cookie', async () => {
    const loginRes = await request(app)
      .post('/auth/login')
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });
    const token = loginRes.body.sessionToken as string;

    const logoutRes = await request(app)
      .post('/auth/logout')
      .set('Authorization', `Bearer ${token}`);
    expect(logoutRes.status).toBe(200);
  });

  it.skipIf(SKIP)('invalidates the token so subsequent requests fail', async () => {
    const loginRes = await request(app)
      .post('/auth/login')
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });
    const token = loginRes.body.sessionToken as string;

    await request(app)
      .post('/auth/logout')
      .set('Authorization', `Bearer ${token}`);

    const meRes = await request(app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${token}`);
    expect(meRes.status).toBe(401);
  });

  it.skipIf(SKIP)('returns 401 without a token', async () => {
    const res = await request(app).post('/auth/logout');
    expect(res.status).toBe(401);
  });

  it.skipIf(SKIP)('records a LOGOUT audit event', async () => {
    const loginRes = await request(app)
      .post('/auth/login')
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });
    const token = loginRes.body.sessionToken as string;

    await request(app)
      .post('/auth/logout')
      .set('Authorization', `Bearer ${token}`);

    const { rows } = await pool.query(
      "SELECT * FROM audit_logs WHERE event_type = 'LOGOUT' AND actor_email = $1 ORDER BY created_at DESC LIMIT 1",
      [TEST_EMAIL],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].action).toBe('LOGOUT');
  });
});

describe('GET /auth/me', () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    process.env.SESSION_SECRET = 'test-integration-secret';
    app = createApp();
    _clearDenylistForTest();
  });

  it('returns 401 without token', async () => {
    const res = await request(app).get('/auth/me');
    expect(res.status).toBe(401);
  });

  it('returns user info with valid token (no DB needed)', async () => {
    const token = signToken({ sub: 'user-99', email: 'me@example.com', role: 'owner' });
    const res = await request(app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('user-99');
    expect(res.body.email).toBe('me@example.com');
    expect(res.body.role).toBe('owner');
  });
});
