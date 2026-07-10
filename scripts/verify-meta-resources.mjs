#!/usr/bin/env node

import { pathToFileURL } from 'node:url'
import { recordReleaseVerificationSummary } from './release-verification-store.mjs'
import { runCommand } from './release-verification-lib.mjs'

const RESOURCE_CONFIG = {
  production: {
    envArgs: ['--env', ''],
    database: 'meigallery-db',
    worker: 'meigallery-api',
    mainQueue: 'meigallery-meta-capi',
    dlq: 'meigallery-meta-capi-dlq',
    mainConsumer: { batchSize: 10, maxWaitTimeMs: 30_000, maxRetries: 5, retryDelay: 60 },
    dlqConsumer: { batchSize: 10, maxWaitTimeMs: 5_000 },
  },
  dev: {
    envArgs: ['--env', 'dev'],
    database: 'meigallery-db-dev',
    worker: 'meigallery-api-dev',
    mainQueue: 'meigallery-meta-capi-dev',
    dlq: 'meigallery-meta-capi-dev-dlq',
    mainConsumer: { batchSize: 5, maxWaitTimeMs: 30_000, maxRetries: 5, retryDelay: 60 },
    dlqConsumer: { batchSize: 5, maxWaitTimeMs: 5_000 },
  },
}
const ALWAYS_REQUIRED_SECRETS = ['META_CAPI_ACCESS_TOKEN', 'META_CAPI_DATA_KEY_CURRENT']
const REQUIRED_MIGRATIONS = [
  '0036_meta_capi_v2_secure_delivery.sql',
  '0037_meta_connection_revision.sql',
  '0038_conversion_dedupe_claims.sql',
]
const SETTINGS_SQL = "SELECT key, value FROM site_settings WHERE key IN ('meta_capi_enabled', 'meta_tracking_mode', 'facebook_pixel_id') ORDER BY key"
const MIGRATION_NAMES_SQL = "SELECT name FROM d1_migrations WHERE name IN ('0036_meta_capi_v2_secure_delivery.sql', '0037_meta_connection_revision.sql', '0038_conversion_dedupe_claims.sql') ORDER BY name"

function metaConnectionSql(environment) {
  return `SELECT environment, pixel_id, graph_api_version, verified_commit, verified_at, invalidated_at, invalidation_reason, revision FROM meta_connection_verifications WHERE environment = '${environment}' LIMIT 2`
}

export async function runMetaResourceVerification(options = {}) {
  const environment = String(options.environment || '')
  const config = RESOURCE_CONFIG[environment]
  if (!config) throw new Error('--env 只允许 dev 或 production')
  if (options.initialMetaRollout !== undefined && typeof options.initialMetaRollout !== 'boolean') throw new Error('initialMetaRollout 必须为布尔值')
  const runCommandFn = options.runCommand || runCommand
  const recordSummary = options.recordSummary || recordReleaseVerificationSummary
  const calls = [
    command('queue-main', ['queues', 'info', config.mainQueue]),
    command('queue-dlq', ['queues', 'info', config.dlq]),
    command('consumer-main', ['queues', 'consumer', 'worker', 'list', config.mainQueue, '--json']),
    command('consumer-dlq', ['queues', 'consumer', 'worker', 'list', config.dlq, '--json']),
    command('secrets', ['secret', 'list', ...config.envArgs, '--format', 'json']),
    command('migrations', ['d1', 'migrations', 'list', config.database, ...config.envArgs, '--remote']),
    command('meta-settings', ['d1', 'execute', config.database, ...config.envArgs, '--remote', '--command', SETTINGS_SQL, '--json']),
    command('migration-names', ['d1', 'execute', config.database, ...config.envArgs, '--remote', '--command', MIGRATION_NAMES_SQL, '--json']),
    command('meta-connection', ['d1', 'execute', config.database, ...config.envArgs, '--remote', '--command', metaConnectionSql(environment), '--json']),
  ]
  const results = []
  for (const definition of calls) {
    results.push(await runCommandFn('corepack', [
      'pnpm', '--filter', '@meigallery/api', 'exec', 'wrangler', ...definition.args,
    ], {
      cwd: options.cwd || process.cwd(),
      name: `meta-resources-${environment}-${definition.name}`,
      reportCommand: definition.reportCommand,
    }))
  }

  const byName = new Map(calls.map((definition, index) => [definition.name, results[index]]))
  const commandsPassed = results.every(result => result.status === 'passed')
  const queuesPresent = byName.get('queue-main')?.status === 'passed'
    && byName.get('queue-dlq')?.status === 'passed'
  const mainConsumerPresent = hasExpectedConsumer(byName.get('consumer-main')?.stdout, config.worker, {
    ...config.mainConsumer,
    deadLetterQueue: config.dlq,
  })
  const dlqConsumerPresent = hasExpectedConsumer(byName.get('consumer-dlq')?.stdout, config.worker, {
    ...config.dlqConsumer,
    deadLetterQueue: null,
  })
  const settings = parseMetaSettings(byName.get('meta-settings')?.stdout)
  const requiredSecretNames = settings
    ? [...ALWAYS_REQUIRED_SECRETS, ...(settings.trackingMode === 'test' ? ['META_CAPI_TEST_EVENT_CODE'] : [])]
    : []
  const requiredSecretsPresent = settings !== null
    && hasRequiredSecrets(byName.get('secrets')?.stdout, requiredSecretNames)
  const migrationsCurrent = /^No migrations to apply!?$/im.test(String(byName.get('migrations')?.stdout || '').trim())
  const migrationsApplied = hasRequiredMigrations(byName.get('migration-names')?.stdout)
  const connectionVerified = settings !== null && hasVerifiedMetaConnection(
    byName.get('meta-connection')?.stdout,
    environment,
    settings.pixelId,
    options.commit,
  )
  const capiEnabled = settings?.capiEnabled ?? null
  const trackingMode = settings?.trackingMode ?? null
  const initialMetaRollout = options.initialMetaRollout === true && environment === 'production'
  const initialStateReady = !initialMetaRollout || capiEnabled === false
  let status = commandsPassed && queuesPresent && mainConsumerPresent && dlqConsumerPresent
    && requiredSecretsPresent && migrationsCurrent && migrationsApplied && connectionVerified
    && capiEnabled !== null && trackingMode !== null && initialStateReady
    ? 'passed'
    : 'failed'
  let summaryRecorded = false

  if (status === 'passed' && options.reportOnly !== true) {
    if (!/^[0-9a-f]{40}$/i.test(String(options.commit || ''))) {
      status = 'failed'
    } else {
      const storeStep = await recordSummary({
        environment,
        verificationType: 'meta_resources',
        commit: options.commit,
        verifiedAt: options.now,
        summary: {
          queuesReady: queuesPresent && mainConsumerPresent && dlqConsumerPresent,
          secretsReady: requiredSecretsPresent,
          migrationsCurrent,
          migrationsApplied,
          connectionVerified,
          capiEnabled,
          trackingMode,
          initialMetaRollout,
        },
        cwd: options.cwd,
        runCommand: options.runCommand,
      })
      summaryRecorded = storeStep?.status === 'passed'
      if (!summaryRecorded) status = 'failed'
    }
  }

  return {
    schemaVersion: 1,
    status,
    environment,
    commit: /^[0-9a-f]{40}$/i.test(String(options.commit || '')) ? String(options.commit) : '',
    database: config.database,
    queues: [config.mainQueue, config.dlq],
    consumersPresent: queuesPresent && mainConsumerPresent && dlqConsumerPresent,
    secretsPresent: requiredSecretsPresent,
    requiredSecretsPresent,
    migrationsCurrent,
    migrationsApplied,
    connectionVerified,
    capiEnabled,
    trackingMode,
    initialMetaRollout,
    reportOnly: options.reportOnly === true,
    summaryRecorded,
  }
}

function command(name, args) {
  return {
    name,
    args,
    reportCommand: `corepack pnpm --filter @meigallery/api exec wrangler ${args.map(arg => arg === '' ? '""' : arg).join(' ')}`,
  }
}

function hasExpectedConsumer(stdout, worker, expected) {
  try {
    const consumers = parseConsumerRows(parseWranglerJson(stdout))
    return consumers.some(consumer => (
      consumerNames(consumer).includes(worker)
      && hasExpectedConsumerSettings(consumer, expected)
    ))
  } catch {
    return false
  }
}

function hasExpectedConsumerSettings(consumer, expected) {
  if (!consumer || typeof consumer !== 'object' || !consumer.settings || typeof consumer.settings !== 'object') return false
  const settings = consumer.settings
  if (Number(settings.batch_size) !== expected.batchSize) return false
  if (Number(settings.max_wait_time_ms) !== expected.maxWaitTimeMs) return false
  if (expected.maxRetries !== undefined && Number(settings.max_retries) !== expected.maxRetries) return false
  if (expected.retryDelay !== undefined && Number(settings.retry_delay) !== expected.retryDelay) return false
  if (expected.deadLetterQueue !== undefined) {
    if (!hasExpectedDeadLetterQueue(consumer, settings, expected.deadLetterQueue)) return false
  }
  return true
}

function hasExpectedDeadLetterQueue(consumer, settings, expected) {
  const values = []
  if (Object.hasOwn(consumer, 'dead_letter_queue')) values.push(consumer.dead_letter_queue)
  if (Object.hasOwn(settings, 'dead_letter_queue')) values.push(settings.dead_letter_queue)
  if (expected === null) return values.every(value => value === '')
  return values.length > 0 && values.every(value => typeof value === 'string' && value === expected)
}

function hasRequiredSecrets(stdout, requiredNames) {
  try {
    const secrets = parseSecretRows(parseWranglerJson(stdout))
    const names = new Set(secrets.map(secret => secret?.name))
    return requiredNames.every(name => names.has(name))
  } catch {
    return false
  }
}

function parseMetaSettings(stdout) {
  try {
    const rows = parseD1Rows(parseWranglerJson(stdout))
    const values = new Map(rows.map(row => [row?.key, storedValue(row?.value)]))
    const capiEnabled = parseBoolean(values.get('meta_capi_enabled'))
    const trackingMode = values.get('meta_tracking_mode')
    const pixelId = String(values.get('facebook_pixel_id') ?? '').trim()
    if (capiEnabled === null || !['disabled', 'test', 'production'].includes(trackingMode) || !/^\d{5,30}$/.test(pixelId)) return null
    return { capiEnabled, trackingMode, pixelId }
  } catch {
    return null
  }
}

function hasRequiredMigrations(stdout) {
  try {
    const rows = parseD1Rows(parseWranglerJson(stdout))
    const names = new Set(rows.map(row => row?.name).filter(name => typeof name === 'string'))
    return REQUIRED_MIGRATIONS.every(name => names.has(name))
  } catch {
    return false
  }
}

function hasVerifiedMetaConnection(stdout, environment, pixelId, commit) {
  try {
    const rows = parseD1Rows(parseWranglerJson(stdout))
    if (rows.length !== 1) return false
    const row = rows[0]
    const expectedCommit = /^[0-9a-f]{40}$/i.test(String(commit || '')) ? String(commit).toLowerCase() : ''
    return row?.environment === environment
      && row.pixel_id === pixelId
      && row.graph_api_version === 'v25.0'
      && /^[0-9a-f]{40}$/i.test(String(row.verified_commit || ''))
      && (!expectedCommit || String(row.verified_commit).toLowerCase() === expectedCommit)
      && typeof row.verified_at === 'string' && row.verified_at.trim() !== ''
      && (row.invalidated_at === null || row.invalidated_at === '')
      && row.invalidation_reason === ''
      && /^[0-9a-f]{32}$/i.test(String(row.revision || ''))
  } catch {
    return false
  }
}

function parseBoolean(value) {
  if (value === true || value === 1 || value === 'true' || value === '1') return true
  if (value === false || value === 0 || value === 'false' || value === '0') return false
  return null
}

function storedValue(value) {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function parseWranglerJson(stdout) {
  const text = String(stdout || '').trim()
  if (!text) throw new Error('Wrangler 未返回 JSON')
  try {
    return JSON.parse(text)
  } catch {
    const starts = [...text.matchAll(/^[ \t]*[\[{]/gm)].map(match => match.index + match[0].search(/[\[{]/))
    for (const start of starts) {
      try {
        return JSON.parse(text.slice(start))
      } catch {
        // 继续尝试下一段可能的 JSON 起点。
      }
    }
  }
  throw new Error('Wrangler JSON 格式非法')
}

function parseConsumerRows(value) {
  if (Array.isArray(value)) return value
  if (isPlainRecord(value) && Array.isArray(value.consumers)) return value.consumers
  if (isPlainRecord(value) && isPlainRecord(value.result) && Array.isArray(value.result.consumers)) {
    return value.result.consumers
  }
  throw new Error('Wrangler consumer JSON envelope 未识别')
}

function parseSecretRows(value) {
  if (!Array.isArray(value) || !value.every(row => isPlainRecord(row) && typeof row.name === 'string')) {
    throw new Error('Wrangler secret JSON envelope 未识别')
  }
  return value
}

function parseD1Rows(value) {
  if (!Array.isArray(value) || value.length === 0) throw new Error('Wrangler D1 JSON envelope 未识别')
  const rows = []
  for (const result of value) {
    if (!isPlainRecord(result) || !Array.isArray(result.results)) {
      throw new Error('Wrangler D1 JSON envelope 未识别')
    }
    rows.push(...result.results)
  }
  return rows
}

function isPlainRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function consumerNames(consumer) {
  if (!consumer || typeof consumer !== 'object') return []
  const names = []
  for (const key of ['script', 'service', 'service_name', 'serviceName', 'script_name', 'scriptName']) {
    const value = consumer[key]
    if (typeof value === 'string') names.push(value)
    else if (value && typeof value === 'object') {
      for (const nestedKey of ['name', 'script', 'service']) {
        if (typeof value[nestedKey] === 'string') names.push(value[nestedKey])
      }
    }
  }
  return names
}

async function readCommit(options = {}) {
  const runCommandFn = options.runCommand || runCommand
  const result = await runCommandFn('git', ['rev-parse', 'HEAD'], {
    cwd: options.cwd || process.cwd(),
    name: 'git-commit',
  })
  if (result.status !== 'passed') throw new Error('无法读取当前 Git commit')
  return String(result.stdout || '').trim()
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const environmentIndex = argv.indexOf('--env')
  const environment = environmentIndex >= 0 ? argv[environmentIndex + 1] : ''
  const reportOnly = argv.includes('--report-only')
  const initialMetaRollout = argv.includes('--initial-meta-rollout')
  const allowed = new Set(['--env', environment, '--report-only', '--initial-meta-rollout'])
  if (!environment || argv.some(argument => !allowed.has(argument))) throw new Error('用法：verify-meta-resources.mjs --env dev|production [--initial-meta-rollout] [--report-only]')
  const commit = reportOnly ? undefined : await readCommit(options)
  const report = await runMetaResourceVerification({ ...options, environment, reportOnly, initialMetaRollout, commit })
  console.log(JSON.stringify(report, null, 2))
  if (report.status !== 'passed') throw new Error(`Meta ${environment} 资源检查失败`)
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
