import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@meigallery/shared/constants': resolve(__dirname, '../shared/src/constants/index.ts'),
      '@meigallery/shared': resolve(__dirname, '../shared/src/types/index.ts'),
    },
  },
})
