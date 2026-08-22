import type { CapacitorConfig } from '@capacitor/cli';

// Points at the static Nuxt SPA build (npm run build:mobile), not the Node/SSR
// output - Capacitor's WKWebView loads these files directly from disk, it
// cannot run a Node server. Never point webDir at anything that assumes a
// live localhost:3000/4000 - the API base URL is configured separately via
// NUXT_PUBLIC_API_URL at build time (see apps/web/composables/useApi.ts).
const config: CapacitorConfig = {
  appId: 'com.aidemolab.mt5demo',
  appName: 'AI Demo Lab',
  webDir: '.output/public',
};

export default config;
