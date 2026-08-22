import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Regression coverage for "Failed to stringify dev server logs. DevalueError:
// Cannot stringify arbitrary non-POJOs." — Nuxt's dev server forwards
// console.error/log/warn arguments made during SSR to the browser devtools
// using devalue, which can only serialize plain objects/primitives. The
// actual cause was useApi.ts's apiFetch() catch block logging the RAW
// caught `err` (an ofetch FetchError wrapping a Response/Headers) straight
// into console.error. This statically guards against that class of
// regression: every console.error call in useApi.ts's catch block must log
// a plain object literal (or primitives), never a bare error identifier.
describe('useApi.ts console logging never passes a raw error object', () => {
  const source = readFileSync(join(__dirname, '..', 'composables', 'useApi.ts'), 'utf-8');

  it('found at least one console.error call inside apiFetch (sanity check this test is not a no-op)', () => {
    expect(source).toMatch(/console\.error\(/);
  });

  it('every console.error call site logs an object literal or primitive, never a bare `err`/`error`/`normalized` identifier', () => {
    const consoleErrorCalls = [...source.matchAll(/console\.error\(([^;]*?)\);/gs)];
    expect(consoleErrorCalls.length).toBeGreaterThan(0);
    for (const match of consoleErrorCalls) {
      const args = match[1];
      // The second (and any later) argument must not be a bare reference to
      // the caught error — only a `{ ... }` object literal or a template
      // string/plain value is allowed. This is a deliberately narrow,
      // pattern-based guard (not full AST parsing) matching this
      // codebase's existing static-analysis test style.
      const afterFirstArg = args.split(/,(.+)/s)[1] ?? '';
      expect(afterFirstArg.trim()).not.toMatch(/^(err|error|normalized)\s*,?\s*$/);
    }
  });

  it('the normalized-error object logged to console only ever includes plain primitive fields (status/code/message)', () => {
    const loggedObjectMatch = source.match(/console\.error\([^,]+,\s*(\{[\s\S]*?\})\s*\);/);
    expect(loggedObjectMatch).not.toBeNull();
    const loggedObjectSource = loggedObjectMatch![1];
    // Only ever plain field: value pairs referencing normalized.<field> —
    // never the raw err/response/headers.
    expect(loggedObjectSource).toMatch(/status:/);
    expect(loggedObjectSource).toMatch(/code:/);
    expect(loggedObjectSource).toMatch(/message:/);
    expect(loggedObjectSource).not.toMatch(/\bresponse\b/);
    expect(loggedObjectSource).not.toMatch(/\bheaders\b/i);
  });
});

describe('pages/index.vue handles a failed AI Top Opportunities fetch without throwing', () => {
  const source = readFileSync(join(__dirname, '..', 'pages', 'index.vue'), 'utf-8');

  it('reads the useAsyncData error ref for the AI opportunities widget', () => {
    expect(source).toMatch(/error:\s*aiOpportunitiesError/);
  });

  it('renders a distinct "temporarily unavailable" state, separate from the generic empty state', () => {
    expect(source).toMatch(/aiOpportunitiesError/);
    expect(source).toMatch(/temporarily unavailable/i);
  });

  it('never interpolates the raw error ref directly into the template (only a derived, plain-string message)', () => {
    // A raw `{{ aiOpportunitiesError }}` (or `.message` accessed straight in
    // the template rather than through the computed) would risk rendering
    // "[object Object]" or leaking internals — must go through the computed.
    expect(source).not.toMatch(/\{\{\s*aiOpportunitiesError(\.message)?\s*\}\}/);
    expect(source).toMatch(/aiOpportunitiesErrorMessage/);
  });
});
