import { describe, it, expect, beforeEach } from 'vitest';
import { signToken, verifyToken } from '../../auth/tokens';
import { _clearDenylistForTest, denyToken, isTokenDenied } from '../../auth/denylist';

const SECRET = 'test-secret-for-unit-tests-not-real';

beforeEach(() => {
  process.env.SESSION_SECRET = SECRET;
  _clearDenylistForTest();
});

describe('signToken / verifyToken', () => {
  it('signs and verifies a valid token', () => {
    const token = signToken({ sub: 'user-1', email: 'owner@example.com', role: 'owner' });
    const decoded = verifyToken(token);
    expect(decoded.sub).toBe('user-1');
    expect(decoded.email).toBe('owner@example.com');
    expect(decoded.role).toBe('owner');
    expect(decoded.jti).toBeDefined();
    expect(decoded.exp).toBeGreaterThan(Date.now() / 1000);
  });

  it('throws on a token signed with a different secret', () => {
    process.env.SESSION_SECRET = 'first-secret';
    const token = signToken({ sub: 'user-1', email: 'a@b.com', role: 'owner' });
    process.env.SESSION_SECRET = 'different-secret';
    expect(() => verifyToken(token)).toThrow();
  });

  it('throws on a tampered token', () => {
    const token = signToken({ sub: 'user-1', email: 'a@b.com', role: 'owner' });
    const tampered = token.slice(0, -5) + 'XXXXX';
    expect(() => verifyToken(tampered)).toThrow();
  });

  it('includes a unique jti on each sign', () => {
    const t1 = signToken({ sub: 'u', email: 'a@b.com', role: 'owner' });
    const t2 = signToken({ sub: 'u', email: 'a@b.com', role: 'owner' });
    expect(verifyToken(t1).jti).not.toBe(verifyToken(t2).jti);
  });
});

describe('denylist', () => {
  it('isTokenDenied returns false for a token not in the list', () => {
    expect(isTokenDenied('some-jti')).toBe(false);
  });

  it('isTokenDenied returns true after denyToken', () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    denyToken('jti-abc', exp);
    expect(isTokenDenied('jti-abc')).toBe(true);
  });

  it('denying same jti twice does not throw', () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    expect(() => { denyToken('jti-x', exp); denyToken('jti-x', exp); }).not.toThrow();
  });
});
