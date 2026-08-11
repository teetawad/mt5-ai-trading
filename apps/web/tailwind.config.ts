import type { Config } from 'tailwindcss';

export default {
  content: [
    './components/**/*.{js,vue,ts}',
    './layouts/**/*.vue',
    './pages/**/*.vue',
    './app.vue',
    './server/api/**/*.ts',
  ],
  theme: {
    extend: {},
  },
  plugins: [],
} satisfies Config;
