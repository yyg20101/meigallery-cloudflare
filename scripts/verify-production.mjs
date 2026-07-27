#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'

const execFileAsync = promisify(execFile)
const ENDPOINTS = {
  api: 'https://api.616618.xyz/api/health',
  web: 'https://616618.xyz/__release',
}
const MAX_ATTEMPTS = 10
const RETRY_DELAY_MS = 2_000

export async function verifyProduction(scope = 'all', options = {}) {
  const targets = scope === 'all' ? ['api', 'web'] : [scope]
  if (!targets.every(target => target === 'api' || target === 'web')) {
    throw new Error('PRODUCTION_VERIFY_SCOPE_INVALID')
  }

  const endpointResults = await Promise.all(targets.map(target => verifyEndpoint(target, options)))
  let attribution = null
  if (targets.includes('api')) {
    attribution = await queryAttributionState(options)
    assertAttributionStructure(attribution)
  }
  return {
    status: 'passed',
    endpoints: endpointResults,
    attribution,
    warnings: attribution ? attributionWarnings(attribution) : [],
  }
}

export function assertAttributionStructure(state) {
  const blockers = [
    ['attributionCoreTableCount', state.attributionCoreTableCount !== 9],
    ['obsoleteAttributionTableCount', state.obsoleteAttributionTableCount !== 0],
  ].filter(([, blocked]) => blocked).map(([name]) => name)
  if (blockers.length > 0) {
    throw new Error(`PRODUCTION_ATTRIBUTION_STRUCTURE_INVALID:${blockers.join(',')}`)
  }
}

export function attributionWarnings(state) {
  return [
    ['invalidConnectionCount', state.invalidConnectionCount],
    ['openCriticalIncidentCount', state.openCriticalIncidentCount],
    ['expiredOutboxCount', state.expiredOutboxCount],
    ['deadLetterCount', state.deadLetterCount],
    ['invalidFactSourceCount', state.invalidFactSourceCount],
  ].filter(([, value]) => Number(value) > 0).map(([name, value]) => `${name}=${value}`)
}

export async function queryAttributionState(options = {}) {
  const sql = `
    SELECT
      (SELECT COUNT(*) FROM sqlite_master
        WHERE type = 'table'
          AND name IN (
            'attribution_platform_connections',
            'attribution_event_bindings',
            'attribution_credentials',
            'attribution_conversion_facts',
            'attribution_deliveries',
            'attribution_outbox',
            'attribution_provider_receipts',
            'attribution_incidents',
            'attribution_quality_snapshots'
          )) AS attribution_core_table_count,
      (SELECT COUNT(*) FROM sqlite_master
        WHERE type = 'table'
          AND (
            name LIKE 'meta_%'
            OR name LIKE 'tiktok_%'
            OR name LIKE 'attribution_runtime_%'
            OR name IN (
              'attribution_privacy_policy',
              'attribution_verifications',
              'attribution_business_outbox'
            )
          )) AS obsolete_attribution_table_count,
      (SELECT COUNT(*)
        FROM attribution_platform_connections AS connection
        WHERE connection.enabled = 1
          AND (
            (connection.browser_enabled = 0 AND connection.server_enabled = 0)
            OR 1 <> (
              SELECT COUNT(*)
              FROM attribution_credentials AS credential
              WHERE credential.connection_id = connection.id
            )
            OR 2 <> (
              SELECT COUNT(*)
              FROM attribution_event_bindings AS binding
              WHERE binding.connection_id = connection.id
                AND binding.enabled = 1
                AND binding.canonical_event IN ('Contact', 'CompleteRegistration')
            )
          )) AS invalid_connection_count,
      (SELECT COUNT(*) FROM attribution_incidents
        WHERE status = 'open' AND severity = 'critical')
        AS open_critical_incident_count,
      (SELECT COUNT(*) FROM attribution_outbox
        WHERE datetime(expires_at) <= datetime('now'))
        AS expired_outbox_count,
      (SELECT COUNT(*) FROM attribution_deliveries
        WHERE status = 'dead_letter')
        AS dead_letter_count,
      (SELECT COUNT(*) FROM attribution_conversion_facts
        WHERE (
          attribution_provider IS NULL
          AND attribution_source NOT IN ('none', 'conflict')
        ) OR (
          attribution_provider IS NOT NULL
          AND (
            attribution_provider NOT IN ('meta', 'tiktok', 'google')
            OR attribution_source NOT IN ('click_id', 'managed_link')
          )
        )) AS invalid_fact_source_count;
  `.replace(/\s+/g, ' ').trim()

  const run = options.runCommand || runCommand
  const result = await run('corepack', [
    'pnpm', '--filter', '@meigallery/api', 'exec', 'wrangler',
    'd1', 'execute', 'meigallery-db', '--env', '', '--remote',
    '--command', sql, '--json',
  ], { cwd: options.cwd || process.cwd() })
  if (result.exitCode !== 0) throw new Error('PRODUCTION_ATTRIBUTION_QUERY_FAILED')

  try {
    const parsed = JSON.parse(result.stdout)
    const row = parsed?.[0]?.results?.[0]
    if (!row) throw new Error()
    return Object.fromEntries(Object.entries(row).map(([key, value]) => [
      toCamel(key),
      nonNegativeInteger(value),
    ]))
  }
  catch {
    throw new Error('PRODUCTION_ATTRIBUTION_RESPONSE_INVALID')
  }
}

async function verifyEndpoint(target, options) {
  const fetcher = options.fetch || fetch
  const sleep = options.sleep || (delay => new Promise(resolve => setTimeout(resolve, delay)))
  const maxAttempts = options.maxAttempts || MAX_ATTEMPTS
  const retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS
  const url = options.endpoints?.[target] || ENDPOINTS[target]
  let lastError

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetcher(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      })
      const body = response.ok ? await response.json() : null
      if (!body || body.status !== 'ok' || body.environment !== 'production') throw new Error()
      return { target, url, attempt }
    }
    catch (error) {
      lastError = error
      if (attempt < maxAttempts) await sleep(retryDelayMs)
    }
  }
  throw new Error(`PRODUCTION_${target.toUpperCase()}_UNAVAILABLE:${String(lastError || '')}`)
}

async function runCommand(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    })
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr }
  }
  catch (error) {
    return {
      exitCode: Number.isInteger(error?.code) ? error.code : 1,
      stdout: String(error?.stdout || ''),
      stderr: String(error?.stderr || ''),
    }
  }
}

function toCamel(value) {
  return String(value).replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase())
}

function nonNegativeInteger(value) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error()
  return parsed
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const result = await verifyProduction(argv[0] || 'all', options)
  for (const warning of result.warnings) console.warn(`生产归因警告：${warning}`)
  console.log('生产可用性验证通过。')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main()
  }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
