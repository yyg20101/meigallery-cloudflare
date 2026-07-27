// https://nuxt.com/docs/api/configuration/nuxt-config
import { WEB_SECURITY_HEADERS } from './app/utils/securityHeaders'

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
