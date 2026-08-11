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

  compatibilityDate: '2024-11-01',
});
