// Two build targets share this one config: the normal SSR/Node web build
// (default), and a static SPA build for Capacitor iOS (NUXT_BUILD_TARGET=capacitor).
// Capacitor's WKWebView loads compiled files directly from disk - it can't run
// a Node/Nitro server - so that target needs ssr:false + a static generate,
// plus a viewport tag that respects the iOS safe area (viewport-fit=cover).
const isCapacitorBuild = process.env.NUXT_BUILD_TARGET === 'capacitor';

// Fail the mobile build immediately at build time - not just at runtime when
// someone opens the app - if it's about to ship a production-shaped iOS
// bundle pointed at plain HTTP (a LAN IP or bare localhost). LAN HTTP is a
// legitimate dev-only setup (see docs/MOBILE_IOS.md), so it requires
// explicitly opting in via NUXT_PUBLIC_ALLOW_INSECURE_MOBILE_API=true rather
// than being silently allowed. Mirrors the runtime guard in
// composables/useApi.ts (validateMobileApiUrl) for defense in depth.
if (isCapacitorBuild) {
  const apiUrl = process.env.NUXT_PUBLIC_API_URL;
  const allowInsecure = process.env.NUXT_PUBLIC_ALLOW_INSECURE_MOBILE_API === 'true';
  if (!apiUrl) {
    throw new Error('NUXT_PUBLIC_API_URL is not set - the Capacitor build cannot fall back to localhost.');
  }
  if (!apiUrl.startsWith('https://') && !allowInsecure) {
    throw new Error(
      `NUXT_PUBLIC_API_URL (${apiUrl}) must be https:// for a Capacitor build. For LAN device testing only, set NUXT_PUBLIC_ALLOW_INSECURE_MOBILE_API=true.`,
    );
  }
}

export default defineNuxtConfig({
  modules: ['@nuxtjs/tailwindcss'],
  css: ['~/assets/css/main.css'],

  ssr: !isCapacitorBuild,

  typescript: {
    strict: true,
    typeCheck: false,
  },

  runtimeConfig: {
    public: {
      apiUrl: '',
      tradingMode: 'PAPER',
      buildTarget: isCapacitorBuild ? 'capacitor' : 'web',
      allowInsecureMobileApi: false,
    },
  },

  // PWA fallback (spec: "Add to Home Screen" from iPhone Safari before a
  // native IPA/TestFlight build is available - see docs/MOBILE_IOS.md
  // Workflow B). Deliberately meta-tags + a manifest only, no service worker:
  // iOS Safari's classic "Add to Home Screen" -> standalone mode has never
  // required a service worker or HTTPS, and this app must never risk a
  // Workbox cache serving stale trade/price data. Skipped entirely for the
  // Capacitor build - the native shell IS the installed app already, and its
  // icon/launch screen come from Info.plist, not this manifest.
  app: {
    head: {
      viewport: 'width=device-width, initial-scale=1, viewport-fit=cover',
      link: isCapacitorBuild
        ? []
        : [
            { rel: 'manifest', href: '/manifest.webmanifest' },
            { rel: 'apple-touch-icon', href: '/icons/icon-180.png' },
          ],
      meta: isCapacitorBuild
        ? []
        : [
            { name: 'theme-color', content: '#020617' },
            { name: 'apple-mobile-web-app-capable', content: 'yes' },
            { name: 'apple-mobile-web-app-status-bar-style', content: 'black-translucent' },
            { name: 'apple-mobile-web-app-title', content: 'AI Demo Lab' },
          ],
    },
  },

  devtools: { enabled: false },

  // Disabled: the client-side mock for this virtual module fails to resolve
  // in dev under this Nuxt/Vite combination (Vite's per-environment plugin
  // API doesn't register the `#app-manifest` alias for the client bundle),
  // causing a blank screen. This app has no prerendered routes, so the
  // manifest (used for prerender/route-rules lookups) isn't needed.
  experimental: {
    appManifest: false,
  },

  compatibilityDate: '2024-11-01',
});
