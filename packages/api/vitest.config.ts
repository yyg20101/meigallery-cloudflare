import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

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
        'src/middleware/auth.ts',
        'src/middleware/rate-limit.ts',
      ],
      thresholds: {
        statements: 70,
        branches: 65,
        functions: 75,
        lines: 75,
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
