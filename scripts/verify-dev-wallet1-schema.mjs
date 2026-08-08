#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { parsePendingMigrations, WALLET1_DEV_DATABASE, WALLET1_POLICY_ID } from './prepare-dev-wallet1.mjs'

const execFileAsync = promisify(execFile)
const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = dirname(SCRIPTS_DIR)
const API_WRANGLER_CONFIG = join(ROOT_DIR, 'packages', 'api', 'wrangler.toml')

export const WALLET1_DEV_API_BASE_URL = 'https://meigallery-api-dev.wajie.workers.dev'
export const WALLET1_CONTRACT_VERSION = '1.10.0'

export const WALLET1_EXPECTED_TABLES = Object.freeze([
  'app_membership_applications',
  'app_membership_application_events',
  'app_membership_application_requests',
  'app_notification_policies',
  'app_notification_event_definitions',
  'app_notification_template_versions',
  'app_notification_preferences',
  'app_notification_preference_events',
  'app_notification_outbox',
  'app_notifications',
  'app_notification_read_events',
  'app_wallet_policies',
  'app_wallets',
  'app_wallet_adjustments',
  'app_wallet_entries',
  'app_wallet_adjustment_events',
  'app_wallet_review_requests',
])

export const WALLET1_EXPECTED_TRIGGERS = Object.freeze([
  'app_notification_from_platform_reply',
  'app_notification_from_membership_application_event',
  'app_notification_from_membership_grant',
  'app_notification_from_membership_revocation',
  'app_notification_from_safety_report_event',
  'app_notification_from_safety_appeal_event',
  'app_notification_from_account_security_event',
  'trg_app_wallet_entries_immutable_update',
  'trg_app_wallet_entries_immutable_delete',
  'trg_app_wallet_balance_requires_entry',
  'trg_app_wallet_adjustment_events_immutable_update',
  'trg_app_wallet_adjustment_events_immutable_delete',
  'trg_app_wallet_review_requests_immutable_update',
  'trg_app_wallet_review_requests_immutable_delete',
  'trg_app_wallet_entry_notification_outbox',
])

export async function verifyWallet1DevSchema(options = {}) {
  requireDevConfirmation(options.confirmDev)

  const expectedCommit = await (options.getGitCommit || (() => getGitCommit(options)))()
  if (!/^[0-9a-f]{40}$/u.test(expectedCommit)) throw new Error('WALLET1_SCHEMA_GIT_COMMIT_INVALID')

  const requestJson = options.requestJson || defaultRequestJson
  const [health, bootstrap, pendingMigrations, snapshot] = await Promise.all([
    requestJson(`${WALLET1_DEV_API_BASE_URL}/api/health`),
    requestJson(`${WALLET1_DEV_API_BASE_URL}/api/v2/app/bootstrap`),
    (options.listPendingMigrations || (() => listRemotePendingMigrations(options)))(),
    (options.getSchemaSnapshot || (() => getRemoteSchemaSnapshot(options)))(),
  ])

  validateHealth(health, expectedCommit)
  validateBootstrap(bootstrap)
  if (!Array.isArray(pendingMigrations) || pendingMigrations.length !== 0) {
    throw new Error('WALLET1_SCHEMA_PENDING_MIGRATIONS_REMAIN')
  }
  validateSchemaSnapshot(snapshot)

  return {
    status: 'passed',
    gitCommit: expectedCommit,
    contractVersion: bootstrap.meta.contractVersion,
    tableCount: Number(snapshot.expected_table_count),
    triggerCount: Number(snapshot.expected_trigger_count),
  }
}

export function validateHealth(health, expectedCommit) {
  if (health?.status !== 'ok' || health?.environment !== 'dev' || health?.commit !== expectedCommit) {
    throw new Error('WALLET1_SCHEMA_DEV_RELEASE_MISMATCH')
  }
  return true
}

export function validateBootstrap(bootstrap) {
  if (bootstrap?.meta?.contractVersion !== WALLET1_CONTRACT_VERSION) {
    throw new Error('WALLET1_SCHEMA_CONTRACT_VERSION_MISMATCH')
  }
  if (bootstrap?.data?.capabilities?.wallet !== false
    || bootstrap?.data?.capabilities?.payments !== false
    || bootstrap?.data?.capabilities?.systemPush !== false) {
    throw new Error('WALLET1_SCHEMA_PUBLIC_CAPABILITY_NOT_CLOSED')
  }
  const wallet = bootstrap?.data?.wallet
  if (wallet?.policyVersion !== WALLET1_POLICY_ID
    || wallet?.payments !== false
    || wallet?.recharge !== false
    || wallet?.spending !== false
    || wallet?.transfer !== false
    || wallet?.withdrawal !== false) {
    throw new Error('WALLET1_SCHEMA_TRANSACTION_BOUNDARY_NOT_CLOSED')
  }
  return true
}

export function validateSchemaSnapshot(snapshot) {
  const expected = {
    expected_table_count: WALLET1_EXPECTED_TABLES.length,
    expected_trigger_count: WALLET1_EXPECTED_TRIGGERS.length,
    wallet_policy_total: 1,
    wallet_policy_safe: 1,
    wallet_count: 0,
    wallet_adjustment_count: 0,
    wallet_entry_count: 0,
    wallet_event_count: 0,
    wallet_review_count: 0,
    notification_unsafe_policy_count: 0,
    wallet_notification_event_safe: 1,
    wallet_notification_template_safe: 1,
    wallet_notification_outbox_count: 0,
  }

  for (const [field, value] of Object.entries(expected)) {
    if (Number(snapshot?.[field]) !== value) {
      throw new Error(`WALLET1_SCHEMA_SNAPSHOT_UNSAFE_${field.toUpperCase()}`)
    }
  }
  return true
}

export function parseD1Rows(output) {
  const payload = typeof output === 'string' ? JSON.parse(output) : output
  const queue = Array.isArray(payload) ? [...payload] : [payload]
  while (queue.length > 0) {
    const current = queue.shift()
    if (!current || typeof current !== 'object') continue
    if (Array.isArray(current.results)) return current.results
    if (current.result) queue.push(current.result)
    if (current.data) queue.push(current.data)
  }
  throw new Error('WALLET1_SCHEMA_D1_RESULT_INVALID')
}

export async function main(options = {}) {
  const stdout = options.stdout || process.stdout
  const argv = options.argv || process.argv.slice(2)
  const confirmDev = readArgument(argv, '--confirm-dev')
  try {
    const result = await verifyWallet1DevSchema({ ...options, confirmDev })
    stdout.write(`WALLET1_DEV_SCHEMA_VERIFIED commit=${result.gitCommit} contract=${result.contractVersion} tables=${result.tableCount} triggers=${result.triggerCount}\n`)
    return 0
  }
  catch (error) {
    stdout.write(`WALLET1_DEV_SCHEMA_FAILED code=${safeErrorCode(error)}\n`)
    return 1
  }
}

async function getGitCommit(options = {}) {
  const step = await runCommand('git', ['rev-parse', 'HEAD'], 'wallet1-schema-git-commit', options)
  ensurePassed(step, 'WALLET1_SCHEMA_GIT_COMMIT_FAILED')
  return step.stdout.trim()
}

async function listRemotePendingMigrations(options = {}) {
  const step = await runWrangler([
    'd1', 'migrations', 'list', WALLET1_DEV_DATABASE,
    '--config', API_WRANGLER_CONFIG,
    '--env', 'dev',
    '--remote',
  ], 'wallet1-schema-list-migrations', options)
  ensurePassed(step, 'WALLET1_SCHEMA_MIGRATION_LIST_FAILED')
  return parsePendingMigrations(`${step.stdout}\n${step.stderr}`)
}

async function getRemoteSchemaSnapshot(options = {}) {
  const step = await runWrangler([
    'd1', 'execute', WALLET1_DEV_DATABASE,
    '--config', API_WRANGLER_CONFIG,
    '--env', 'dev',
    '--remote',
    '--yes',
    '--json',
    '--command', buildSchemaQuery(),
  ], 'wallet1-schema-query', options)
  ensurePassed(step, 'WALLET1_SCHEMA_D1_QUERY_FAILED')
  const rows = parseD1Rows(step.stdout)
  if (rows.length !== 1) throw new Error('WALLET1_SCHEMA_D1_ROW_COUNT_INVALID')
  return rows[0]
}

function buildSchemaQuery() {
  const tableNames = WALLET1_EXPECTED_TABLES.map(sqlString).join(', ')
  const triggerNames = WALLET1_EXPECTED_TRIGGERS.map(sqlString).join(', ')
  return `
SELECT
  (SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name IN (${tableNames})) AS expected_table_count,
  (SELECT COUNT(*) FROM sqlite_schema WHERE type = 'trigger' AND name IN (${triggerNames})) AS expected_trigger_count,
  (SELECT COUNT(*) FROM app_wallet_policies) AS wallet_policy_total,
  (SELECT COUNT(*) FROM app_wallet_policies
    WHERE id = '${WALLET1_POLICY_ID}'
      AND state = 'development'
      AND production_ready = 0
      AND adjustments_enabled = 0
      AND risk_decision_status = 'unresolved'
      AND retention_decision_status = 'unresolved'
      AND data_location_decision_status = 'unresolved'
      AND require_independent_review = 1
      AND allow_negative_balance = 0
      AND batch_adjustments_enabled = 0
      AND migration_entries_enabled = 0
      AND retention_days IS NULL) AS wallet_policy_safe,
  (SELECT COUNT(*) FROM app_wallets) AS wallet_count,
  (SELECT COUNT(*) FROM app_wallet_adjustments) AS wallet_adjustment_count,
  (SELECT COUNT(*) FROM app_wallet_entries) AS wallet_entry_count,
  (SELECT COUNT(*) FROM app_wallet_adjustment_events) AS wallet_event_count,
  (SELECT COUNT(*) FROM app_wallet_review_requests) AS wallet_review_count,
  (SELECT COUNT(*) FROM app_notification_policies
    WHERE production_ready <> 0
       OR generation_enabled <> 0
       OR purge_enabled <> 0
       OR decision_status <> 'unresolved') AS notification_unsafe_policy_count,
  (SELECT COUNT(*) FROM app_notification_event_definitions
    WHERE id = 'nde_wallet_entry_posted'
      AND event_type = 'wallet.entry_posted'
      AND source_domain = 'wallet'
      AND target_type = 'wallet_entry'
      AND action = 'open_wallet_entry'
      AND necessity = 'required'
      AND active = 1) AS wallet_notification_event_safe,
  (SELECT COUNT(*) FROM app_notification_template_versions
    WHERE id = 'ntv_wallet_entry_posted_v1'
      AND event_definition_id = 'nde_wallet_entry_posted'
      AND state = 'development') AS wallet_notification_template_safe,
  (SELECT COUNT(*) FROM app_notification_outbox
    WHERE event_type = 'wallet.entry_posted') AS wallet_notification_outbox_count;
`.trim()
}

async function defaultRequestJson(url) {
  let response
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  }
  catch {
    throw new Error('WALLET1_SCHEMA_DEV_API_REQUEST_FAILED')
  }
  if (!response.ok) throw new Error('WALLET1_SCHEMA_DEV_API_STATUS_INVALID')
  try {
    return await response.json()
  }
  catch {
    throw new Error('WALLET1_SCHEMA_DEV_API_JSON_INVALID')
  }
}

async function runWrangler(args, name, options = {}) {
  return runCommand('corepack', ['pnpm', '--filter', '@meigallery/api', 'exec', 'wrangler', ...args], name, options)
}

async function runCommand(command, args, name, options = {}) {
  if (options.runCommand) return options.runCommand(command, args, { cwd: ROOT_DIR, name })
  try {
    const result = await execFileAsync(command, args, {
      cwd: ROOT_DIR,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    })
    return { status: 'passed', stdout: result.stdout, stderr: result.stderr }
  }
  catch (error) {
    return {
      status: 'failed',
      stdout: String(error?.stdout || ''),
      stderr: String(error?.stderr || ''),
    }
  }
}

function requireDevConfirmation(value) {
  if (value !== WALLET1_DEV_DATABASE) throw new Error('WALLET1_SCHEMA_DEV_CONFIRMATION_REQUIRED')
}

function ensurePassed(step, code) {
  if (step?.status !== 'passed') throw new Error(code)
}

function readArgument(argv, name) {
  const prefix = `${name}=`
  return argv.find(argument => argument.startsWith(prefix))?.slice(prefix.length)
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

function safeErrorCode(error) {
  const code = error instanceof Error ? error.message : String(error)
  return /^[A-Z0-9_]{3,160}$/u.test(code) ? code : 'WALLET1_SCHEMA_UNKNOWN_ERROR'
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main()
}
