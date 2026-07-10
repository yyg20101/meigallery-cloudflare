import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { cwd } from 'node:process'
import { describe, expect, it } from 'vitest'

const pagesDir = join(cwd(), 'app/pages')
const forbidden = [
  /useMarketingConsent\s*\(/,
  /readMetaBrowserIdentifiers/,
  /document\.cookie/,
  /window\.fbq/,
  /from ['"]~\/adapters\/metaPixel\.client['"]/,
]

function collectVueFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) return collectVueFiles(fullPath)
    return entry.isFile() && entry.name.endsWith('.vue') ? [fullPath] : []
  })
}

describe('页面 Tracking 架构边界', () => {
  it('页面不直接读取营销授权、浏览器标识或 Pixel adapter', () => {
    const violations = collectVueFiles(pagesDir).flatMap((filePath) => {
      const source = readFileSync(filePath, 'utf8')
      return forbidden
        .filter(pattern => pattern.test(source))
        .map(pattern => `${relative(pagesDir, filePath)}: ${pattern.source}`)
    })

    expect(violations).toEqual([])
  })
})
