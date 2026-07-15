#!/usr/bin/env node

import { execFile as execFileCallback } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { runCommand as defaultRunCommand } from './release-verification-lib.mjs'
import { REQUIRED_PRODUCTION_AD_QUEUES } from './verify-ad-platform-queues.mjs'

const execFile = promisify(execFileCallback)
const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = dirname(SCRIPTS_DIR)
const API_DIR = join(ROOT_DIR, 'packages', 'api')
const API_WRANGLER_CONFIG = join(API_DIR, 'wrangler.toml')
const BACKFILL_PATH = join(SCRIPTS_DIR, 'attribution-v3-backfill.sql')
const PRODUCTION_DATABASE = 'meigallery-db'
const WORKFLOW_NAME = 'meigallery-ad-platform-verification'
const MASTER_KEY_SECRET = 'AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT'

export const REQUIRED_AD_QUEUES = Object.freeze([...REQUIRED_PRODUCTION_AD_QUEUES])
export const LEGACY_AD_QUEUES = Object.freeze([
  'meigallery-meta-capi',
  'meigallery-meta-capi-dlq',
  'meigallery-tiktok-events',
  'meigallery-tiktok-events-dlq',
])

export function buildProductionCutoverSteps() {
  return [
    'verify:quick',
    'attribution:preflight',
    'd1:backup',
    'd1:expand',
    'worker:api',
    'worker:web',
    'attribution:backfill',
    'attribution:reconcile',
    'production:smoke',
  ]
}

export function assessAttributionV3Preflight(input) {
  const blockers = []
  if (integer(input.legacyServerEffectiveCount) !== 0) blockers.push('legacy_server_effective')
  if (integer(input.legacyActiveDeliveryCount) !== 0) blockers.push('legacy_delivery_active')
  if (integer(input.legacyOutboxCount) !== 0) blockers.push('legacy_outbox_not_empty')
  if (integer(input.googleServerEffectiveCount) !== 0) blockers.push('google_server_effective')
  if (input.masterKeyConfigured !== true) blockers.push('master_key_missing')
  if (input.workflowConfigured !== true) blockers.push('workflow_missing')

  const queues = new Map((input.queues || []).map(queue => [queue.name, queue]))
  if (REQUIRED_AD_QUEUES.some(name => queues.get(name)?.exists !== true)) {
    blockers.push('required_queue_missing')
  }
  if ([...REQUIRED_AD_QUEUES, ...LEGACY_AD_QUEUES].some(name => {
    const queue = queues.get(name)
    return queue?.exists === true && integer(queue.backlogCount) !== 0
  })) {
    blockers.push('queue_backlog_not_empty')
  }

  return {
    status: blockers.length === 0 ? 'passed' : 'failed',
    blockers,
    checks: {
      legacyServerEffectiveCount: integer(input.legacyServerEffectiveCount),
      legacyActiveDeliveryCount: integer(input.legacyActiveDeliveryCount),
      legacyOutboxCount: integer(input.legacyOutboxCount),
      googleServerEffectiveCount: integer(input.googleServerEffectiveCount),
      masterKeyConfigured: input.masterKeyConfigured === true,
      workflowConfigured: input.workflowConfigured === true,
      requiredQueueCount: REQUIRED_AD_QUEUES.filter(name => queues.get(name)?.exists === true).length,
      nonEmptyQueueCount: [...REQUIRED_AD_QUEUES, ...LEGACY_AD_QUEUES].filter(name => {
        const queue = queues.get(name)
        return queue?.exists === true && integer(queue.backlogCount) !== 0
      }).length,
    },
  }
}

export function assessAttributionV3Reconciliation(row) {
  const normalized = Object.fromEntries(Object.entries(row || {}).map(([key, value]) => [key, integer(value)]))
  const blockers = []
  if (normalized.uncovered_fact_count !== 0) blockers.push('historical_fact_uncovered')
  if (normalized.mapping_mismatch_count !== 0) blockers.push('canonical_mapping_mismatch')
  if (normalized.provider_mismatch_count !== 0) blockers.push('provider_mapping_mismatch')
  if (normalized.historical_external_id_count !== 0) blockers.push('historical_external_id_present')
  if (normalized.orphan_historical_fact_count !== 0) blockers.push('orphan_historical_fact')
  if (normalized.historical_delivery_count !== 0) blockers.push('historical_delivery_created')
  return {
    status: blockers.length === 0 ? 'passed' : 'failed',
    blockers,
    counts: normalized,
  }
}

export async function runProductionPreflight(options = {}) {
  const queryD1 = options.queryD1 || (sql => queryProductionD1(sql, options))
  const [legacyRows, attributionTableRows, secretNames, workflowConfigured, queues] = await Promise.all([
    queryD1(LEGACY_PREFLIGHT_SQL),
    queryD1(ATTRIBUTION_TABLE_EXISTS_SQL),
    (options.listSecretNames || (() => listProductionSecretNames(options)))(),
    (options.verifyWorkflow || (() => verifyProductionWorkflow(options)))(),
    (options.collectQueueStates || (() => collectProductionQueueStates(options)))(),
  ])
  const legacy = singleRow(legacyRows, 'ATTRIBUTION_PREFLIGHT_D1_RESULT_INVALID')
  const attributionTableExists = integer(singleRow(
    attributionTableRows,
    'ATTRIBUTION_PREFLIGHT_SCHEMA_RESULT_INVALID',
  ).attribution_table_exists) === 1
  const googleRows = attributionTableExists
    ? await queryD1(GOOGLE_PREFLIGHT_SQL)
    : [{ google_server_effective_count: 0 }]
  const google = singleRow(googleRows, 'ATTRIBUTION_PREFLIGHT_GOOGLE_RESULT_INVALID')

  return assessAttributionV3Preflight({
    legacyServerEffectiveCount: legacy.legacy_server_effective_count,
    legacyActiveDeliveryCount: legacy.legacy_active_delivery_count,
    legacyOutboxCount: legacy.legacy_outbox_count,
    googleServerEffectiveCount: google.google_server_effective_count,
    masterKeyConfigured: secretNames.includes(MASTER_KEY_SECRET),
    workflowConfigured,
    queues,
  })
}

export async function runProductionBackfill(options = {}) {
  const apply = options.apply === true
  const sql = await readFile(options.backfillPath || BACKFILL_PATH, 'utf8')
  if (!/INSERT\s+OR\s+IGNORE\s+INTO\s+attribution_conversion_facts/i.test(sql)) {
    throw new Error('ATTRIBUTION_BACKFILL_SQL_INVALID')
  }
  if (/\b(?:UPDATE|DELETE|DROP|ALTER)\b/i.test(stripSqlComments(sql))) {
    throw new Error('ATTRIBUTION_BACKFILL_SQL_MUTATION_INVALID')
  }
  if (!apply) return { status: 'passed', dryRun: true }

  const step = await runWrangler([
    'd1', 'execute', PRODUCTION_DATABASE,
    '--config', API_WRANGLER_CONFIG,
    '--env', '',
    '--remote',
    '--file', options.backfillPath || BACKFILL_PATH,
    '--yes',
  ], 'attribution-v3-backfill', options)
  ensurePassed(step, 'ATTRIBUTION_BACKFILL_FAILED')
  return { status: 'passed', dryRun: false }
}

export async function runProductionReconciliation(options = {}) {
  const rows = await (options.queryD1 || (sql => queryProductionD1(sql, options)))(RECONCILIATION_SQL)
  return assessAttributionV3Reconciliation(singleRow(rows, 'ATTRIBUTION_RECONCILIATION_RESULT_INVALID'))
}

export async function collectProductionQueueStates(options = {}) {
  const loadAuth = options.loadCloudflareAuth || (() => loadCloudflareAuth())
  const fetchFn = options.fetchFn || fetch
  const sleepFn = options.sleepFn || (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)))
  const { accountId, token } = await loadAuth()
  const queueList = await fetchCloudflareJson(
    fetchFn,
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/queues?per_page=100`,
    token,
    'ATTRIBUTION_QUEUE_LIST_FAILED',
  )
  const queueIds = new Map((queueList.result || []).map(queue => [queue.queue_name, queue.queue_id]))
  const names = [...REQUIRED_AD_QUEUES, ...LEGACY_AD_QUEUES]
  const sample = async () => Promise.all(names.map(async name => {
    const queueId = queueIds.get(name)
    if (!queueId) return { name, exists: false, backlogCount: 0 }
    const metrics = await fetchCloudflareJson(
      fetchFn,
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/queues/${queueId}/metrics`,
      token,
      'ATTRIBUTION_QUEUE_METRICS_FAILED',
    )
    const backlogCount = Number(metrics.result?.backlog_count)
    if (!Number.isSafeInteger(backlogCount) || backlogCount < 0) {
      throw new Error('ATTRIBUTION_QUEUE_METRICS_INVALID')
    }
    return { name, exists: true, backlogCount }
  }))

  const first = await sample()
  await sleepFn(options.queueSampleDelayMs ?? 2_000)
  const second = await sample()
  const firstMap = new Map(first.map(queue => [queue.name, queue]))
  return second.map(queue => ({
    ...queue,
    backlogCount: Math.max(queue.backlogCount, firstMap.get(queue.name)?.backlogCount || 0),
  }))
}

export async function main(options = {}) {
  const argv = options.argv || process.argv.slice(2)
  const stdout = options.stdout || process.stdout
  const command = argv[0]
  try {
    if (command === 'preflight') {
      const report = await runProductionPreflight(options)
      stdout.write(`${report.status === 'passed' ? 'ATTRIBUTION_V3_PREFLIGHT_PASSED' : 'ATTRIBUTION_V3_PREFLIGHT_FAILED'} ${safeReport(report)}\n`)
      return report.status === 'passed' ? 0 : 1
    }
    if (command === 'backfill') {
      const report = await runProductionBackfill({ ...options, apply: argv.includes('--apply') })
      stdout.write(`${report.dryRun ? 'ATTRIBUTION_V3_BACKFILL_DRY_RUN_PASSED' : 'ATTRIBUTION_V3_BACKFILL_PASSED'}\n`)
      return 0
    }
    if (command === 'reconcile') {
      const report = await runProductionReconciliation(options)
      stdout.write(`${report.status === 'passed' ? 'ATTRIBUTION_V3_RECONCILIATION_PASSED' : 'ATTRIBUTION_V3_RECONCILIATION_FAILED'} ${safeReport(report)}\n`)
      return report.status === 'passed' ? 0 : 1
    }
    stdout.write('用法: node scripts/verify-attribution-v3-migration.mjs <preflight|backfill|reconcile> [--apply]\n')
    return 1
  }
  catch (error) {
    stdout.write(`ATTRIBUTION_V3_COMMAND_FAILED code=${safeErrorCode(error)}\n`)
    return 1
  }
}

async function queryProductionD1(sql, options = {}) {
  const step = await runWrangler([
    'd1', 'execute', PRODUCTION_DATABASE,
    '--config', API_WRANGLER_CONFIG,
    '--env', '',
    '--remote',
    '--command', sql,
    '--json',
  ], 'attribution-v3-production-query', options)
  ensurePassed(step, 'ATTRIBUTION_D1_QUERY_FAILED')
  const parsed = JSON.parse(step.stdout)
  if (!Array.isArray(parsed) || !Array.isArray(parsed[0]?.results)) {
    throw new Error('ATTRIBUTION_D1_QUERY_RESULT_INVALID')
  }
  return parsed[0].results
}

async function listProductionSecretNames(options = {}) {
  const step = await runWrangler([
    'secret', 'list',
    '--config', API_WRANGLER_CONFIG,
    '--env', '',
    '--format', 'json',
  ], 'attribution-v3-secret-list', options)
  ensurePassed(step, 'ATTRIBUTION_SECRET_LIST_FAILED')
  const parsed = JSON.parse(step.stdout)
  if (!Array.isArray(parsed)) throw new Error('ATTRIBUTION_SECRET_LIST_RESULT_INVALID')
  return parsed.map(secret => String(secret?.name || '')).filter(Boolean)
}

async function verifyProductionWorkflow(options = {}) {
  const source = options.wranglerConfigSource ?? await readFile(API_WRANGLER_CONFIG, 'utf8')
  const workflowBlock = String(source).match(/\[\[workflows\]\]([\s\S]*?)(?=\n\[|$)/)?.[1] || ''
  return workflowBlock.includes(`name = "${WORKFLOW_NAME}"`)
    && workflowBlock.includes('binding = "AD_PLATFORM_VERIFICATION_WORKFLOW"')
    && workflowBlock.includes('class_name = "AdPlatformVerificationWorkflow"')
}

async function runWrangler(args, name, options = {}) {
  const runCommand = options.runCommand || defaultRunCommand
  return runCommand('corepack', ['pnpm', '--filter', '@meigallery/api', 'exec', 'wrangler', ...args], {
    cwd: ROOT_DIR,
    name,
  })
}

async function loadCloudflareAuth() {
  const [whoami, auth] = await Promise.all([
    privateWranglerJson(['whoami', '--json']),
    privateWranglerJson(['auth', 'token', '--json']),
  ])
  const accounts = whoami.accounts || whoami.result?.accounts || []
  const token = auth.token || auth.result?.token
  if (!Array.isArray(accounts) || accounts.length !== 1 || !accounts[0]?.id || typeof token !== 'string' || !token) {
    throw new Error('ATTRIBUTION_CLOUDFLARE_AUTH_AMBIGUOUS')
  }
  return { accountId: String(accounts[0].id), token }
}

async function privateWranglerJson(args) {
  try {
    const { stdout } = await execFile('corepack', [
      'pnpm', '--filter', '@meigallery/api', 'exec', 'wrangler', ...args,
    ], {
      cwd: ROOT_DIR,
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
    })
    return JSON.parse(stdout)
  }
  catch {
    throw new Error('ATTRIBUTION_CLOUDFLARE_AUTH_FAILED')
  }
}

async function fetchCloudflareJson(fetchFn, url, token, errorCode) {
  let response
  try {
    response = await fetchFn(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    })
  }
  catch {
    throw new Error(errorCode)
  }
  if (!response.ok) throw new Error(errorCode)
  const body = await response.json()
  if (body?.success !== true) throw new Error(errorCode)
  return body
}

function ensurePassed(step, code) {
  if (step?.status !== 'passed') throw new Error(code)
}

function singleRow(rows, code) {
  if (!Array.isArray(rows) || rows.length !== 1 || typeof rows[0] !== 'object' || rows[0] === null) {
    throw new Error(code)
  }
  return rows[0]
}

function integer(value) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : -1
}

function stripSqlComments(sql) {
  return String(sql).replace(/--[^\n]*/g, '')
}

function safeReport(report) {
  return JSON.stringify({ status: report.status, blockers: report.blockers, checks: report.checks, counts: report.counts })
}

function safeErrorCode(error) {
  const code = error instanceof Error ? error.message : String(error)
  return /^[A-Z0-9_]{3,96}$/.test(code) ? code : 'ATTRIBUTION_V3_UNKNOWN_ERROR'
}

const LEGACY_PREFLIGHT_SQL = `
SELECT
  (SELECT COUNT(*)
   FROM ad_platform_connections
   WHERE provider IN ('meta', 'tiktok')
     AND (server_enabled <> 0 OR rollout_percentage <> 0)) AS legacy_server_effective_count,
  (SELECT COUNT(*)
   FROM analytics_conversion_deliveries
   WHERE transport = 'server'
     AND (status IN ('pending', 'attempted', 'failed') OR delivery_lease_token <> '')) AS legacy_active_delivery_count,
  ((SELECT COUNT(*) FROM meta_capi_secure_outbox)
   + (SELECT COUNT(*) FROM ad_platform_secure_outbox)) AS legacy_outbox_count;
`

const ATTRIBUTION_TABLE_EXISTS_SQL = `
SELECT COUNT(*) AS attribution_table_exists
FROM sqlite_schema
WHERE type = 'table' AND name = 'attribution_platform_connections';
`

const GOOGLE_PREFLIGHT_SQL = `
SELECT COUNT(*) AS google_server_effective_count
FROM attribution_platform_connections
WHERE provider = 'google'
  AND (
    enabled <> 0
    OR server_enabled <> 0
    OR rollout_target_percentage <> 0
    OR rollout_effective_percentage <> 0
  );
`

const RECONCILIATION_SQL = `
WITH expected AS (
  SELECT
    id,
    dedupe_key,
    CASE action_type
      WHEN 'contact' THEN 'Contact'
      WHEN 'complete_registration' THEN 'CompleteRegistration'
    END AS canonical_event,
    CASE WHEN attribution_provider IN ('meta', 'tiktok', 'google') THEN attribution_provider ELSE NULL END AS provider
  FROM analytics_conversion_actions
  WHERE action_type IN ('contact', 'complete_registration')
)
SELECT
  (SELECT COUNT(*) FROM expected) AS legacy_standard_fact_count,
  (SELECT COUNT(*) FROM expected e JOIN attribution_conversion_facts f ON f.dedupe_key = e.dedupe_key) AS covered_fact_count,
  (SELECT COUNT(*) FROM expected e LEFT JOIN attribution_conversion_facts f ON f.dedupe_key = e.dedupe_key WHERE f.id IS NULL) AS uncovered_fact_count,
  (SELECT COUNT(*) FROM expected e JOIN attribution_conversion_facts f ON f.dedupe_key = e.dedupe_key WHERE f.canonical_event <> e.canonical_event) AS mapping_mismatch_count,
  (SELECT COUNT(*) FROM expected e JOIN attribution_conversion_facts f ON f.dedupe_key = e.dedupe_key WHERE f.attribution_provider IS NOT e.provider) AS provider_mismatch_count,
  (SELECT COUNT(*) FROM attribution_conversion_facts WHERE fact_origin = 'historical_backfill' AND external_event_id IS NOT NULL) AS historical_external_id_count,
  (SELECT COUNT(*) FROM attribution_conversion_facts f WHERE f.fact_origin = 'historical_backfill' AND NOT EXISTS (SELECT 1 FROM expected e WHERE e.dedupe_key = f.dedupe_key)) AS orphan_historical_fact_count,
  (SELECT COUNT(*) FROM attribution_deliveries d JOIN attribution_conversion_facts f ON f.id = d.fact_id WHERE f.fact_origin = 'historical_backfill') AS historical_delivery_count;
`

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main()
}
