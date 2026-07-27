import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { cwd } from 'node:process'
import { describe, expect, it } from 'vitest'

const packageRoot = cwd()
const repositoryRoot = resolve(packageRoot, '../..')
const orchestrationFiles = [
  'src/services/conversions.ts',
  'src/services/ad-platform/planner.ts',
  'src/services/ad-platform/recovery.ts',
  'src/routes/admin/ad-platforms.ts',
]
const finalFactFiles = [
  ...orchestrationFiles,
  'src/services/attribution-dashboard.ts',
]

describe('通用广告归因架构边界', () => {
  it('仓库只保留 API 单一归因运行时，不得恢复旧控制面', () => {
    const forbiddenPaths = [
      /^packages\/attribution\//,
      /^packages\/api\/src\/routes\/admin\/attribution-(?:cutover|migration|proxy)/,
      /^packages\/api\/src\/services\/attribution-(?:business-outbox|cutover-preflight|migration-export|runtime-owner|service-client|service-request)/,
      /^packages\/api\/src\/workflows\/ad-platform-verification/,
      /^scripts\/(?:bootstrap-attribution-worker|deploy-attribution|migrate-attribution-runtime|operate-attribution-cutover|provision-attribution-resources|verify-attribution-cutover)/,
    ]
    const violations = trackedFiles().filter(filePath =>
      forbiddenPaths.some(pattern => pattern.test(filePath)),
    )

    expect(violations).toEqual([])
  })

  it('业务编排只依赖通用注册表和协议，不包含平台控制流或平台服务 import', () => {
    const violations = orchestrationFiles.flatMap((filePath) => {
      const source = sourceFile(filePath)
      const platformBranches = source.match(/(?:===|!==)\s*['"](?:meta|tiktok|google)['"]/g) ?? []
      const platformImports = source.match(/from\s+['"][^'"]*(?:meta|tiktok|google)(?:-capi|-events|-connection|-server|-verification)[^'"]*['"]/g) ?? []
      return [...platformBranches, ...platformImports].map(match => `${filePath}: ${match}`)
    })

    expect(violations).toEqual([])
  })

  it('最终事实运行路径不读取旧事实表、旧验证表或旧 secret', () => {
    const forbidden = [
      'analytics_conversion_actions',
      'analytics_conversion_deliveries',
      'analytics_conversion_delivery_daily',
      'meta_dataset_quality_snapshots',
      'meta_connection_verifications',
      'tiktok_connection_verifications',
      'ad_platform_connections',
      'META_CAPI_ACCESS_TOKEN',
      'META_CAPI_DATA_KEY_',
      'TIKTOK_EVENTS_ACCESS_TOKEN',
      'TIKTOK_EVENTS_DATA_KEY_',
      'META_CAPI_QUEUE',
      'TIKTOK_EVENTS_QUEUE',
    ]
    const violations = finalFactFiles.flatMap((filePath) => {
      const source = sourceFile(filePath)
      return forbidden.filter(value => source.includes(value)).map(value => `${filePath}: ${value}`)
    })

    expect(violations).toEqual([])
  })

  it('运行时和当前架构文档不包含废弃的推广链接 proof', () => {
    const currentFiles = trackedTextFiles().filter(filePath => (
      (/^packages\/(?:api\/src|web\/app|shared\/src)\//.test(filePath)
        && !/\.test\.[cm]?[jt]s$/.test(filePath))
      || /^docs\/(?:AD_PLATFORM_ARCHITECTURE|TECHNICAL_SPEC)\.md$/.test(filePath)
    ))
    const violations = currentFiles.flatMap((filePath) => {
      const source = readFileSync(resolve(repositoryRoot, filePath), 'utf8')
      return ['link_proof', 'mg_proof', 'managedLinkProof']
        .filter(value => source.includes(value))
        .map(value => `${filePath}: ${value}`)
    })

    expect(violations).toEqual([])
  })

  it('tracked 文件不包含已使用的生产测试码、真实私钥块或直接 secret 赋值', () => {
    const knownProductionCodes = ['16752', '17298', '25401'].map(value => `TEST${value}`)
    const violations: string[] = []
    for (const filePath of trackedTextFiles()) {
      const source = readFileSync(resolve(repositoryRoot, filePath), 'utf8')
      for (const code of knownProductionCodes) {
        if (source.includes(code)) violations.push(`${filePath}: production Test Event Code`)
      }
      if (/-----BEGIN (?:RSA )?PRIVATE KEY-----\r?\n(?:[A-Za-z0-9+/=]{20,}\r?\n){2,}/.test(source)
        || /-----BEGIN (?:RSA )?PRIVATE KEY-----\\n[A-Za-z0-9+/=\\n]{120,}/.test(source)) {
        violations.push(`${filePath}: private key`)
      }
      const assignment = /(?:META_CAPI_ACCESS_TOKEN|TIKTOK_EVENTS_ACCESS_TOKEN|AD_PLATFORM_CREDENTIAL_MASTER_KEY_(?:CURRENT|PREVIOUS))\s*[:=]\s*['"]([A-Za-z0-9._-]{24,})['"]/g
      for (const match of source.matchAll(assignment)) {
        if (!/(?:example|placeholder|test|fake|sensitive)/i.test(match[1] ?? '')) {
          violations.push(`${filePath}: direct secret assignment`)
        }
      }
    }

    expect(violations).toEqual([])
  })
})

function sourceFile(filePath: string) {
  return readFileSync(resolve(packageRoot, filePath), 'utf8')
}

function trackedTextFiles() {
  return trackedFiles()
    .filter(filePath => /\.(?:[cm]?[jt]s|vue|json|toml|ya?ml|md|sql|env(?:\.example)?)$/.test(filePath))
    .map(filePath => relative(repositoryRoot, resolve(repositoryRoot, filePath)))
    .filter(filePath => existsSync(resolve(repositoryRoot, filePath)))
}

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean)
}
