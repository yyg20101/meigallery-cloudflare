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
  assertReleaseVerificationSummary({
    environment,
    verificationType,
    commit,
    summary: options.summary,
  })

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

export function assertReleaseVerificationSummary(options) {
  if (options.verificationType === 'meta_live') {
    assertMetaLiveSummary(options.summary, options)
    return
  }
  if (options.verificationType === 'meta_resources') {
    assertMetaResourcesSummary(options.summary, options)
    return
  }
  throw new Error('verificationType 非法')
}

export function assertReleaseVerificationRow(options) {
  const row = options?.row
  assertExactRecord(row, ['summary', 'verified_at', 'expires_at'], 'release verification row')
  if (typeof row.summary !== 'string') throw new Error('release verification row.summary 非法')
  const verifiedAt = strictIsoTime(row.verified_at, 'verified_at')
  const expiresAt = strictIsoTime(row.expires_at, 'expires_at')
  const now = new Date(options.now ?? Date.now()).getTime()
  if (!Number.isFinite(now)) throw new Error('release verification row now 非法')
  if (expiresAt - verifiedAt !== TTL_MS || verifiedAt > now || now >= expiresAt) {
    throw new Error('release verification row 时效非法')
  }
  let summary
  try {
    summary = JSON.parse(row.summary)
  }
  catch {
    throw new Error('release verification row.summary 不是合法 JSON')
  }
  assertReleaseVerificationSummary({ ...options, summary })
  return summary
}

function assertMetaLiveSummary(value, expected) {
  assertExactRecord(value, [
    'schemaVersion', 'commitSha', 'environment', 'events', 'eventsVerified',
    'forbiddenEventsAbsent', 'datasetQualityContractVersion', 'datasetQualityContractDigest',
  ], 'summary')
  if (value.schemaVersion !== 2) throw new Error('summary.schemaVersion 必须为 2')
  if (value.commitSha !== expected.commit) throw new Error('summary.commitSha 与写入 commit 不一致')
  if (value.environment !== expected.environment) throw new Error('summary.environment 与写入环境不一致')
  if (!Array.isArray(value.events)
    || value.events.length !== 2
    || value.events[0] !== 'Contact'
    || value.events[1] !== 'CompleteRegistration') {
    throw new Error('summary.events 必须为固定脱敏事件 allowlist')
  }
  if (value.eventsVerified !== true || value.forbiddenEventsAbsent !== true) {
    throw new Error('summary Meta live 布尔门禁未通过')
  }
  if (!Number.isSafeInteger(value.datasetQualityContractVersion) || value.datasetQualityContractVersion < 1) {
    throw new Error('summary.datasetQualityContractVersion 非法')
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(String(value.datasetQualityContractDigest || ''))) {
    throw new Error('summary.datasetQualityContractDigest 非法')
  }
}

function assertMetaResourcesSummary(value, expected) {
  const booleanFields = [
    'bootstrapReady', 'liveAttestation', 'migrationsReady', 'd1Ready', 'r2Ready',
    'queuesReady', 'secretsReady', 'migrationsCurrent', 'migrationsApplied',
    'connectionVerified', 'capiEnabled', 'initialMetaRollout', 'noOpenCriticalIncident',
    'initialRolloutZero', 'secureOutboxReady', 'previousKeyReferencesExplainable', 'rolloutZero',
  ]
  assertExactRecord(value, ['schemaVersion', 'verificationPhase', ...booleanFields, 'environmentIsolation'], 'summary')
  if (value.schemaVersion !== 2) throw new Error('summary.schemaVersion 必须为 2')
  if (!['bootstrap', 'post-deploy', 'full'].includes(value.verificationPhase)) {
    throw new Error('summary.verificationPhase 非法')
  }
  for (const field of booleanFields) {
    if (typeof value[field] !== 'boolean') throw new Error(`summary.${field} 只允许布尔值`)
  }
  const isolationFields = ['d1', 'r2', 'queue', 'dlq', 'pixel', 'token', 'testEventCode', 'dataKey']
  assertExactRecord(value.environmentIsolation, isolationFields, 'summary.environmentIsolation')
  for (const field of isolationFields) {
    if (typeof value.environmentIsolation[field] !== 'boolean') {
      throw new Error(`summary.environmentIsolation.${field} 只允许布尔值`)
    }
  }

  const alwaysReady = [
    'migrationsReady', 'd1Ready', 'r2Ready', 'queuesReady', 'secretsReady',
    'migrationsCurrent', 'migrationsApplied', 'noOpenCriticalIncident',
    'initialRolloutZero', 'secureOutboxReady', 'previousKeyReferencesExplainable',
  ]
  requireTrueFields(value, alwaysReady, value.verificationPhase)
  requireTrueFields(value.environmentIsolation, ['d1', 'r2', 'queue', 'dlq'], `${value.verificationPhase}.environmentIsolation`)

  if (value.verificationPhase === 'bootstrap') {
    if (expected.environment !== 'production'
      || value.bootstrapReady !== true
      || value.liveAttestation !== false
      || value.connectionVerified !== false
      || value.capiEnabled !== false
      || value.initialMetaRollout !== true
      || value.rolloutZero !== true) {
      throw new Error('summary bootstrap 语义门禁未通过')
    }
    for (const field of ['pixel', 'token', 'testEventCode', 'dataKey']) {
      if (value.environmentIsolation[field] !== false) throw new Error('summary bootstrap 隔离语义非法')
    }
    return
  }

  if (value.bootstrapReady !== false || value.initialMetaRollout !== false) {
    throw new Error(`summary ${value.verificationPhase} 语义门禁未通过`)
  }
  if (expected.environment === 'production') {
    if (value.liveAttestation !== true) throw new Error(`summary ${value.verificationPhase} live attestation 未通过`)
    requireTrueFields(value.environmentIsolation, ['pixel', 'token', 'testEventCode', 'dataKey'], `${value.verificationPhase}.environmentIsolation`)
  }
  if (value.verificationPhase === 'post-deploy') {
    if (expected.environment !== 'production'
      || value.connectionVerified !== false
      || value.capiEnabled !== false
      || value.rolloutZero !== true) {
      throw new Error('summary post-deploy 语义门禁未通过')
    }
    return
  }
  if (value.connectionVerified !== true) throw new Error('summary full connection 门禁未通过')
}

function requireTrueFields(value, fields, path) {
  for (const field of fields) {
    if (value[field] !== true) throw new Error(`summary ${path}.${field} 必须为 true`)
  }
}

function strictIsoTime(value, field) {
  if (typeof value !== 'string') throw new Error(`release verification row.${field} 非法`)
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`release verification row.${field} 非法`)
  }
  return parsed
}

function assertExactRecord(value, keys, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} 必须为结构化脱敏对象`)
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${path} 字段不符合严格 allowlist`)
  }
}

function escapeSqlString(value) {
  return value.replaceAll("'", "''")
}
