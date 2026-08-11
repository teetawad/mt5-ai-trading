import vuePlugin from 'eslint-plugin-vue';
import vueParser from 'vue-eslint-parser';
import tsParser from '@typescript-eslint/parser';

export default [
  ...vuePlugin.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tsParser,
        sourceType: 'module',
      },
    },
    rules: {
      'vue/multi-word-component-names': 'off',
      // Nuxt auto-imports (defineNuxtConfig, useRoute, etc.) are invisible to ESLint;
      // TypeScript handles undefined-variable checking for TS/Vue files.
      'no-undef': 'off',
      // Stylistic: allow <p>inline text</p> on one line
      'vue/singleline-html-element-content-newline': 'off',
    },
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        sourceType: 'module',
      },
    },
    rules: {
      // TypeScript handles undefined-variable errors for .ts files.
      // ESLint no-undef cannot see Nuxt server auto-imports (defineEventHandler, etc.).
      'no-undef': 'off',
    },
  },
  {
    ignores: ['.nuxt/**', '.output/**', 'node_modules/**', 'dist/**'],
  },
];
