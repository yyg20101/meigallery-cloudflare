#!/usr/bin/env node

import { pathToFileURL } from 'node:url'
import { lstat, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { recordReleaseVerificationSummary } from './release-verification-store.mjs'
import { runCommand } from './release-verification-lib.mjs'

const RESOURCE_CONFIG = {
  production: {
    envArgs: ['--env', ''],
    database: 'meigallery-db',
    d1Id: '714929cb-003b-4cb1-bd9f-545fa1895e8c',
    worker: 'meigallery-api',
    mainQueue: 'meigallery-meta-capi',
    dlq: 'meigallery-meta-capi-dlq',
    r2: 'meigallery-media',
    mainConsumer: { batchSize: 10, maxWaitTimeMs: 30_000, maxRetries: 5, retryDelay: 60 },
    dlqConsumer: { batchSize: 10, maxWaitTimeMs: 5_000 },
  },
  dev: {
    envArgs: ['--env', 'dev'],
    database: 'meigallery-db-dev',
    d1Id: '9ff61317-0c62-491b-8b29-e0d119f306c9',
    worker: 'meigallery-api-dev',
    mainQueue: 'meigallery-meta-capi-dev',
    dlq: 'meigallery-meta-capi-dev-dlq',
    r2: 'meigallery-media-dev',
    mainConsumer: { batchSize: 5, maxWaitTimeMs: 30_000, maxRetries: 5, retryDelay: 60 },
    dlqConsumer: { batchSize: 5, maxWaitTimeMs: 5_000 },
  },
}
const ALWAYS_REQUIRED_SECRETS = ['META_CAPI_ACCESS_TOKEN', 'META_CAPI_DATA_KEY_CURRENT']
const REQUIRED_MIGRATIONS = [
  '0036_meta_capi_v2_secure_delivery.sql',
  '0037_meta_connection_revision.sql',
  '0038_conversion_dedupe_claims.sql',
  '0039_meta_capi_v2_operations.sql',
  '0040_meta_capi_circuit_indexes.sql',
]
const SETTINGS_SQL = "SELECT key, value FROM site_settings WHERE key IN ('meta_capi_enabled', 'meta_tracking_mode', 'facebook_pixel_id') ORDER BY key"
const MIGRATION_NAMES_SQL = "SELECT name FROM d1_migrations WHERE name IN ('0036_meta_capi_v2_secure_delivery.sql', '0037_meta_connection_revision.sql', '0038_conversion_dedupe_claims.sql', '0039_meta_capi_v2_operations.sql', '0040_meta_capi_circuit_indexes.sql') ORDER BY name"
const META_OPERATIONS_SQL = `
  WITH rollout AS (
    SELECT CAST(COALESCE((SELECT value FROM site_settings WHERE key = 'meta_capi_rollout_percentage' LIMIT 1), '-1') AS INTEGER) AS target
  ), incidents AS (
    SELECT COUNT(*) AS open_count FROM meta_capi_incidents WHERE status = 'open' AND severity = 'critical'
  ), active_keys AS (
    SELECT o.key_id, COUNT(*) AS reference_count, MAX(o.created_at) AS newest_at
    FROM meta_capi_secure_outbox o
    JOIN analytics_conversion_deliveries d ON d.id = o.delivery_id
    WHERE d.status IN ('pending', 'failed') AND datetime(o.expires_at) > datetime('now')
    GROUP BY o.key_id
  ), ranked_keys AS (
    SELECT key_id, reference_count, ROW_NUMBER() OVER (ORDER BY newest_at DESC, key_id ASC) AS key_rank FROM active_keys
  )
  SELECT rollout.target AS target_rollout_percentage,
    CASE WHEN incidents.open_count > 0 THEN 0 ELSE rollout.target END AS effective_rollout_percentage,
    incidents.open_count AS open_critical_incident_count,
    (SELECT COUNT(*) FROM meta_capi_secure_outbox WHERE datetime(expires_at) <= datetime('now')) AS expired_secure_outbox_count,
    COALESCE((SELECT SUM(reference_count) FROM ranked_keys WHERE key_rank = 2), 0) AS previous_key_active_count,
    (SELECT COUNT(*) FROM active_keys) AS active_key_count
  FROM rollout CROSS JOIN incidents
`.replace(/\s+/g, ' ').trim()
const DATASET_QUALITY_SQL = `
  WITH latest AS (
    SELECT event_name, contract_version, collection_status, collected_at,
      ROW_NUMBER() OVER (PARTITION BY event_name ORDER BY collected_at DESC, id DESC) AS row_rank
    FROM meta_dataset_quality_snapshots
    WHERE environment = 'dev'
  )
  SELECT contract_version,
    COUNT(*) AS event_count,
    MIN(CASE WHEN collection_status = 'success' THEN 1 ELSE 0 END) AS all_success,
    MIN(collected_at) AS oldest_collected_at,
    MAX(collected_at) AS newest_collected_at,
    MIN(CASE WHEN datetime(collected_at) > datetime('now', '-24 hours') THEN 1 ELSE 0 END) AS collector_current
  FROM latest
  WHERE row_rank = 1
  GROUP BY contract_version
  ORDER BY contract_version DESC
  LIMIT 1
`.replace(/\s+/g, ' ').trim()

function metaConnectionSql(environment) {
  return `SELECT environment, pixel_id, graph_api_version, verified_commit, verified_at, invalidated_at, invalidation_reason, revision FROM meta_connection_verifications WHERE environment = '${environment}' LIMIT 2`
}

export async function runMetaResourceVerification(options = {}) {
  const environment = String(options.environment || '')
  const config = RESOURCE_CONFIG[environment]
  if (!config) throw new Error('--env 只允许 dev 或 production')
  if (options.initialMetaRollout !== undefined && typeof options.initialMetaRollout !== 'boolean') throw new Error('initialMetaRollout 必须为布尔值')
  const phase = options.phase || (options.initialMetaRollout === true && environment === 'production' ? 'bootstrap' : 'full')
  if (!['bootstrap', 'full'].includes(phase) || (phase === 'bootstrap' && environment !== 'production')) {
    throw new Error('phase 只允许 production bootstrap 或 full')
  }
  const runCommandFn = options.runCommand || runCommand
  const resourceIdentities = options.resourceIdentities || await readResourceIdentities(options)
  const recordSummary = options.recordSummary || recordReleaseVerificationSummary
  const calls = [
    command('queue-main', ['queues', 'info', config.mainQueue]),
    command('queue-dlq', ['queues', 'info', config.dlq]),
    command('r2-bucket', ['r2', 'bucket', 'info', config.r2, '--json']),
    command('consumer-main', ['queues', 'consumer', 'worker', 'list', config.mainQueue, '--json']),
    command('consumer-dlq', ['queues', 'consumer', 'worker', 'list', config.dlq, '--json']),
    command('secrets', ['secret', 'list', ...config.envArgs, '--format', 'json']),
    command('migrations', ['d1', 'migrations', 'list', config.database, ...config.envArgs, '--remote']),
    command('meta-settings', ['d1', 'execute', config.database, ...config.envArgs, '--remote', '--command', SETTINGS_SQL, '--json']),
    command('migration-names', ['d1', 'execute', config.database, ...config.envArgs, '--remote', '--command', MIGRATION_NAMES_SQL, '--json']),
    command('meta-connection', ['d1', 'execute', config.database, ...config.envArgs, '--remote', '--command', metaConnectionSql(environment), '--json']),
    command('meta-operations', ['d1', 'execute', config.database, ...config.envArgs, '--remote', '--command', META_OPERATIONS_SQL, '--json']),
  ]
  if (environment === 'dev' && options.expectedDatasetQualityContract) {
    calls.push(command('dataset-quality', ['d1', 'execute', config.database, ...config.envArgs, '--remote', '--command', DATASET_QUALITY_SQL, '--json']))
  }
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
  const r2Present = byName.get('r2-bucket')?.status === 'passed'
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
    ? [...ALWAYS_REQUIRED_SECRETS, ...((phase === 'bootstrap' || settings.trackingMode === 'test') ? ['META_CAPI_TEST_EVENT_CODE'] : [])]
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
  const operations = parseMetaOperations(byName.get('meta-operations')?.stdout)
  const capiEnabled = settings?.capiEnabled ?? null
  const trackingMode = settings?.trackingMode ?? null
  const initialMetaRollout = options.initialMetaRollout === true && environment === 'production'
  const previousSecretPresent = hasRequiredSecrets(byName.get('secrets')?.stdout, ['META_CAPI_DATA_KEY_PREVIOUS'])
  const previousKeyActiveCountExplainable = operations !== null
    && operations.activeKeyCount <= 2
    && (operations.previousKeyActiveCount === 0 || (operations.activeKeyCount === 2 && previousSecretPresent))
  const incidentReady = operations?.openCriticalIncidentCount === 0
  const environmentIsolation = deriveEnvironmentIsolation(resourceIdentities, environment, settings?.pixelId)
  const isolationReady = phase !== 'bootstrap' || Object.values(environmentIsolation).every(Boolean)
  const datasetQuality = options.expectedDatasetQualityContract
    ? parseDatasetQuality(byName.get('dataset-quality')?.stdout, options.expectedDatasetQualityContract)
    : null
  const datasetQualityReady = !options.expectedDatasetQualityContract || datasetQuality?.collectorCurrent === true
  const initialStateReady = !initialMetaRollout || (
    capiEnabled === false
    && operations?.targetRolloutPercentage === 0
    && operations?.effectiveRolloutPercentage === 0
    && operations?.expiredSecureOutboxCount === 0
    && previousKeyActiveCountExplainable
  )
  let status = commandsPassed && queuesPresent && r2Present && mainConsumerPresent && dlqConsumerPresent
    && requiredSecretsPresent && migrationsCurrent && migrationsApplied && (phase === 'bootstrap' || connectionVerified)
    && capiEnabled !== null && trackingMode !== null && operations !== null && incidentReady && initialStateReady
    && isolationReady
    && datasetQualityReady
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
          bootstrapReady: phase === 'bootstrap',
          migrationsReady: migrationsCurrent && migrationsApplied,
          d1Ready: settings !== null && operations !== null,
          r2Ready: r2Present,
          queuesReady: queuesPresent && mainConsumerPresent && dlqConsumerPresent,
          secretsReady: requiredSecretsPresent,
          migrationsCurrent,
          migrationsApplied,
          connectionVerified,
          capiEnabled,
          initialMetaRollout,
          noOpenCriticalIncident: incidentReady,
          initialRolloutZero: !initialMetaRollout || (
            operations?.targetRolloutPercentage === 0 && operations?.effectiveRolloutPercentage === 0
          ),
          secureOutboxReady: !initialMetaRollout || operations?.expiredSecureOutboxCount === 0,
          previousKeyReferencesExplainable: !initialMetaRollout || previousKeyActiveCountExplainable,
          rolloutZero: operations?.targetRolloutPercentage === 0 && operations?.effectiveRolloutPercentage === 0,
          environmentIsolation,
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
    phase,
    environment,
    commit: /^[0-9a-f]{40}$/i.test(String(options.commit || '')) ? String(options.commit) : '',
    database: config.database,
    queues: [config.mainQueue, config.dlq],
    consumersPresent: queuesPresent && mainConsumerPresent && dlqConsumerPresent,
    r2Present,
    secretsPresent: requiredSecretsPresent,
    requiredSecretsPresent,
    migrationsCurrent,
    migrationsApplied,
    connectionVerified,
    capiEnabled,
    trackingMode,
    initialMetaRollout,
    targetRolloutPercentage: operations?.targetRolloutPercentage ?? null,
    effectiveRolloutPercentage: operations?.effectiveRolloutPercentage ?? null,
    openCriticalIncidentCount: operations?.openCriticalIncidentCount ?? null,
    expiredSecureOutboxCount: operations?.expiredSecureOutboxCount ?? null,
    previousKeyActiveCount: operations?.previousKeyActiveCount ?? null,
    activeKeyCount: operations?.activeKeyCount ?? null,
    previousKeyActiveCountExplainable,
    environmentIsolation,
    datasetQualityContractVersion: datasetQuality?.contractVersion ?? null,
    datasetQualityContractDigest: datasetQuality?.contractDigest ?? '',
    datasetQualityCollectorCurrent: datasetQuality?.collectorCurrent ?? false,
    datasetQualityOldestCollectedAt: datasetQuality?.oldestCollectedAt ?? '',
    datasetQualityNewestCollectedAt: datasetQuality?.newestCollectedAt ?? '',
    reportOnly: options.reportOnly === true,
    summaryRecorded,
  }
}

async function readResourceIdentities(options) {
  const file = String((options.env || process.env)?.META_RESOURCE_IDENTITIES_FILE || '').trim()
  if (!file) return null
  const stats = await lstat(file).catch(() => null)
  if (!stats?.isFile() || stats.isSymbolicLink() || stats.size <= 0 || stats.size > 64 * 1024) return null
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  }
  catch {
    return null
  }
}

function parseDatasetQuality(stdout, expectedContract) {
  try {
    if (!expectedContract
      || !Number.isSafeInteger(expectedContract.version)
      || !/^sha256:[0-9a-f]{64}$/.test(String(expectedContract.digest || ''))) return null
    const rows = parseD1Rows(parseWranglerJson(stdout))
    if (rows.length !== 1) return null
    const row = rows[0]
    const contractVersion = Number(row.contract_version)
    const eventCount = Number(row.event_count)
    const allSuccess = Number(row.all_success)
    const collectorCurrent = Number(row.collector_current)
    if (contractVersion !== expectedContract.version || eventCount !== 2 || allSuccess !== 1 || collectorCurrent !== 1) return null
    if (typeof row.oldest_collected_at !== 'string' || typeof row.newest_collected_at !== 'string') return null
    return {
      contractVersion,
      contractDigest: expectedContract.digest,
      collectorCurrent: true,
      oldestCollectedAt: row.oldest_collected_at,
      newestCollectedAt: row.newest_collected_at,
    }
  }
  catch {
    return null
  }
}

function deriveEnvironmentIsolation(value, environment, pixelId) {
  const resourceValues = {
    d1: [RESOURCE_CONFIG.dev.d1Id, RESOURCE_CONFIG.production.d1Id],
    r2: [RESOURCE_CONFIG.dev.r2, RESOURCE_CONFIG.production.r2],
    queue: [RESOURCE_CONFIG.dev.mainQueue, RESOURCE_CONFIG.production.mainQueue],
    dlq: [RESOURCE_CONFIG.dev.dlq, RESOURCE_CONFIG.production.dlq],
  }
  const dev = isPlainRecord(value?.dev) ? value.dev : {}
  const production = isPlainRecord(value?.production) ? value.production : {}
  const resourceProof = Object.fromEntries(Object.entries(resourceValues).map(([field, [left, right]]) => [field, left !== right]))
  const fingerprintProof = Object.fromEntries(['pixel', 'token', 'testEventCode', 'dataKey'].map(field => {
    const left = String(dev[field] || '').trim()
    const right = String(production[field] || '').trim()
    const valid = /^sha256:[0-9a-f]{64}$/.test(left) && /^sha256:[0-9a-f]{64}$/.test(right)
    const currentPixelMatches = field !== 'pixel' || !pixelId || (
      String(value?.[environment]?.pixel || '') === `sha256:${createHash('sha256').update(String(pixelId)).digest('hex')}`
    )
    return [field, valid && left !== right && currentPixelMatches]
  }))
  return { ...resourceProof, ...fingerprintProof }
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

function parseMetaOperations(stdout) {
  try {
    const rows = parseD1Rows(parseWranglerJson(stdout))
    if (rows.length !== 1) return null
    const fields = [
      'target_rollout_percentage',
      'effective_rollout_percentage',
      'open_critical_incident_count',
      'expired_secure_outbox_count',
      'previous_key_active_count',
      'active_key_count',
    ]
    const values = Object.fromEntries(fields.map(field => [field, Number(rows[0]?.[field])]))
    if (!fields.every(field => Number.isSafeInteger(values[field]) && values[field] >= 0)) return null
    if (![0, 10, 50, 100].includes(values.target_rollout_percentage)) return null
    if (![0, 10, 50, 100].includes(values.effective_rollout_percentage)) return null
    return {
      targetRolloutPercentage: values.target_rollout_percentage,
      effectiveRolloutPercentage: values.effective_rollout_percentage,
      openCriticalIncidentCount: values.open_critical_incident_count,
      expiredSecureOutboxCount: values.expired_secure_outbox_count,
      previousKeyActiveCount: values.previous_key_active_count,
      activeKeyCount: values.active_key_count,
    }
  } catch {
    return null
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
