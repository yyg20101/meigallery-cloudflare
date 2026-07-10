import { runCommand } from './release-verification-lib.mjs'

const ENVIRONMENTS = {
  dev: { database: 'meigallery-db-dev', envArgs: ['--env', 'dev'] },
  production: { database: 'meigallery-db', envArgs: ['--env', ''] },
}
const VERIFICATION_TYPES = new Set(['meta_resources', 'meta_live'])
const TTL_MS = 24 * 60 * 60 * 1000

export async function recordReleaseVerificationSummary(options) {
  const environment = String(options?.environment || '')
  const config = ENVIRONMENTS[environment]
  const verificationType = String(options?.verificationType || '')
  const commit = String(options?.commit || '').trim()
  const verifiedAt = new Date(options?.verifiedAt ?? Date.now())

  if (!config) throw new Error('environment 只允许 dev 或 production')
  if (!VERIFICATION_TYPES.has(verificationType)) throw new Error('verificationType 非法')
  if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error('commit 必须为 40 位 SHA')
  if (Number.isNaN(verifiedAt.getTime())) throw new Error('verifiedAt 非法')
  assertBooleanSummary(options.summary)

  const expiresAt = new Date(verifiedAt.getTime() + TTL_MS)
  const id = `rvf_${environment}_${verificationType}_${commit}`
  const summaryJson = escapeSqlString(JSON.stringify(options.summary))
  const sql = [
    'INSERT OR REPLACE INTO analytics_release_verifications',
    '(id, commit_sha, environment, verification_type, status, summary, verified_at, expires_at, created_at)',
    `VALUES ('${id}', '${commit}', '${environment}', '${verificationType}', 'passed', '${summaryJson}', '${verifiedAt.toISOString()}', '${expiresAt.toISOString()}', datetime('now'));`,
  ].join(' ')
  const runCommandFn = options.runCommand || runCommand
  const step = await runCommandFn('corepack', [
    'pnpm', '--filter', '@meigallery/api', 'exec',
    'wrangler', 'd1', 'execute', config.database,
    ...config.envArgs,
    '--remote',
    '--command', sql,
    '--yes',
  ], {
    cwd: options.cwd || process.cwd(),
    name: `record-${environment}-${verificationType}`,
    reportCommand: `corepack pnpm --filter @meigallery/api exec wrangler d1 execute ${config.database} --env ${environment === 'production' ? '""' : 'dev'} --remote --command "INSERT release verification summary" --yes`,
  })

  return {
    name: step.name,
    status: step.status,
    durationMs: step.durationMs ?? 0,
    command: step.command,
    exitCode: step.exitCode,
    summary: step.status === 'passed' ? '发布验证脱敏摘要已写入 D1' : '发布验证脱敏摘要写入 D1 失败',
  }
}

function assertBooleanSummary(value, path = 'summary') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} 必须为布尔摘要对象`)
  for (const [key, child] of Object.entries(value)) {
    if (!/^[a-z][A-Za-z0-9]*$/.test(key)) throw new Error(`${path}.${key} 字段名非法`)
    if (typeof child === 'boolean') continue
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      assertBooleanSummary(child, `${path}.${key}`)
      continue
    }
    throw new Error(`${path}.${key} 只允许布尔值`)
  }
}

function escapeSqlString(value) {
  return value.replaceAll("'", "''")
}
