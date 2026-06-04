import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { cwd } from 'node:process'
import { describe, expect, it } from 'vitest'

const appDir = join(cwd(), 'app')

function collectVueFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) return collectVueFiles(fullPath)
    return entry.isFile() && entry.name.endsWith('.vue') ? [fullPath] : []
  })
}

function lineNumberOf(source: string, index: number) {
  return source.slice(0, index).split('\n').length
}

describe('Vue 图片来源页策略', () => {
  it('所有 img 标签都显式关闭来源页发送', () => {
    const missing = collectVueFiles(appDir).flatMap((filePath) => {
      const source = readFileSync(filePath, 'utf8')
      const matches = source.matchAll(/<img\b[\s\S]*?>/g)

      return Array.from(matches)
        .filter((match) => !/\breferrerpolicy\s*=\s*["']no-referrer["']/.test(match[0]))
        .map((match) => `${relative(appDir, filePath)}:${lineNumberOf(source, match.index ?? 0)}`)
    })

    expect(missing).toEqual([])
  })
})
