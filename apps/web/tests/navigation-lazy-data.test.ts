import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Root-cause regression coverage for the "clicking Home doesn't render Home"
// bug: every page in pages/ is wrapped by <NuxtPage> inside a <Suspense>
// boundary. A page's top-level `await useAsyncData(...)` call in <script
// setup> is BLOCKING by default - Nuxt's Suspense boundary keeps rendering
// the PREVIOUS page's content, with no loading indicator, for as long as
// that fetch takes to settle. Verified via a real headless-Chrome
// client-side-navigation reproduction: with a blocking (non-lazy)
// useAsyncData call, clicking Home from any other page left the previous
// page's content on screen indefinitely (URL/router state updated
// correctly; the rendered component never swapped) whenever the API was
// slow, unreachable, or multiple sequential awaits stacked up - exactly the
// reported symptom. Passing `{ lazy: true }` (or using useLazyAsyncData)
// makes the awaited call resolve immediately on client-side navigation, so
// <NuxtPage> mounts the new route right away and the fetch fills in
// reactively afterward. This test statically enforces that invariant across
// every page so a newly added blocking call can't reintroduce the bug.
const pagesDir = join(__dirname, '..', 'pages');

function collectVueFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectVueFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.vue')) files.push(full);
  }
  return files;
}

function findAsyncDataCalls(source: string): Array<{ name: string; body: string }> {
  const calls: Array<{ name: string; body: string }> = [];
  const callStartPattern = /\b(useAsyncData|useLazyAsyncData)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = callStartPattern.exec(source))) {
    const name = match[1];
    let depth = 1;
    let i = match.index + match[0].length;
    const start = i;
    while (i < source.length && depth > 0) {
      if (source[i] === '(') depth++;
      else if (source[i] === ')') depth--;
      i++;
    }
    calls.push({ name, body: source.slice(start, i - 1) });
  }
  return calls;
}

describe('page-level useAsyncData must not block client-side navigation', () => {
  const vueFiles = collectVueFiles(pagesDir);
  // Sanity check that this test is actually scanning something, so a future
  // refactor of the pages directory can't silently make this suite a no-op.
  it('found at least one page to scan', () => {
    expect(vueFiles.length).toBeGreaterThan(0);
  });

  for (const file of vueFiles) {
    const relativePath = file.slice(pagesDir.length + 1).replace(/\\/g, '/');
    const source = readFileSync(file, 'utf8');
    const calls = findAsyncDataCalls(source);
    if (calls.length === 0) continue;

    it(`${relativePath}: every useAsyncData call is lazy`, () => {
      for (const call of calls) {
        const isLazyVariant = call.name === 'useLazyAsyncData';
        const hasLazyOption = /lazy\s*:\s*true/.test(call.body);
        expect(
          isLazyVariant || hasLazyOption,
          `${relativePath} calls ${call.name}(${call.body.slice(0, 80)}...) without { lazy: true } - ` +
            'this blocks <Suspense> during client-side navigation and can freeze the page on the previous route.',
        ).toBe(true);
      }
    });
  }
});
