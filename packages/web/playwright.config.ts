import { defineConfig, devices } from '@playwright/test'

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3100'
const apiURL = process.env.PLAYWRIGHT_API_URL || 'http://127.0.0.1:8788'
const parsedBaseURL = new URL(baseURL)
const parsedApiURL = new URL(apiURL)
const reuseServer = process.env.PLAYWRIGHT_REUSE_SERVER === 'true' && !process.env.CI

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 45_000,
  expect: {
    timeout: 8_000,
  },
  fullyParallel: false,
  // smoke 测试共用一个 mock API 状态；串行执行可避免跨 viewport 的 reset / PATCH 互相抢状态。
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'node tests/e2e/mock-api.mjs',
      url: `${apiURL}/api/health`,
      reuseExistingServer: reuseServer,
      timeout: 60_000,
      env: {
        PLAYWRIGHT_MOCK_API_HOST: parsedApiURL.hostname,
        PLAYWRIGHT_MOCK_API_PORT: parsedApiURL.port || (parsedApiURL.protocol === 'https:' ? '443' : '80'),
        PLAYWRIGHT_ALLOWED_ORIGIN: baseURL,
      },
    },
    {
      command: `NUXT_PUBLIC_API_BASE_URL=${apiURL} NUXT_PUBLIC_APP_ENV=test NUXT_PUBLIC_SITE_URL=${baseURL} NUXT_PUBLIC_DEV_ADMIN_DATA_WARNING=true corepack pnpm exec nuxt dev --host ${parsedBaseURL.hostname} --port ${parsedBaseURL.port || (parsedBaseURL.protocol === 'https:' ? '443' : '80')}`,
      url: baseURL,
      reuseExistingServer: reuseServer,
      timeout: 120_000,
      env: {
        NUXT_PUBLIC_API_BASE_URL: apiURL,
        NUXT_PUBLIC_APP_ENV: 'test',
        NUXT_PUBLIC_SITE_URL: baseURL,
        NUXT_PUBLIC_DEV_ADMIN_DATA_WARNING: 'true',
      },
    },
  ],
  projects: [
    {
      name: 'chromium',
      grepInvert: /@responsive/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile-360',
      grep: /@responsive/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 360, height: 740 },
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: 'tablet-768',
      grep: /@responsive/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 768, height: 900 },
      },
    },
    {
      name: 'desktop-1440',
      grep: /@responsive/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 1000 },
      },
    },
  ],
})
