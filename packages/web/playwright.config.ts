import { defineConfig, devices } from '@playwright/test'

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3000'
const apiURL = process.env.PLAYWRIGHT_API_URL || 'http://127.0.0.1:8787'
const parsedApiURL = new URL(apiURL)

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 45_000,
  expect: {
    timeout: 8_000,
  },
  fullyParallel: false,
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
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        PLAYWRIGHT_MOCK_API_HOST: parsedApiURL.hostname,
        PLAYWRIGHT_MOCK_API_PORT: parsedApiURL.port || (parsedApiURL.protocol === 'https:' ? '443' : '80'),
      },
    },
    {
      command: `NUXT_PUBLIC_API_BASE_URL=${apiURL} NUXT_PUBLIC_APP_ENV=test NUXT_PUBLIC_SITE_URL=${baseURL} corepack pnpm exec nuxt dev --host 127.0.0.1 --port 3000`,
      url: baseURL,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        NUXT_PUBLIC_API_BASE_URL: apiURL,
        NUXT_PUBLIC_APP_ENV: 'test',
        NUXT_PUBLIC_SITE_URL: baseURL,
      },
    },
  ],
  projects: [
    {
      name: 'mobile-360',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 360, height: 740 },
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: 'tablet-768',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 768, height: 900 },
      },
    },
    {
      name: 'desktop-1024',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1024, height: 900 },
      },
    },
    {
      name: 'desktop-1440',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 1000 },
      },
    },
  ],
})
