import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('架构依赖边界', () => {
  it('Analytics 服务不能依赖转化事实服务', async () => {
    const source = await readFile(new URL('./services/analytics-ingest.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/from ['"].*services\/conversions['"]/)
    expect(source).not.toContain('recordConversionAction')
    expect(source).not.toContain('recordContact')
    expect(source).not.toContain('recordRegistration')
  })
})
