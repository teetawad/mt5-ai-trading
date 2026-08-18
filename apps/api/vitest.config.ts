import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Multiple test files share one real Postgres test database with
    // unscoped tables (e.g. trade_outcomes) — running files in parallel lets
    // one file's DELETE/INSERT race another's, causing flaky failures.
    fileParallelism: false,
  },
});
