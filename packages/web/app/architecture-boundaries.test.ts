import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { cwd } from 'node:process'
import { ESLint } from 'eslint'
import * as ts from 'typescript'
import { describe, expect, it } from 'vitest'

type SourceFile = { filePath: string; source: string }

const appDir = join(cwd(), 'app')
const registryPath = resolve(appDir, 'adapters/registry.client.ts')
const attributionPluginPath = resolve(
  appDir,
  'plugins/attribution.client.ts',
)
const attributionAdminDir = resolve(appDir, 'pages/admin/attribution')
const providerAdapterPaths = new Set([
  resolve(appDir, 'adapters/metaPixel.client.ts'),
  resolve(appDir, 'adapters/tiktokPixel.client.ts'),
  resolve(appDir, 'adapters/googleAds.client.ts'),
].map(normalizeTarget))
const obsoletePaths = [
  'adapters/adPlatformBrowser.client.ts',
  'adapters/adPlatformBrowser.client.test.ts',
  'plugins/ad-platform.client.ts',
  'plugins/ad-platform.client.test.ts',
  'composables/useConversionTracking.ts',
  'composables/useConversionTracking.test.ts',
  'composables/useFacebookPixel.ts',
  'utils/facebookPixel.ts',
  'utils/facebookPixel.test.ts',
]
const obsoleteAdminAttributionPaths = [
  'pages/admin/attribution/platforms.vue',
  'pages/admin/attribution/links.vue',
  'pages/admin/attribution/conversions.vue',
  'pages/admin/attribution/readiness.vue',
  'components/admin/attribution/AttributionPlatformConnectionEditor.vue',
  'components/admin/attribution/AttributionCredentialEditor.vue',
  'components/admin/attribution/AttributionEventBindingEditor.vue',
  'components/admin/attribution/AttributionRolloutControl.vue',
  'components/admin/attribution/AttributionProviderSwitch.vue',
  'composables/useAttributionProvider.ts',
]
const legacySourcePatterns = [
  ['/api/ad-attribution', '旧 ad-attribution API'],
  ['/api/conversions', '旧 conversions API'],
  ['/api/admin/attribution/platforms', '旧归因平台控制面 API'],
  ['/api/admin/attribution/links', '旧归因投放链接 API'],
  ['/api/admin/attribution/conversions', '旧归因转化 API'],
  ['/api/admin/attribution/readiness', '旧归因发布检查 API'],
  ['trackingInstructions', '旧 trackingInstructions'],
  ['adPlatformBrowser', '旧 Browser adapter'],
  ['useConversionTracking', '旧 conversion composable'],
  ['useFacebookPixel', '旧 Facebook composable'],
] as const

function collectSourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) return collectSourceFiles(fullPath)
    return entry.isFile() && /\.(?:[cm]?[jt]s|vue)$/.test(entry.name)
      ? [fullPath]
      : []
  })
}

function inspectSources(files: SourceFile[]) {
  return files.flatMap(({ filePath, source }) => {
    if (isTestFile(filePath)) return []
    const violations: string[] = []
    const normalizedFile = normalizeTarget(filePath)
    const relativePath = relative(appDir, filePath)

    for (const [pattern, label] of legacySourcePatterns) {
      if (source.includes(pattern)) {
        violations.push(`${relativePath}: ${label}`)
      }
    }

    const ownedGlobals: Array<[RegExp, string, string]> = [
      [
        /\bwindow\.(?:fbq|_fbq)\b/u,
        normalizeTarget(resolve(appDir, 'adapters/metaPixel.client.ts')),
        'Meta global',
      ],
      [
        /\bwindow\.(?:ttq|TiktokAnalyticsObject)\b/u,
        normalizeTarget(resolve(appDir, 'adapters/tiktokPixel.client.ts')),
        'TikTok global',
      ],
      [
        /\bwindow\.(?:gtag|dataLayer)\b/u,
        normalizeTarget(resolve(appDir, 'adapters/googleAds.client.ts')),
        'Google global',
      ],
    ]
    for (const [pattern, owner, label] of ownedGlobals) {
      if (normalizedFile !== owner && pattern.test(source)) {
        violations.push(`${relativePath}: direct ${label}`)
      }
    }

    for (const specifier of readImportSpecifiers(filePath, source)) {
      const target = resolveImportTarget(filePath, specifier)
      if (!target) continue
      const normalizedTarget = normalizeTarget(target)
      if (
        providerAdapterPaths.has(normalizedTarget)
        && normalizedFile !== normalizeTarget(registryPath)
      ) {
        violations.push(`${relativePath}: imports provider adapter`)
      }
      if (
        normalizedTarget === normalizeTarget(registryPath)
        && normalizedFile !== normalizeTarget(attributionPluginPath)
      ) {
        violations.push(`${relativePath}: imports attribution registry`)
      }
    }
    return violations
  })
}

function readImportSpecifiers(filePath: string, source: string) {
  return scriptBlocks(filePath, source).flatMap((script, index) => {
    const sourceFile = ts.createSourceFile(
      `${filePath}:${index}.ts`,
      script,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    )
    const specifiers: string[] = []
    const visit = (node: ts.Node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
        && node.moduleSpecifier
        && ts.isStringLiteral(node.moduleSpecifier)
      ) {
        specifiers.push(node.moduleSpecifier.text)
      }
      if (
        ts.isCallExpression(node)
        && node.expression.kind === ts.SyntaxKind.ImportKeyword
      ) {
        const [argument] = node.arguments
        if (
          argument
          && (
            ts.isStringLiteral(argument)
            || ts.isNoSubstitutionTemplateLiteral(argument)
          )
        ) {
          specifiers.push(argument.text)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
    return specifiers
  })
}

function scriptBlocks(filePath: string, source: string) {
  if (!filePath.endsWith('.vue')) return [source]
  return [
    ...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/giu),
  ].map(match => match[1] ?? '')
}

function resolveImportTarget(importer: string, specifier: string) {
  const cleanSpecifier = specifier.split(/[?#]/u, 1)[0] ?? ''
  if (
    cleanSpecifier.startsWith('~/')
    || cleanSpecifier.startsWith('@/')
  ) {
    return resolve(appDir, cleanSpecifier.slice(2))
  }
  if (cleanSpecifier.startsWith('.')) {
    return resolve(dirname(importer), cleanSpecifier)
  }
  return null
}

function normalizeTarget(filePath: string) {
  return resolve(filePath).replace(/\.(?:[cm]?[jt]sx?)$/u, '')
}

function isTestFile(filePath: string) {
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(filePath)
}

describe('Web 归因架构边界', () => {
  it('旧 Browser 链路和兼容入口已删除', () => {
    expect(
      obsoletePaths.filter(filePath => existsSync(join(appDir, filePath))),
    ).toEqual([])
  })

  it('旧归因控制面路由、编辑器和平台切换层已删除', () => {
    expect(
      obsoleteAdminAttributionPaths.filter(
        filePath => existsSync(join(appDir, filePath)),
      ),
    ).toEqual([])
  })

  it('只有 registry 可导入平台 adapter，只有 attribution plugin 可管理 registry', () => {
    const files = collectSourceFiles(appDir).map(filePath => ({
      filePath,
      source: readFileSync(filePath, 'utf8'),
    }))
    expect(inspectSources(files)).toEqual([])
  })

  it('扫描静态、动态、alias、相对导入及平台全局变量', () => {
    const violations = inspectSources([
      {
        filePath: join(appDir, 'pages/provider.ts'),
        source: "import '../adapters/metaPixel.client'",
      },
      {
        filePath: join(appDir, 'components/provider.vue'),
        source:
          "<script setup>void import('~/adapters/tiktokPixel.client')</script>",
      },
      {
        filePath: join(appDir, 'composables/registry.ts'),
        source: "import '@/adapters/registry.client'",
      },
      {
        filePath: join(appDir, 'layouts/globals.ts'),
        source: 'window.fbq?.(); window.ttq?.(); window.gtag?.()',
      },
      {
        filePath: join(appDir, 'pages/legacy.ts'),
        source: "void fetch('/api/conversions/contact')",
      },
      {
        filePath: registryPath,
        source: "import './metaPixel.client'",
      },
      {
        filePath: attributionPluginPath,
        source: "import '~/adapters/registry.client'",
      },
    ])

    expect(violations).toEqual([
      'pages/provider.ts: imports provider adapter',
      'components/provider.vue: imports provider adapter',
      'composables/registry.ts: imports attribution registry',
      'layouts/globals.ts: direct Meta global',
      'layouts/globals.ts: direct TikTok global',
      'layouts/globals.ts: direct Google global',
      'pages/legacy.ts: 旧 conversions API',
    ])
  })

  it('归因后台页面不包含平台控制流或硬编码平台选项', () => {
    const violations = collectSourceFiles(attributionAdminDir).flatMap(
      (filePath) => {
        if (isTestFile(filePath)) return []
        const source = readFileSync(filePath, 'utf8')
        const relativePath = relative(appDir, filePath)
        return [
          ...(
            source.match(
              /(?:===|!==)\s*['"](?:meta|tiktok|google)['"]/gu,
            ) ?? []
          ),
          ...(
            source.match(
              /<option\b[^>]*\bvalue=['"](?:meta|tiktok|google)['"]/gu,
            ) ?? []
          ),
        ].map(match => `${relativePath}: ${match}`)
      },
    )
    expect(violations).toEqual([])
  })

  it.each([
    [
      'provider adapter',
      "import { metaPixelAdapter } from '~/adapters/metaPixel.client'\n",
    ],
    [
      'registry',
      "import { trackBrowserTrackingSignal } from '~/adapters/registry.client'\n",
    ],
    [
      '旧接口',
      "import '~/composables/useConversionTracking'\n",
    ],
  ])('ESLint 拒绝业务源码导入 %s', async (_label, source) => {
    const projectRoot = resolve(cwd(), '../..')
    const eslint = new ESLint({ cwd: projectRoot })
    const [result] = await eslint.lintText(source, {
      filePath: join(
        projectRoot,
        'packages/web/app/pages/architecture-fixture.ts',
      ),
    })
    expect(result?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ruleId: 'no-restricted-imports',
        severity: 2,
      }),
    ]))
  })

  it('ESLint 允许 attribution plugin 导入 registry', async () => {
    const projectRoot = resolve(cwd(), '../..')
    const eslint = new ESLint({ cwd: projectRoot })
    const [result] = await eslint.lintText(
      "import '~/adapters/registry.client'\n",
      {
        filePath: join(
          projectRoot,
          'packages/web/app/plugins/attribution.client.ts',
        ),
      },
    )
    expect(
      result?.messages.filter(
        message => message.ruleId === 'no-restricted-imports',
      ),
    ).toEqual([])
  })
})
