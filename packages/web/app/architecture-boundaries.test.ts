import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { cwd } from 'node:process'
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

const appDir = join(cwd(), 'app')
const guardedDirs = ['pages', 'components', 'layouts', 'plugins'].map(name => join(appDir, name))
const forbidden = [
  /useFacebookPixel\s*\(/,
  /useConversionTracking\s*\(/,
  /from ['"]~\/adapters\/metaPixel\.client['"]/,
  /window\.fbq/,
]

function collectSourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) return collectSourceFiles(fullPath)
    return entry.isFile() && /\.(?:ts|vue)$/.test(entry.name) ? [fullPath] : []
  })
}

describe('Web Tracking 架构边界', () => {
  it('旧 Tracking 兼容入口和 Pixel utility 已删除', () => {
    const obsoletePaths = [
      'composables/useConversionTracking.ts',
      'composables/useConversionTracking.test.ts',
      'composables/useFacebookPixel.ts',
      'utils/facebookPixel.ts',
      'utils/facebookPixel.test.ts',
    ]

    expect(obsoletePaths.filter(filePath => existsSync(join(appDir, filePath)))).toEqual([])
  })

  it('页面、组件、layout 和 plugin 不绕过 Tracking Facade', () => {
    const violations = guardedDirs.flatMap(collectSourceFiles).flatMap((filePath) => {
      const source = readFileSync(filePath, 'utf8')
      return forbidden
        .filter(pattern => pattern.test(source))
        .map(pattern => `${relative(appDir, filePath)}: ${pattern.source}`)
    })

    expect(violations).toEqual([])
  })

  it('只有 useTracking 和测试可以导入 Meta Pixel adapter', () => {
    const violations = collectSourceFiles(appDir)
      .filter(filePath => !filePath.endsWith('.test.ts'))
      .filter(filePath => /(?:from|import\()\s*['"]~\/adapters\/metaPixel\.client['"]/.test(readFileSync(filePath, 'utf8')))
      .map(filePath => relative(appDir, filePath))

    expect(violations).toEqual(['composables/useTracking.ts'])
  })

  it('ESLint 拒绝受保护源码直接导入 Meta Pixel adapter', async () => {
    const projectRoot = resolve(cwd(), '../..')
    const eslint = new ESLint({ cwd: projectRoot })
    const [result] = await eslint.lintText(
      "import { metaPixelAdapter } from '~/adapters/metaPixel.client'\nvoid metaPixelAdapter\n",
      { filePath: join(projectRoot, 'packages/web/app/pages/architecture-fixture.ts') },
    )

    expect(result?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: 'no-restricted-imports', severity: 2 }),
    ]))
  })
})
