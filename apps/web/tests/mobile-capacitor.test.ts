import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, afterEach } from 'vitest';
import { scanBundleForSecrets, FORBIDDEN_VAR_NAMES } from '../scripts/audit-mobile-bundle.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const layoutPath = join(__dirname, '..', 'layouts', 'default.vue');
const tokenStoragePath = join(__dirname, '..', 'composables', 'useTokenStorage.ts');
const nuxtConfigPath = join(__dirname, '..', 'nuxt.config.ts');
const manifestPath = join(__dirname, '..', 'public', 'manifest.webmanifest');

// Static-scan regression coverage (same style as navigation-lazy-data.test.ts)
// for the mobile UI pieces added for Capacitor: a real bottom tab bar and iOS
// safe-area handling, not just a wrapping flex row (see apps/web/layouts/default.vue).
describe('mobile layout', () => {
  const source = readFileSync(layoutPath, 'utf8');

  it('has a fixed bottom nav shown only below the lg breakpoint', () => {
    expect(source).toMatch(/mobile-bottom-nav/);
    expect(source).toMatch(/lg:hidden/);
  });

  it('applies safe-area padding for the notch and home indicator', () => {
    expect(source).toMatch(/safe-top/);
    expect(source).toMatch(/mobile-bottom-nav|safe-bottom/);
  });

  it('keeps the desktop nav intact, gated to lg and up', () => {
    expect(source).toMatch(/class="[^"]*\bhidden\b[^"]*\blg:block\b[^"]*"/);
  });
});

describe('secure token storage', () => {
  const source = readFileSync(tokenStoragePath, 'utf8');

  it('uses a Keychain-backed secure storage plugin, not plain @capacitor/preferences', () => {
    expect(source).toMatch(/^import.*@aparajita\/capacitor-secure-storage/m);
    expect(source).not.toMatch(/^import.*@capacitor\/preferences/m);
  });

  it('never logs the token value itself', () => {
    // Any console.* call in this file must not reference the token
    // variables directly (only success/failure may be logged).
    const consoleCalls = source.match(/console\.\w+\([^)]*\)/g) ?? [];
    for (const call of consoleCalls) {
      expect(call).not.toMatch(/\btoken\b/i);
    }
  });

  it('gates every native call behind isNative(), so plain web never touches the plugin', () => {
    expect(source).toMatch(/isNative\(\)/);
  });
});

describe('PWA fallback (Add to Home Screen)', () => {
  it('ships a valid web app manifest with the required installable fields', () => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(manifest.display).toBe('standalone');
    expect(manifest.name).toBeTruthy();
    expect(Array.isArray(manifest.icons)).toBe(true);
    expect(manifest.icons.length).toBeGreaterThan(0);
  });

  it('nuxt.config.ts wires up the manifest and apple meta tags only for the web build, not Capacitor', () => {
    const configSource = readFileSync(nuxtConfigPath, 'utf8');
    expect(configSource).toMatch(/manifest\.webmanifest/);
    expect(configSource).toMatch(/apple-mobile-web-app-capable/);
    expect(configSource).toMatch(/isCapacitorBuild\s*\?\s*\[\]/);
  });
});

describe('scanBundleForSecrets (mobile bundle secret audit)', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('passes on a clean bundle', () => {
    dir = mkdtempSync(join(tmpdir(), 'mobile-bundle-clean-'));
    writeFileSync(join(dir, 'index.html'), '<html><body>hello</body></html>');
    writeFileSync(join(dir, 'app.js'), 'console.log("no secrets here")');

    const result = scanBundleForSecrets(dir);
    expect(result.hits).toEqual([]);
    expect(result.files.length).toBe(2);
  });

  it('fails when a forbidden secret name leaks into a bundled file', () => {
    dir = mkdtempSync(join(tmpdir(), 'mobile-bundle-leak-'));
    writeFileSync(join(dir, 'app.js'), `const key = "${FORBIDDEN_VAR_NAMES[0]}=sk-leaked";`);

    const result = scanBundleForSecrets(dir);
    expect(result.hits).toEqual([{ file: join(dir, 'app.js'), name: FORBIDDEN_VAR_NAMES[0] }]);
  });
});
