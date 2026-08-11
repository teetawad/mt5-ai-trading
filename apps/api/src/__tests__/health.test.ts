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
  it('returns 200', async () => {
    const res = await request(app).get('/health/db');
    expect(res.status).toBe(200);
  });
});
