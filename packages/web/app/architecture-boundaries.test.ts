import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { cwd } from 'node:process'
import { ESLint } from 'eslint'
import * as ts from 'typescript'
import { describe, expect, it } from 'vitest'

type SourceFile = { filePath: string; source: string }

const appDir = join(cwd(), 'app')
const adapterPath = resolve(appDir, 'adapters/metaPixel.client.ts')
const useTrackingPath = resolve(appDir, 'composables/useTracking.ts')
const forbiddenImportTargets = new Set([
  resolve(appDir, 'composables/useConversionTracking.ts'),
  resolve(appDir, 'composables/useFacebookPixel.ts'),
])

function collectSourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) return collectSourceFiles(fullPath)
    return entry.isFile() && /\.(?:[cm]?[jt]s|vue)$/.test(entry.name) ? [fullPath] : []
  })
}

function inspectSources(files: SourceFile[]) {
  return files.flatMap(({ filePath, source }) => {
    if (isTestFile(filePath)) return []

    const violations: string[] = []
    const relativePath = relative(appDir, filePath)
    if (normalizeTarget(filePath) !== normalizeTarget(adapterPath) && /window\.fbq/.test(source)) {
      violations.push(`${relativePath}: direct window.fbq`)
    }
    if (/use(?:FacebookPixel|ConversionTracking)\s*\(/.test(source)) {
      violations.push(`${relativePath}: legacy Tracking call`)
    }
    if (
      normalizeTarget(filePath) !== normalizeTarget(adapterPath)
      && normalizeTarget(filePath) !== normalizeTarget(useTrackingPath)
      && usesIdentifier(filePath, source, 'metaPixelAdapter')
    ) {
      violations.push(`${relativePath}: direct metaPixelAdapter identifier`)
    }

    for (const specifier of readImportSpecifiers(filePath, source)) {
      const target = resolveImportTarget(filePath, specifier)
      if (!target) continue
      if (normalizeTarget(target) === normalizeTarget(adapterPath) && normalizeTarget(filePath) !== normalizeTarget(useTrackingPath)) {
        violations.push(`${relativePath}: imports Meta Pixel adapter`)
      }
      if (forbiddenImportTargets.has(withTypeScriptExtension(target))) {
        violations.push(`${relativePath}: imports legacy Tracking module`)
      }
    }
    return violations
  })
}

function readImportSpecifiers(filePath: string, source: string) {
  return scriptBlocks(filePath, source).flatMap((script, index) => {
    const sourceFile = ts.createSourceFile(`${filePath}:${index}.ts`, script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const specifiers: string[] = []
    const visit = (node: ts.Node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        specifiers.push(node.moduleSpecifier.text)
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const [argument] = node.arguments
        if (argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) {
          specifiers.push(argument.text)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
    return specifiers
  })
}

function usesIdentifier(filePath: string, source: string, identifier: string) {
  return scriptBlocks(filePath, source).some((script, index) => {
    const sourceFile = ts.createSourceFile(`${filePath}:${index}.ts`, script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    let found = false
    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node) && node.text === identifier) found = true
      if (!found) ts.forEachChild(node, visit)
    }
    visit(sourceFile)
    return found
  })
}

function scriptBlocks(filePath: string, source: string) {
  if (!filePath.endsWith('.vue')) return [source]
  return [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1] ?? '')
}

function resolveImportTarget(importer: string, specifier: string) {
  const cleanSpecifier = specifier.split(/[?#]/, 1)[0] ?? ''
  if (cleanSpecifier.startsWith('~/') || cleanSpecifier.startsWith('@/')) {
    return resolve(appDir, cleanSpecifier.slice(2))
  }
  if (cleanSpecifier.startsWith('.')) return resolve(dirname(importer), cleanSpecifier)
  return null
}

function normalizeTarget(filePath: string) {
  return resolve(filePath).replace(/\.(?:[cm]?[jt]sx?)$/, '')
}

function withTypeScriptExtension(filePath: string) {
  return `${normalizeTarget(filePath)}.ts`
}

function isTestFile(filePath: string) {
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(filePath)
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

  it('整个非测试 app 只有 useTracking 可导入 adapter 且只有 adapter 可访问 window.fbq', () => {
    const files = collectSourceFiles(appDir).map(filePath => ({ filePath, source: readFileSync(filePath, 'utf8') }))

    expect(inspectSources(files)).toEqual([])
  })

  it('解析 alias/相对静态与动态 import、auto-import 标识符和直接 fbq，并豁免 Facade、adapter 与测试', () => {
    const violations = inspectSources([
      { filePath: join(appDir, 'pages/direct.ts'), source: "import '../adapters/metaPixel.client'" },
      { filePath: join(appDir, 'components/dynamic.vue'), source: "<script setup>void import('~/adapters/metaPixel.client')</script>" },
      { filePath: join(appDir, 'pages/at-static.ts'), source: "import '@/adapters/metaPixel.client'" },
      { filePath: join(appDir, 'components/at-dynamic.vue'), source: "<script setup>void import('@/adapters/metaPixel.client')</script>" },
      { filePath: join(appDir, 'layouts/template-dynamic.ts'), source: 'void import(`~/adapters/metaPixel.client`)' },
      { filePath: join(appDir, 'layouts/legacy.ts'), source: "import '../composables/useConversionTracking'" },
      { filePath: join(appDir, 'composables/bypass.ts'), source: 'window.fbq?.()' },
      { filePath: join(appDir, 'components/auto-import.vue'), source: '<script setup>metaPixelAdapter.pageView()</script>' },
      { filePath: useTrackingPath, source: "import { metaPixelAdapter } from '~/adapters/metaPixel.client'; metaPixelAdapter.pageView()" },
      { filePath: adapterPath, source: 'export const metaPixelAdapter = {}; window.fbq?.()' },
      { filePath: join(appDir, 'pages/allowed.test.ts'), source: "import('../adapters/metaPixel.client'); metaPixelAdapter.pageView(); window.fbq?.()" },
    ])

    expect(violations).toEqual([
      'pages/direct.ts: imports Meta Pixel adapter',
      'components/dynamic.vue: imports Meta Pixel adapter',
      'pages/at-static.ts: imports Meta Pixel adapter',
      'components/at-dynamic.vue: imports Meta Pixel adapter',
      'layouts/template-dynamic.ts: imports Meta Pixel adapter',
      'layouts/legacy.ts: imports legacy Tracking module',
      'composables/bypass.ts: direct window.fbq',
      'components/auto-import.vue: direct metaPixelAdapter identifier',
    ])
  })

  it.each([
    ['alias adapter', "import { metaPixelAdapter } from '~/adapters/metaPixel.client'\nvoid metaPixelAdapter\n"],
    ['@ alias adapter', "import { metaPixelAdapter } from '@/adapters/metaPixel.client'\nvoid metaPixelAdapter\n"],
    ['relative adapter', "import { metaPixelAdapter } from '../adapters/metaPixel.client'\nvoid metaPixelAdapter\n"],
    ['relative conversion composable', "import '../composables/useConversionTracking'\n"],
    ['relative Pixel composable', "import '../composables/useFacebookPixel'\n"],
  ])('ESLint 拒绝受保护源码导入 %s', async (_label, source) => {
    const projectRoot = resolve(cwd(), '../..')
    const eslint = new ESLint({ cwd: projectRoot })
    const [result] = await eslint.lintText(source, {
      filePath: join(projectRoot, 'packages/web/app/pages/architecture-fixture.ts'),
    })

    expect(result?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: 'no-restricted-imports', severity: 2 }),
    ]))
  })

  it('ESLint 允许 useTracking 导入 Meta Pixel adapter', async () => {
    const projectRoot = resolve(cwd(), '../..')
    const eslint = new ESLint({ cwd: projectRoot })
    const [result] = await eslint.lintText(
      "import { metaPixelAdapter } from '~/adapters/metaPixel.client'\nvoid metaPixelAdapter\n",
      { filePath: join(projectRoot, 'packages/web/app/composables/useTracking.ts') },
    )

    expect(result?.messages.filter(message => message.ruleId === 'no-restricted-imports')).toEqual([])
  })
})
