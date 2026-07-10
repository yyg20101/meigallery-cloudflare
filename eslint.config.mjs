import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import vue from 'eslint-plugin-vue'
import vueParser from 'vue-eslint-parser'

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/.nuxt/**',
      '**/.output/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.wrangler/**',
      '**/.wrangler-*/**',
      'scripts/**',
      'docs/superpowers/**',
    ],
  },
  {
    files: ['packages/**/*.{ts,mts,cts,js,mjs,cjs}'],
    ...js.configs.recommended,
  },
  ...tseslint.configs.recommended.map(config => ({
    ...config,
    files: ['packages/**/*.{ts,mts,cts,js,mjs,cjs,vue}'],
  })),
  ...vue.configs['flat/recommended'].map(config => ({
    ...config,
    files: ['packages/web/**/*.vue'],
  })),
  {
    files: ['packages/**/*.{ts,mts,cts,js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2022,
        D1Database: 'readonly',
        ExecutionContext: 'readonly',
        R2Bucket: 'readonly',
        R2ObjectBody: 'readonly',
        SendEmail: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      'no-console': 'off',
      'no-undef': 'off',
      'no-useless-assignment': 'warn',
      'no-useless-escape': 'warn',
      'prefer-const': 'warn',
    },
  },
  {
    files: ['packages/web/**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tseslint.parser,
        ecmaVersion: 2022,
        sourceType: 'module',
        extraFileExtensions: ['.vue'],
      },
      globals: {
        ...globals.browser,
        computed: 'readonly',
        definePageMeta: 'readonly',
        nextTick: 'readonly',
        onMounted: 'readonly',
        onUnmounted: 'readonly',
        ref: 'readonly',
        useApi: 'readonly',
        useAsyncData: 'readonly',
        useAuth: 'readonly',
        useHead: 'readonly',
        useRuntimeConfig: 'readonly',
        useSeoMeta: 'readonly',
        useSiteSettings: 'readonly',
        watch: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      'no-undef': 'off',
      'no-useless-assignment': 'warn',
      'no-useless-escape': 'warn',
      'vue/multi-word-component-names': 'off',
      'vue/no-v-html': 'off',
      'vue/require-default-prop': 'off',
      'vue/attributes-order': 'off',
      'vue/first-attribute-linebreak': 'off',
      'vue/html-closing-bracket-newline': 'off',
      'vue/html-closing-bracket-spacing': 'off',
      'vue/html-indent': 'off',
      'vue/html-self-closing': 'off',
      'vue/max-attributes-per-line': 'off',
      'vue/multiline-html-element-content-newline': 'off',
      'vue/singleline-html-element-content-newline': 'off',
    },
  },
  {
    files: ['packages/web/app/{pages,components,layouts,plugins}/**/*.{ts,vue}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          '~/adapters/metaPixel.client',
          '**/adapters/metaPixel.client',
          '~/composables/useConversionTracking',
          '**/composables/useConversionTracking',
          '~/composables/useFacebookPixel',
          '**/composables/useFacebookPixel',
        ],
      }],
    },
  },
]
