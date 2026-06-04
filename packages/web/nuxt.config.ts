// https://nuxt.com/docs/api/configuration/nuxt-config
import { WEB_SECURITY_HEADERS } from './app/utils/securityHeaders'

export default defineNuxtConfig({
  compatibilityDate: '2026-05-26',

  devtools: { enabled: true },

  srcDir: 'app/',

  // Nitro 服务端引擎：部署为 Cloudflare Worker（ES Module 格式，支持 nodejs_compat）
  nitro: {
    preset: 'cloudflare-module',
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
  },

  // 运行时配置
  runtimeConfig: {
    public: {
      apiBaseUrl: 'http://localhost:8787', // API Worker 地址，生产环境覆盖
      appEnv: 'development',
      turnstileSiteKey: '',
      siteUrl: 'http://localhost:3000',
      facebookPixelAllowDev: 'false',
      facebookPixelDevId: '',
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
  },
})
