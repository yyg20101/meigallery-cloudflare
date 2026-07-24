import { expect, it } from 'vitest'

const sources = import.meta.glob('./**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
})

it('归因运行时不导入业务 API 或 Git 发布身份', () => {
  for (const [path, source] of Object.entries(sources)) {
    if (path.endsWith('/architecture-boundaries.test.ts')) continue

    expect(String(source), path).not.toMatch(
      /packages\/api|@meigallery\/api/,
    )
    expect(String(source), path).not.toMatch(
      /RELEASE_COMMIT|verifiedCommit/,
    )
  }
})

it('候选验证不直连平台且只能复用 Fact、Queue 和 Adapter', () => {
  const source = String(
    sources['./services/validation-service.ts'] ?? '',
  )
  expect(source).not.toMatch(
    /graph\.facebook\.com|business-api\.tiktok\.com|datamanager\.googleapis\.com/,
  )
  expect(source).not.toMatch(/\bfetch\s*\(/)
  expect(source).toMatch(/recordCandidateSyntheticFact/)
  expect(source).toMatch(/enqueueServerDelivery/)
})
