export default defineNuxtConfig({
  modules: ['@nuxtjs/tailwindcss'],
  css: ['~/assets/css/main.css'],

  typescript: {
    strict: true,
    typeCheck: false,
  },

  runtimeConfig: {
    public: {
      apiUrl: '',
      tradingMode: 'PAPER',
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
