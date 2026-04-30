// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2024-11-01',

  devtools: { enabled: true },

  srcDir: 'app/',

  // Nitro 服务端引擎：部署为 Cloudflare Worker（非 Pages）
  nitro: {
    preset: 'cloudflare',
  },

  // 路由规则：管理后台使用 CSR
  routeRules: {
    '/admin/**': { ssr: false },
  },

  // 运行时配置
  runtimeConfig: {
    public: {
      apiBaseUrl: 'http://localhost:8787', // API Worker 地址，生产环境覆盖
      appEnv: 'development',
      turnstileSiteKey: '',
      siteUrl: 'http://localhost:3000',
    },
  },

  // 模块
  modules: [
    '@nuxtjs/tailwindcss',
  ],

  // TypeScript
  typescript: {
    strict: true,
    typeCheck: false,
  },

  // Tailwind CSS
  tailwindcss: {
    cssPath: '~/assets/css/tailwind.css',
    configPath: 'tailwind.config.ts',
  },

  // Vite
  vite: {
    optimizeDeps: {
      include: ['vue', 'vue-router'],
    },
  },
})
