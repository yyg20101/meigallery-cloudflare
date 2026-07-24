import {
  readFileSync,
  readdirSync,
} from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SOURCE_ROOT = fileURLToPath(new URL('.', import.meta.url))
const NON_TEST_SOURCES = sourceFiles(SOURCE_ROOT)
const CORE_SOURCES = NON_TEST_SOURCES.filter(file =>
  !file.relative.startsWith('adapters/'))

describe('独立归因运行时架构边界', () => {
  it('核心服务拒绝 Meta/TikTok/Google 平台分支', () => {
    expect(platformBranches(
      "if (candidate.provider !== 'google') return",
    )).not.toEqual([])
    expect(platformBranches(
      "switch (provider) { case 'meta': return queue }",
    )).not.toEqual([])

    expect(findViolations(CORE_SOURCES, platformBranches)).toEqual([])
  })

  it('归因 Worker 不得导入业务 API 或使用旧 API 路径', () => {
    expect(businessApiReferences(
      "import { x } from '@meigallery/api'",
    )).not.toEqual([])
    expect(businessApiReferences(
      "fetch('/api/admin/attribution')",
    )).not.toEqual([])

    expect(findViolations(
      NON_TEST_SOURCES,
      businessApiReferences,
    )).toEqual([])
  })

  it('运行判断不得依赖 Git commit 或 revision 字段', () => {
    expect(gitStateReferences(
      'const commitSha = env.GITHUB_SHA',
    )).not.toEqual([])
    expect(gitStateReferences(
      'credential_revision TEXT NOT NULL',
    )).not.toEqual([])

    expect(findViolations(
      NON_TEST_SOURCES,
      gitStateReferences,
    )).toEqual([])
  })

  it('核心 Queue 只能按当前 provider 动态选择，不得跨平台固定发送', () => {
    expect(crossProviderQueues(
      'await queues.meta.send(message)',
    )).not.toEqual([])
    expect(crossProviderQueues(
      "await queues['tiktok'].send(message)",
    )).not.toEqual([])

    expect(findViolations(
      CORE_SOURCES,
      crossProviderQueues,
    )).toEqual([])
    expect(readSource('services/secure-outbox.ts')).toContain(
      'environment.queues[input.provider].send',
    )
  })

  it('源码不包含 production/dev 项目域名或按 APP_ENV 选择域名', () => {
    expect(environmentDomainReferences(
      "const origin = APP_ENV === 'production' ? "
      + "'https://prod.example' : 'https://dev.example'",
    )).not.toEqual([])
    expect(environmentDomainReferences(
      "const origin = 'https://project.workers.dev'",
    )).not.toEqual([])

    expect(findViolations(
      NON_TEST_SOURCES,
      environmentDomainReferences,
    )).toEqual([])
  })
})

interface SourceFile {
  relative: string
  source: string
}

function sourceFiles(root: string, relative = ''): SourceFile[] {
  const directory = relative ? `${root}/${relative}` : root
  return readdirSync(directory, { withFileTypes: true })
    .flatMap(entry => {
      const child = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) return sourceFiles(root, child)
      if (
        !entry.isFile()
        || !entry.name.endsWith('.ts')
        || entry.name.endsWith('.test.ts')
        || entry.name.endsWith('.d1.test.ts')
      ) {
        return []
      }
      return [{
        relative: child,
        source: readFileSync(`${root}/${child}`, 'utf8'),
      }]
    })
}

function findViolations(
  files: SourceFile[],
  detector: (source: string) => string[],
): string[] {
  return files.flatMap(file =>
    detector(file.source).map(match => `${file.relative}: ${match}`))
}

function platformBranches(source: string): string[] {
  return matches(source, [
    /(?:[\w.]*provider|provider[\w.]*)\s*[!=]==?\s*['"](meta|tiktok|google)['"]/gi,
    /['"](meta|tiktok|google)['"]\s*[!=]==?\s*(?:[\w.]*provider|provider[\w.]*)/gi,
    /switch\s*\([^)]*provider[^)]*\)/gi,
  ])
}

function businessApiReferences(source: string): string[] {
  return matches(source, [
    /@meigallery\/api\b/gi,
    /packages\/api\b/gi,
    /(?:fetch|request)\s*\(\s*['"`]\/api\//gi,
  ])
}

function gitStateReferences(source: string): string[] {
  return matches(source, [
    /\b(?:commitSha|commit_sha|GITHUB_SHA|release_commit|verified_commit)\b/gi,
    /\b(?:connection_revision|credential_revision|mapping_revision)\b/gi,
  ])
}

function crossProviderQueues(source: string): string[] {
  return matches(source, [
    /\bqueues\.(?:meta|tiktok|google)\.send\b/gi,
    /\bqueues\[['"](?:meta|tiktok|google)['"]\]\.send\b/gi,
    /\b(?:META|TIKTOK|GOOGLE)_QUEUE\.send\b/g,
  ])
}

function environmentDomainReferences(source: string): string[] {
  return matches(source, [
    /\b(?:616618\.xyz|workers\.dev)\b/gi,
    /\bmeigallery-(?:web|api)(?:-dev)?\b/gi,
    /\bAPP_ENV\s*===\s*['"]production['"]/g,
  ])
}

function matches(source: string, patterns: RegExp[]): string[] {
  return patterns.flatMap(pattern =>
    [...source.matchAll(pattern)].map(match => match[0]))
}

function readSource(relative: string): string {
  return readFileSync(`${SOURCE_ROOT}/${relative}`, 'utf8')
}
