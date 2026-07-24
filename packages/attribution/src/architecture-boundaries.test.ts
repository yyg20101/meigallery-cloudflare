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
