import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

const META_COVERAGE_FILES = [
  'src/utils/conversions.ts',
  'src/utils/pixel-receipt.ts',
  'src/utils/meta-browser-identifiers.ts',
  'src/services/conversions.ts',
  'src/services/meta-capi.ts',
  'src/services/meta-capi-queue.ts',
  'src/routes/conversions.ts',
  'src/routes/admin/attribution.ts',
]

const META_COVERAGE_GLOB = 'src/{utils/conversions,utils/pixel-receipt,utils/meta-browser-identifiers,services/conversions,services/meta-capi,services/meta-capi-queue,routes/conversions,routes/admin/attribution}.ts'

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
        ...META_COVERAGE_FILES,
      ],
      thresholds: {
        statements: 70,
        branches: 65,
        functions: 75,
        lines: 75,
        [META_COVERAGE_GLOB]: {
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
    },
  },
})
