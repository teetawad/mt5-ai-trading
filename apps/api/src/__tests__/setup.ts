// Global vitest setup (see apps/api/vitest.config.ts setupFiles). Runs once
// before any test file. Fixes a real bug class: several suites call
// signToken()/verifyToken() directly (not through POST /auth/login), which
// requires SESSION_SECRET - a handful of files set it themselves in
// beforeAll, but any suite that doesn't (e.g. trading-ai-routes.test.ts) was
// silently relying on another file having already set it first in the same
// worker process (fileParallelism: false shares one process across files).
// That's a real ordering bug, not something to paper over per-file: setting
// a fixed test-only value here, once, for every run removes the ordering
// dependency entirely. This is never read outside of `vitest run` and has no
// bearing on production security - production always requires a real
// SESSION_SECRET from the environment (see apps/api/src/auth/tokens.ts).
process.env.SESSION_SECRET ??= 'test-only-session-secret-do-not-use-in-production';
