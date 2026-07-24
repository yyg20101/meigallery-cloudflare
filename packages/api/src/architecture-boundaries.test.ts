import { readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('架构依赖边界', () => {
  it('Analytics 服务不能依赖转化事实服务', async () => {
    const source = await readFile(new URL('./services/analytics-ingest.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/from ['"].*services\/conversions['"]/)
    expect(source).not.toContain('recordConversionAction')
    expect(source).not.toContain('recordContact')
    expect(source).not.toContain('recordRegistration')
  })

  it('只有归因 Service Binding client 可以调用 ATTRIBUTION.fetch 和声明内部 URL', async () => {
    const root = fileURLToPath(new URL('.', import.meta.url))
    const files = (await collectTypeScriptSources(root))
      .filter(file => basename(file) !== 'attribution-service-client.ts')
    const violations: string[] = []

    for (const file of files) {
      const source = await readFile(file, 'utf8')
      if (
        /\bATTRIBUTION\s*\??\.\s*fetch\s*\(/.test(source)
        || source.includes('/internal/v1/')
      ) {
        violations.push(file.slice(root.length + 1))
      }
    }

    expect(violations).toEqual([])
  })

  it('注册路由只写业务 outbox，不再进入旧注册归因链路', async () => {
    const auth = await readFile(
      new URL('./routes/auth.ts', import.meta.url),
      'utf8',
    )
    const index = await readFile(
      new URL('./index.ts', import.meta.url),
      'utf8',
    )

    expect(auth).toContain('buildCompleteRegistrationOutboxStatement')
    expect(auth).not.toContain('recordRegistration')
    expect(auth).not.toContain('loadAttributionCryptoKeys')
    expect(auth).not.toContain('conversion_external_id')
    expect(index).not.toContain('recoverRegistrationConversionFacts')
  })
})

async function collectTypeScriptSources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const sources: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      sources.push(...await collectTypeScriptSources(path))
    } else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) {
      sources.push(path)
    }
  }
  return sources
}
