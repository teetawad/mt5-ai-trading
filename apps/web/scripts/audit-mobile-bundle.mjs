#!/usr/bin/env node
// Fails the mobile build if any server-only secret value ever ends up in the
// static bundle Capacitor ships inside the iOS app. Run automatically after
// `nuxt generate` by `npm run build:mobile` (apps/web/package.json).
// Scan logic lives in scanBundleForSecrets() so tests (see
// apps/web/tests/mobile-capacitor.test.ts) can exercise it against a fixture
// directory without needing a real build output.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Names of env vars that must never appear in client-shipped output.
export const FORBIDDEN_VAR_NAMES = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'DATABASE_URL',
  'TEST_DATABASE_URL',
  'SESSION_SECRET',
  'INTERNAL_SERVICE_TOKEN',
  'MT5_ALLOWED_DEMO_LOGIN',
  'MT5_ALLOWED_DEMO_SERVER',
  'POSTGRES_PASSWORD',
];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

export function scanBundleForSecrets(bundleDir) {
  const files = walk(bundleDir).filter((f) => /\.(js|mjs|html|css|json|txt)$/i.test(f));
  const hits = [];
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    for (const name of FORBIDDEN_VAR_NAMES) {
      if (content.includes(name)) {
        hits.push({ file, name });
      }
    }
  }
  return { files, hits };
}

async function main() {
  const bundleDir = process.argv[2] ?? join(import.meta.dirname, '..', '.output', 'public');

  let result;
  try {
    result = scanBundleForSecrets(bundleDir);
  } catch (err) {
    console.error(`[audit-mobile-bundle] Could not read build output at ${bundleDir}. Did "nuxt generate" run first?`);
    console.error(err);
    process.exit(1);
  }

  if (result.hits.length > 0) {
    console.error('[audit-mobile-bundle] FAILED - forbidden secret references found in mobile bundle:');
    for (const hit of result.hits) {
      console.error(`  ${hit.name} in ${hit.file}`);
    }
    process.exit(1);
  }

  console.log(`[audit-mobile-bundle] OK - scanned ${result.files.length} files, no forbidden secret references found.`);
}

// Only run as a CLI when invoked directly (node scripts/audit-mobile-bundle.mjs),
// not when imported by the test suite.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
