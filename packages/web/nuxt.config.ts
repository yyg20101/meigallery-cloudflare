// https://nuxt.com/docs/api/configuration/nuxt-config
import { fileURLToPath } from 'node:url'
import { WEB_SECURITY_HEADERS } from './app/utils/securityHeaders'

const adminPageFile = (relativePath: string) => fileURLToPath(new URL(relativePath, import.meta.url))

export default defineNuxtConfig({
  compatibilityDate: '2026-05-26',

  devtools: { enabled: true },

  srcDir: 'app/',

  // Nitro 服务端引擎：部署为 Cloudflare Worker（ES Module 格式，支持 nodejs_compat）
  nitro: {
    preset: 'cloudflare-module',
    handlers: [
      { route: '/__release', handler: '~/server/routes/__release' },
      { route: '/robots.txt', handler: '~/server/routes/robots' },
      { route: '/sitemap.xml', handler: '~/server/routes/sitemap' },
    ],
  },

  // 页面过渡动画
  app: {
    pageTransition: { name: 'page', mode: 'out-in' },
    head: {
      htmlAttrs: { lang: 'zh-CN' },
      meta: [
        { charset: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'theme-color', content: '#111827' },
      ],
      link: [
        { rel: 'icon', type: 'image/x-icon', href: '/favicon.ico' },
      ],
    },
  },

  // 路由规则：管理后台使用 CSR
  routeRules: {
    '/**': { headers: WEB_SECURITY_HEADERS },
    '/admin/**': { ssr: false, headers: WEB_SECURITY_HEADERS },
    '/admin/attribution/duplicates': { redirect: '/admin/attribution', ssr: false, headers: WEB_SECURITY_HEADERS },
  },

  // 运行时配置
  runtimeConfig: {
    public: {
      apiBaseUrl: 'http://localhost:8787', // API Worker 地址，生产环境覆盖
      appEnv: 'development',
      turnstileSiteKey: '',
      siteUrl: 'http://localhost:3000',
      devAdminDataWarning: 'false',
    },
  },

  // 全局 CSS（Tailwind v4 + Nuxt UI）
  css: ['~/assets/css/main.css'],

  // 模块
  modules: [
    '@nuxt/ui',
  ],

  hooks: {
    'pages:extend'(pages) {
      // Figma 以 Page ID 定义独立验收 URL；同一业务域继续复用唯一权威工作台，
      // 避免为认证、会话、安全、钱包和通知复制第二套可写实现。
      pages.push(
        {
          name: 'admin-app-imports',
          path: '/admin/app/imports',
          file: adminPageFile('./app/pages/admin/import/index.vue'),
        },
        {
          name: 'admin-app-import-detail',
          path: '/admin/app/imports/:id',
          file: adminPageFile('./app/pages/admin/import/[id].vue'),
        },
        {
          name: 'admin-app-verification-review',
          path: '/admin/app/verifications/:personId',
          file: adminPageFile('./app/pages/admin/app/persons/[personId].vue'),
        },
        {
          name: 'admin-app-publication-review',
          path: '/admin/app/publications/:personId',
          file: adminPageFile('./app/pages/admin/app/persons/[personId].vue'),
        },
        {
          name: 'admin-app-conversation-detail',
          path: '/admin/app/conversations/:conversationId',
          file: adminPageFile('./app/pages/admin/app/conversations/index.vue'),
        },
        {
          name: 'admin-app-safety-reviews',
          path: '/admin/app/reviews',
          file: adminPageFile('./app/pages/admin/app/safety/index.vue'),
        },
        {
          name: 'admin-app-safety-review-detail',
          path: '/admin/app/reviews/:caseId',
          file: adminPageFile('./app/pages/admin/app/safety/index.vue'),
        },
        {
          name: 'admin-app-wallet-detail',
          path: '/admin/app/wallets/:accountId',
          file: adminPageFile('./app/pages/admin/app/wallets/index.vue'),
        },
        {
          name: 'admin-app-wallet-adjustment-new',
          path: '/admin/app/coin-adjustments/new',
          file: adminPageFile('./app/pages/admin/app/wallets/index.vue'),
        },
        {
          name: 'admin-app-wallet-adjustment-review',
          path: '/admin/app/coin-adjustments/:adjustmentId/review',
          file: adminPageFile('./app/pages/admin/app/wallets/index.vue'),
        },
        {
          name: 'admin-app-notification-events',
          path: '/admin/app/notifications/events',
          file: adminPageFile('./app/pages/admin/app/notifications/index.vue'),
        },
        {
          name: 'admin-app-notification-templates',
          path: '/admin/app/notifications/templates',
          file: adminPageFile('./app/pages/admin/app/notifications/index.vue'),
        },
        {
          name: 'admin-app-notification-template',
          path: '/admin/app/notifications/templates/:templateId',
          file: adminPageFile('./app/pages/admin/app/notifications/index.vue'),
        },
        {
          name: 'admin-app-notification-deliveries',
          path: '/admin/app/notifications/deliveries',
          file: adminPageFile('./app/pages/admin/app/notifications/index.vue'),
        },
      )
    },
  },

  // TypeScript
  typescript: {
    strict: true,
    typeCheck: false,
  },

  // Vite
  vite: {
    optimizeDeps: {
      include: ['vue', 'vue-router'],
    },
    build: {
      rollupOptions: {
        onwarn(warning, warn) {
          const message = typeof warning === 'string' ? warning : warning.message
          const id = typeof warning === 'string' ? '' : warning.id || ''
          const plugin = typeof warning === 'string' ? '' : warning.plugin || ''
          if (plugin === 'nuxt:module-preload-polyfill' && message.includes('Sourcemap is likely to be incorrect')) return
          if (id.includes('@vueuse/core/dist/index.js') && message.includes('#__PURE__')) return
          warn(warning)
        },
      },
    },
  },
})
