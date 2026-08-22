import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../app';

// Capacitor's WKWebView presents the page origin as capacitor://localhost (or
// http://localhost/ionic://localhost in some dev configurations) - the API
// must allow it alongside the existing web dev origin, or the iOS app can
// never read a single response (see apps/api/src/app.ts parseCorsOrigins()).
// GET /health is used because it needs neither DB nor SESSION_SECRET, so this
// suite runs unconditionally (unlike most DB-backed suites here, which are
// skipped without TEST_DATABASE_URL).
describe('CORS allow-list (default, no CORS_ORIGIN env override)', () => {
  const app = createApp();

  it('allows the web dev origin', async () => {
    const res = await request(app).get('/health').set('Origin', 'http://localhost:3000');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
  });

  it('allows the Capacitor iOS WebView origin', async () => {
    const res = await request(app).get('/health').set('Origin', 'capacitor://localhost');
    expect(res.headers['access-control-allow-origin']).toBe('capacitor://localhost');
  });

  it('rejects an arbitrary third-party origin', async () => {
    const res = await request(app).get('/health').set('Origin', 'https://evil.example.com');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('sets a cross-origin Cross-Origin-Resource-Policy so a WKWebView fetch is not blocked reading the response', async () => {
    const res = await request(app).get('/health').set('Origin', 'capacitor://localhost');
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
  });
});
