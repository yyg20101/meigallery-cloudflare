import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

const AD_PLATFORM_COVERAGE_FILES = [
  'src/utils/conversions.ts',
  'src/utils/pixel-receipt.ts',
  'src/utils/ad-platform-identifiers.ts',
  'src/utils/secure-context-crypto.ts',
  'src/services/ad-platform/secure-outbox.ts',
  'src/services/ad-platform/queue-runtime.ts',
  'src/services/ad-platform/recovery.ts',
  'src/services/conversions.ts',
  'src/services/meta-capi.ts',
  'src/services/tiktok-connection.ts',
  'src/services/tiktok-events.ts',
  'src/services/tiktok-events-delivery.ts',
  'src/routes/conversions.ts',
  'src/routes/admin/ad-platforms.ts',
  'src/routes/admin/attribution.ts',
]

const AD_PLATFORM_COVERAGE_GLOB = 'src/{utils/conversions,utils/pixel-receipt,utils/ad-platform-identifiers,utils/secure-context-crypto,services/ad-platform/secure-outbox,services/ad-platform/queue-runtime,services/ad-platform/recovery,services/conversions,services/meta-capi,services/tiktok-connection,services/tiktok-events,services/tiktok-events-delivery,routes/conversions,routes/admin/ad-platforms,routes/admin/attribution}.ts'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      reporter: ['text', 'html', 'json-summary'],
      include: [
        'src/utils/password.ts',
        'src/utils/session.ts',
        'src/utils/permission.ts',
        'src/utils/membership.ts',
        'src/utils/import-validation.ts',
        'src/utils/import-token.ts',
        'src/utils/api-error.ts',
        'src/services/email-verification.ts',
        'src/middleware/auth.ts',
        'src/middleware/rate-limit.ts',
        ...AD_PLATFORM_COVERAGE_FILES,
      ],
      thresholds: {
        statements: 70,
        branches: 65,
        functions: 75,
        lines: 75,
        [AD_PLATFORM_COVERAGE_GLOB]: {
          statements: 85,
          branches: 80,
          functions: 85,
          lines: 85,
        },
      },
    },
  },
  resolve: {
    alias: {
      '@meigallery/shared/constants': resolve(__dirname, '../shared/src/constants/index.ts'),
      '@meigallery/shared/utils': resolve(__dirname, '../shared/src/utils/index.ts'),
      '@meigallery/shared': resolve(__dirname, '../shared/src/types/index.ts'),
      'cloudflare:workers': resolve(__dirname, 'src/test/cloudflare-workers.ts'),
    },
  },
})
