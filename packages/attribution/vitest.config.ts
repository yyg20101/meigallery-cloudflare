import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@meigallery/shared/utils': resolve(
        __dirname,
        '../shared/src/utils/index.ts',
      ),
      '@meigallery/shared': resolve(__dirname, '../shared/src/types/index.ts'),
      'cloudflare:workers': resolve(
        __dirname,
        'src/test/cloudflare-workers.ts',
      ),
    },
  },
})
