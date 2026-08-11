/**
 * In-memory JWT denylist for logout invalidation.
 *
 * Acceptable for single-owner paper trading: the denylist is very small
 * (one entry per logout) and a server restart re-requires login anyway.
 * A future multi-user or persistent-session requirement would replace this
 * with a PostgreSQL or Redis-backed store.
 *
 * Expired JTIs are pruned lazily on each add to prevent unbounded growth.
 */

interface DenyEntry {
  exp: number;   // unix epoch seconds
}

const _denied = new Map<string, DenyEntry>();

export function denyToken(jti: string, exp: number): void {
  pruneExpired();
  _denied.set(jti, { exp });
}

export function isTokenDenied(jti: string): boolean {
  return _denied.has(jti);
}

function pruneExpired(): void {
  const now = Math.floor(Date.now() / 1000);
  for (const [jti, entry] of _denied) {
    if (entry.exp < now) _denied.delete(jti);
  }
}

// Only for use in tests
export function _clearDenylistForTest(): void {
  _denied.clear();
}
