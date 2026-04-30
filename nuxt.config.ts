// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  // 兼容性日期
  compatibilityDate: '2024-11-01',

  // 开发工具
  devtools: { enabled: true },

  // 源码目录
  srcDir: 'app/',

  // Nitro 服务端引擎配置
  nitro: {
    // Cloudflare Pages 部署 preset
    preset: 'cloudflare-pages',

    // Cloudflare bindings（本地开发和生产共用）
    cloudflare: {
      pages: {
        routes: {
          exclude: ['/api/*'],
        },
      },
    },
  },

  // 路由规则：管理后台使用 CSR 模式
  routeRules: {
    '/admin/**': { ssr: false },
  },

  // 运行时配置
  runtimeConfig: {
    // 服务端私有
    sessionSecret: '',
    turnstileSecretKey: '',
    r2BucketName: '',
    streamAccountId: '',
    streamApiToken: '',

    // 客户端公开
    public: {
      appEnv: 'development',
      turnstileSiteKey: '',
      siteUrl: 'http://localhost:3000',
    },
  },

  // 模块
  modules: [],

  // TypeScript 严格模式
  typescript: {
    strict: true,
    typeCheck: false, // 开发时关闭以提升速度，CI 中启用
  },

  // Vue 编译器选项
  vue: {
    compilerOptions: {},
  },

  // Vite 配置
  vite: {
    // 优化依赖预构建
    optimizeDeps: {
      include: ['vue', 'vue-router'],
    },
  },
})
