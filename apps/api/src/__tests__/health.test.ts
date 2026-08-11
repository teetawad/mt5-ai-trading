import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../app';

describe('GET /health', () => {
  it('returns 200 with ok status', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('api');
    expect(res.body.mode).toBe('PAPER');
    expect(res.body.timestamp).toBeDefined();
  });

  it('mode is always PAPER — never LIVE', async () => {
    const res = await request(app).get('/health');
    expect(res.body.mode).not.toBe('LIVE');
  });
});

describe('GET /health/db', () => {
  it('returns 200 when connected or 503 when DB unreachable', async () => {
    const res = await request(app).get('/health/db');
    // 200 = connected, 503 = no DB available (expected in unit test environment)
    expect([200, 503]).toContain(res.status);
    expect(res.body.service).toBe('api');
    expect(res.body.timestamp).toBeDefined();
  });

  it('status field reflects connectivity', async () => {
    const res = await request(app).get('/health/db');
    if (res.status === 200) {
      expect(res.body.status).toBe('ok');
      expect(res.body.database).toBe('connected');
    } else {
      expect(res.body.status).toBe('error');
      expect(res.body.database).toBe('unreachable');
    }
  });
});
