#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import {
  assertReportCanGateProduction,
  collectVersions,
  fetchWithTimeout,
  getGitState,
  readLatestReport,
  runCommand,
  writeReport,
} from './release-verification-lib.mjs'
import { runDevRehearsalVerification } from './verify-dev-rehearsal.mjs'
import { runLocalRuntimeVerification } from './verify-local-runtime.mjs'

const PRODUCTION_IDENTITY_MAX_ATTEMPTS = 31
const PRODUCTION_IDENTITY_RETRY_DELAY_MS = 3_000
const DEFAULT_PRODUCTION_URLS = {
  VERIFY_PRODUCTION_API_URL: 'https://api.616618.xyz',
  VERIFY_PRODUCTION_WEB_URL: 'https://616618.xyz',
}
const FORBIDDEN_DEV_PLATFORM_HOSTS = [
  'graph.facebook.com',
  'connect.facebook.net',
  'business-api.tiktok.com',
  'analytics.tiktok.com',
  'googleads.googleapis.com',
  'www.googletagmanager.com',
]

const LOCAL_ATTRIBUTION_GATE_STEPS = [
  {
    name: 'attribution-final-schema',
    command: 'node',
    args: ['--test', 'packages/api/migrations/0055_attribution_tracking_integrity.test.mjs'],
  },
  {
    name: 'attribution-fact-source-integrity',
    command: 'node',
    args: ['--test', 'packages/api/migrations/0056_attribution_fact_source_integrity.test.mjs'],
  },
  {
    name: 'attribution-contact-aggregate-integrity',
    command: 'node',
    args: ['--test', 'packages/api/migrations/0057_contact_aggregate_integrity.test.mjs'],
  },
  {
    name: 'attribution-queue-mock',
    command: 'corepack',
    args: ['pnpm', '--filter', '@meigallery/api', 'exec', 'vitest', 'run',
      'src/services/ad-platform/queue-runtime.d1.test.ts',
      'src/services/ad-platform/recovery.test.ts'],
  },
  {
    name: 'attribution-workflow-mock',
    command: 'corepack',
    args: ['pnpm', '--filter', '@meigallery/api', 'exec', 'vitest', 'run',
      'src/workflows/ad-platform-verification.test.ts'],
  },
  {
    name: 'attribution-browser-isolation',
    command: 'corepack',
    args: ['pnpm', '--filter', '@meigallery/web', 'exec', 'playwright', 'test',
      'tests/e2e/ad-attribution-isolation.spec.ts', '--project=chromium', '--project=mobile-360'],
  },
]

const QUICK_STEPS = [
  ['dependency-install', 'corepack', ['pnpm', 'install', '--frozen-lockfile']],
  ['lint', 'corepack', ['pnpm', 'lint']],
  ['dev-resource-isolation', 'node', ['scripts/verify-dev-resources.mjs']],
  ['scripts-test', 'corepack', ['pnpm', 'test:scripts']],
  ['shared-unit', 'corepack', ['pnpm', '--filter', '@meigallery/shared', 'test']],
  ['api-unit', 'corepack', ['pnpm', '--filter', '@meigallery/api', 'test']],
  ['api-coverage', 'corepack', ['pnpm', '--filter', '@meigallery/api', 'run', 'test:coverage']],
  ['api-typecheck', 'corepack', ['pnpm', '--filter', '@meigallery/api', 'exec', 'tsc', '--noEmit']],
  ['web-typecheck', 'corepack', ['pnpm', '--filter', '@meigallery/web', 'run', 'typecheck']],
  ['web-unit', 'corepack', ['pnpm', '--filter', '@meigallery/web', 'run', 'test:unit']],
  ['web-e2e', 'corepack', ['pnpm', '--filter', '@meigallery/web', 'exec', 'playwright', 'test']],
  ['web-build', 'corepack', ['pnpm', '--filter', '@meigallery/web', 'exec', 'nuxt', 'build']],
  ['api-dry-run-deploy', 'corepack', ['pnpm', '--filter', '@meigallery/api', 'exec', 'wrangler', 'deploy', '--env=', '--dry-run', '--outdir=dist']],
].map(([name, command, args]) => ({ name, command, args }))

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main() }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const [mode] = argv
  if (!mode || mode === '--help' || mode === '-h') {
    printHelp()
    return
  }
  if (mode === 'assert-production-allowed') {
    await assertProductionAllowed(options)
    console.log('通用生产发布门禁已通过。')
    return
  }
  if (mode === 'assert-production-identity') {
    await assertProductionReleaseIdentity(options)
    console.log('production API/Web 发布 commit 与本地 Git HEAD 一致。')
    return
  }
  if (mode === 'assert-production-attribution') {
    const git = await (options.getGitState || getGitState)(options)
    await (options.collectTrustedProductionGateFacts || collectTrustedProductionGateFacts)({
      ...options,
      commit: git.commit,
    })
    console.log('production 通用归因状态校验通过。')
    return
  }
  const runners = {
    quick: runQuickVerification,
    'local-runtime': runLocalRuntimeReleaseVerification,
    'dev-rehearsal': runDevRehearsalReleaseVerification,
    release: runReleaseVerification,
  }
  const runner = runners[mode]
  if (!runner) throw new Error(`模式 ${mode} 尚未实现`)
  const report = await runner({ ...options, mode })
  if (report.status !== 'passed') throw new Error(`发布验证失败，报告已写入：${report.reportFile}`)
  console.log(`发布验证通过，报告已写入：${report.reportFile}`)
}

export async function runQuickVerification(options = {}) {
  const context = await reportContext(options, options.mode || 'quick')
  const steps = await runSteps(QUICK_STEPS, options)
  return finishReport(context, { steps, notes: failedNotes(steps), artifacts: [] }, options)
}

export async function runLocalAttributionGates(options = {}) {
  const steps = await runSteps(LOCAL_ATTRIBUTION_GATE_STEPS, options)
  return { steps, notes: failedNotes(steps), artifacts: [] }
}

export async function runLocalRuntimeReleaseVerification(options = {}) {
  const context = await reportContext(options, options.mode || 'local-runtime')
  const gates = await (options.runLocalAttributionGates || runLocalAttributionGates)(options)
  const gatesPassed = gates.steps.length === LOCAL_ATTRIBUTION_GATE_STEPS.length
    && gates.steps.every(step => step.status === 'passed')
  const runtime = gatesPassed
    ? await (options.runLocalRuntimeVerification || runLocalRuntimeVerification)(options)
    : { steps: [], notes: ['归因专项门禁失败，未启动本地运行时。'], artifacts: [] }
  return finishReport(context, {
    steps: [...gates.steps, ...(runtime.steps || [])],
    notes: [...(gates.notes || []), ...(runtime.notes || [])],
    artifacts: [...(gates.artifacts || []), ...(runtime.artifacts || [])],
    forceFailed: !gatesPassed || !runtime.steps?.length,
  }, options)
}

export async function verifyDevRehearsalPlatformIsolation(options = {}) {
  const started = Date.now()
  const cwd = options.cwd || process.cwd()
  try {
    const read = options.readFile || readFile
    const [wrangler, seed, rehearsal] = await Promise.all([
      read(new URL('packages/api/wrangler.toml', pathToFileURL(`${cwd}/`)), 'utf8'),
      read(new URL('scripts/fixtures/release-smoke/seed-dev.sql', pathToFileURL(`${cwd}/`)), 'utf8'),
      read(new URL('scripts/verify-dev-rehearsal.mjs', pathToFileURL(`${cwd}/`)), 'utf8'),
    ])
    if (!/\[env\.dev\.queues\][\s\S]*?producers\s*=\s*\[\][\s\S]*?consumers\s*=\s*\[\]/.test(wrangler)) {
      throw new Error('dev 环境仍绑定广告平台 Queue')
    }
    const connectionSeed = seed.match(/INSERT OR REPLACE INTO attribution_platform_connections[\s\S]*?;/)?.[0] || ''
    for (const provider of ['meta', 'tiktok', 'google']) {
      if (!new RegExp(`'${provider}',\\s*1,\\s*'test',\\s*0,\\s*0`).test(connectionSeed)) {
        throw new Error(`dev ${provider} 通道未关闭`)
      }
    }
    const forbiddenHost = FORBIDDEN_DEV_PLATFORM_HOSTS.find(host => seed.includes(host) || rehearsal.includes(host))
    if (forbiddenHost) throw new Error(`dev 禁止请求真实平台域名：${forbiddenHost}`)
    return step('dev-platform-network-isolation', 'passed', started, '静态核对 dev 广告资源隔离', 'dev 三平台网络与 Queue 均关闭')
  }
  catch (error) {
    return step('dev-platform-network-isolation', 'failed', started, '静态核对 dev 广告资源隔离', error instanceof Error ? error.message : String(error))
  }
}

export async function runDevRehearsalReleaseVerification(options = {}) {
  const context = await reportContext(options, options.mode || 'dev-rehearsal')
  const isolation = await (options.verifyDevRehearsalPlatformIsolation || verifyDevRehearsalPlatformIsolation)(options)
  const rehearsal = isolation.status === 'passed'
    ? await (options.runDevRehearsalVerification || runDevRehearsalVerification)({ ...options, releaseCommit: context.git.commit })
    : { steps: [], notes: [isolation.summary], artifacts: [] }
  return finishReport(context, {
    steps: [isolation, ...(rehearsal.steps || [])],
    notes: rehearsal.notes || [],
    artifacts: rehearsal.artifacts || [],
    forceFailed: isolation.status !== 'passed' || !rehearsal.steps?.length,
  }, options)
}

export async function runReleaseVerification(options = {}) {
  const context = await reportContext(options, options.mode || 'release')
  const allowed = context.git.isClean === true
    && isValidCommit(context.git.commit)
    && (context.git.branch === 'main' || context.git.branch?.startsWith('release/'))
  const notes = allowed ? [] : ['release 只允许干净的 main 或 release/* 40 位 commit。']
  const children = []
  if (allowed) {
    for (const [mode, optionName, defaultRunner] of [
      ['quick', 'runQuickVerification', runQuickVerification],
      ['local-runtime', 'runLocalRuntimeReleaseVerification', runLocalRuntimeReleaseVerification],
      ['dev-rehearsal', 'runDevRehearsalReleaseVerification', runDevRehearsalReleaseVerification],
    ]) {
      const runner = options[optionName] || defaultRunner
      const report = await runner({ ...options, mode })
      children.push({ mode, status: report.status, reportFile: report.reportFile || '' })
      if (report.status !== 'passed') break
    }
  }
  const steps = children.map(child => ({
    name: child.mode,
    status: child.status,
    durationMs: 0,
    command: `node scripts/verify-release.mjs ${child.mode}`,
    exitCode: child.status === 'passed' ? 0 : 1,
    summary: child.reportFile,
  }))
  return finishReport(context, {
    steps,
    notes,
    artifacts: children.map(child => child.reportFile).filter(Boolean),
    releaseSubModes: children,
    forceFailed: !allowed || children.length !== 3 || children.some(child => child.status !== 'passed'),
  }, options)
}

export async function assertProductionAllowed(options = {}) {
  const getGit = options.getGitState || getGitState
  const git = await getGit(options)
  if (git.branch !== 'main' || git.isClean !== true || !isValidCommit(git.commit)) {
    throw new Error('production 只允许干净的 main 40 位 commit')
  }
  const report = await (options.readLatestReport || readLatestReport)(options)
  ;(options.assertReportCanGateProduction || assertReportCanGateProduction)(report, {
    ...options,
    currentBranch: 'main',
    expectedCommit: git.commit,
  })
  return (options.collectTrustedProductionGateFacts || collectTrustedProductionGateFacts)({
    ...options,
    commit: git.commit,
    requireTrackingIntegrityMigration: false,
    requireFactSourceIntegrityMigration: false,
    requireContactAggregateIntegrityMigration: false,
  })
}

export async function collectTrustedProductionGateFacts(options = {}) {
  const commit = String(options.commit || '').trim().toLowerCase()
  if (!isValidCommit(commit)) throw new Error('通用生产门禁需要当前 40 位 commit')
  const state = await (options.queryProductionAttributionState || queryProductionAttributionState)(options)
  const blockers = [
    ['contractMigrationCount', value => value !== 1],
    ...(options.requireTrackingIntegrityMigration === false
      ? []
      : [['trackingIntegrityMigrationCount', value => value !== 1]]),
    ...(options.requireFactSourceIntegrityMigration === false
      ? []
      : [
          ['factSourceIntegrityMigrationCount', value => value !== 1],
          ['invalidFactSourceCount', value => value !== 0],
        ]),
    ...(options.requireContactAggregateIntegrityMigration === false
      ? []
      : [
          ['contactAggregateIntegrityMigrationCount', value => value !== 1],
          ['invalidContactDailyEventCount', value => value !== 0],
          ['invalidSourceContactClickCount', value => value !== 0],
        ]),
    ['privacyPolicyMigrationCount', value => value !== 1],
    ['privacyPolicyRowCount', value => value !== 1],
    ['invalidConnectionCount', value => value !== 0],
    ['openCriticalIncidentCount', value => value !== 0],
    ['expiredOutboxCount', value => value !== 0],
    ['deadLetterCount', value => value !== 0],
    ['invalidRolloutCount', value => value !== 0],
  ].filter(([key, invalid]) => invalid(integer(state[key]))).map(([key]) => key)
  if (blockers.length > 0) throw new Error(`通用 production 归因门禁未通过：${blockers.join(',')}`)
  return { status: 'passed', commit, ...state }
}

export async function assertProductionReleaseIdentity(options = {}) {
  const git = await (options.getGitState || getGitState)(options)
  if (git.branch !== 'main' || git.isClean !== true || !isValidCommit(git.commit)) {
    throw new Error('production 发布后 identity 校验只允许干净的 main 40 位 commit')
  }
  const verify = options.verifyProductionReleaseIdentity || verifyProductionReleaseIdentity
  const attempts = Number.isSafeInteger(options.identityMaxAttempts) && options.identityMaxAttempts > 0
    ? options.identityMaxAttempts
    : PRODUCTION_IDENTITY_MAX_ATTEMPTS
  const delayMs = Number.isFinite(options.identityRetryDelayMs) && options.identityRetryDelayMs >= 0
    ? options.identityRetryDelayMs
    : PRODUCTION_IDENTITY_RETRY_DELAY_MS
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return await verify({ ...options, commit: git.commit.toLowerCase() }) }
    catch (error) {
      lastError = error
      if (attempt < attempts) await (options.sleep || sleep)(delayMs)
    }
  }
  throw new Error(`${lastError instanceof Error ? lastError.message : String(lastError)}；连续 ${attempts} 次检查未通过`)
}

export async function verifyProductionReleaseIdentity(options = {}) {
  const commit = String(options.commit || '').trim().toLowerCase()
  if (!isValidCommit(commit)) throw new Error('本地 Git HEAD 必须为 40 位 SHA')
  const env = options.env || process.env
  const fetchFn = options.fetch || fetch
  await Promise.all(Object.entries(DEFAULT_PRODUCTION_URLS).map(async ([key, fallback]) => {
    const origin = productionOrigin(env[key] || fallback, key)
    const endpoint = key === 'VERIFY_PRODUCTION_API_URL' ? '/api/health' : '/__release'
    const response = await fetchWithTimeout(fetchFn, new URL(endpoint, origin), {
      headers: { Accept: 'application/json' },
    }, options.requestTimeoutMs ?? 10_000)
    const body = response.ok ? await response.json().catch(() => null) : null
    if (!body || body.status !== 'ok' || body.environment !== 'production' || body.commit !== commit) {
      throw new Error(`${key} 发布 commit 与本地 Git HEAD 不一致`)
    }
  }))
}

async function queryProductionAttributionState(options = {}) {
  const sql = `
    SELECT
      (SELECT COUNT(*) FROM d1_migrations WHERE name = '0052_unified_attribution_contract.sql') AS contract_migration_count,
      (SELECT COUNT(*) FROM d1_migrations WHERE name = '0055_attribution_tracking_integrity.sql') AS tracking_integrity_migration_count,
      (SELECT COUNT(*) FROM d1_migrations WHERE name = '0056_attribution_fact_source_integrity.sql') AS fact_source_integrity_migration_count,
      (SELECT COUNT(*) FROM d1_migrations WHERE name = '0057_contact_aggregate_integrity.sql') AS contact_aggregate_integrity_migration_count,
      (SELECT COUNT(*) FROM d1_migrations WHERE name = '0053_attribution_privacy_policy.sql') AS privacy_policy_migration_count,
      (SELECT COUNT(*) FROM attribution_privacy_policy WHERE id = 'global') AS privacy_policy_row_count,
      (SELECT COUNT(*) FROM attribution_platform_connections AS connection
        WHERE connection.enabled = 1 AND connection.mode = 'production'
          AND NOT EXISTS (
            SELECT 1 FROM attribution_verifications AS verification
            WHERE verification.connection_id = connection.id
              AND verification.provider = connection.provider
              AND verification.connection_revision = connection.connection_revision
              AND verification.credential_revision = connection.credential_revision
              AND verification.status = 'verified'
          )) AS invalid_connection_count,
      (SELECT COUNT(*) FROM attribution_incidents WHERE status = 'open' AND severity = 'critical') AS open_critical_incident_count,
      (SELECT COUNT(*) FROM attribution_outbox WHERE datetime(expires_at) <= datetime('now')) AS expired_outbox_count,
      (SELECT COUNT(*) FROM attribution_deliveries WHERE status = 'dead_letter') AS dead_letter_count,
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
        )) AS invalid_fact_source_count,
      (SELECT COUNT(*) FROM (
        SELECT * FROM (
          SELECT
            date(datetime(occurred_at, '+8 hours')) AS date,
            entity_type,
            entity_id,
            COUNT(*) AS event_count
          FROM analytics_events
          WHERE event_name = 'contact_method_click'
          GROUP BY date(datetime(occurred_at, '+8 hours')), entity_type, entity_id
          EXCEPT
          SELECT date, entity_type, entity_id, event_count
          FROM analytics_daily_events
          WHERE event_name = 'contact_method_click'
        )
        UNION ALL
        SELECT * FROM (
          SELECT date, entity_type, entity_id, event_count
          FROM analytics_daily_events
          WHERE event_name = 'contact_method_click'
          EXCEPT
          SELECT
            date(datetime(occurred_at, '+8 hours')) AS date,
            entity_type,
            entity_id,
            COUNT(*) AS event_count
          FROM analytics_events
          WHERE event_name = 'contact_method_click'
          GROUP BY date(datetime(occurred_at, '+8 hours')), entity_type, entity_id
        )
      )) AS invalid_contact_daily_event_count,
      (SELECT COUNT(*) FROM (
        SELECT * FROM (
          SELECT
            date(datetime(event.occurred_at, '+8 hours')) AS date,
            summary.source_channel,
            summary.source_name,
            summary.invite_code_id,
            COUNT(*) AS click_count
          FROM analytics_events AS event
          JOIN analytics_session_summaries AS summary
            ON summary.session_id = event.session_id
          WHERE event.event_name = 'contact_method_click'
            AND (
              summary.source_channel != 'direct'
              OR summary.invite_code_id != ''
              OR (summary.source_name != '' AND summary.source_name != 'direct')
            )
          GROUP BY
            date(datetime(event.occurred_at, '+8 hours')),
            summary.source_channel, summary.source_name, summary.invite_code_id
          EXCEPT
          SELECT
            date, source_channel, source_name, invite_code_id,
            SUM(effective_click_count)
          FROM analytics_source_click_daily
          WHERE element_id = 'contact_method_click'
          GROUP BY date, source_channel, source_name, invite_code_id
        )
        UNION ALL
        SELECT * FROM (
          SELECT
            date, source_channel, source_name, invite_code_id,
            SUM(effective_click_count)
          FROM analytics_source_click_daily
          WHERE element_id = 'contact_method_click'
          GROUP BY date, source_channel, source_name, invite_code_id
          EXCEPT
          SELECT
            date(datetime(event.occurred_at, '+8 hours')) AS date,
            summary.source_channel,
            summary.source_name,
            summary.invite_code_id,
            COUNT(*) AS click_count
          FROM analytics_events AS event
          JOIN analytics_session_summaries AS summary
            ON summary.session_id = event.session_id
          WHERE event.event_name = 'contact_method_click'
            AND (
              summary.source_channel != 'direct'
              OR summary.invite_code_id != ''
              OR (summary.source_name != '' AND summary.source_name != 'direct')
            )
          GROUP BY
            date(datetime(event.occurred_at, '+8 hours')),
            summary.source_channel, summary.source_name, summary.invite_code_id
        )
      )) AS invalid_source_contact_click_count,
      (SELECT COUNT(*) FROM attribution_platform_connections
        WHERE rollout_effective_percentage > rollout_target_percentage
          OR (server_enabled = 0 AND rollout_effective_percentage <> 0)) AS invalid_rollout_count;
  `.replace(/\s+/g, ' ').trim()
  const result = await (options.runCommand || runCommand)('corepack', [
    'pnpm', '--filter', '@meigallery/api', 'exec', 'wrangler', 'd1', 'execute', 'meigallery-db',
    '--env', '', '--remote', '--command', sql, '--json',
  ], { cwd: options.cwd || process.cwd(), name: 'attribution-production-gate', reportCommand: '读取 production 通用归因门禁' })
  if (result.status !== 'passed') throw new Error('production 通用归因状态查询失败')
  try {
    const parsed = JSON.parse(result.stdout)
    const row = parsed?.[0]?.results?.[0]
    if (!row) throw new Error()
    return Object.fromEntries(Object.entries(row).map(([key, value]) => [toCamel(key), integer(value)]))
  }
  catch { throw new Error('production 通用归因状态响应无效') }
}

async function reportContext(options, mode) {
  return {
    mode,
    startedAt: new Date().toISOString(),
    startedMs: Date.now(),
    git: await (options.getGitState || getGitState)(options),
    versions: await (options.collectVersions || collectVersions)(options),
  }
}

async function finishReport(context, input, options) {
  const report = {
    schemaVersion: 1,
    mode: context.mode,
    status: !input.forceFailed && input.steps.length > 0 && input.steps.every(item => item.status === 'passed') ? 'passed' : 'failed',
    startedAt: context.startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - context.startedMs,
    git: context.git,
    versions: context.versions,
    steps: input.steps.map(({ stdout: _stdout, stderr: _stderr, logs: _logs, ...item }) => item),
    artifacts: input.artifacts || [],
    notes: input.notes || [],
    ...(input.releaseSubModes ? { releaseSubModes: input.releaseSubModes } : {}),
  }
  return { ...report, ...await (options.writeReport || writeReport)(report, options) }
}

async function runSteps(definitions, options) {
  const steps = []
  for (const definition of definitions) {
    const result = await (options.runCommand || runCommand)(definition.command, definition.args, {
      cwd: options.cwd || process.cwd(),
      name: definition.name,
    })
    steps.push(result)
    if (result.status !== 'passed') break
  }
  return steps
}

function failedNotes(steps) {
  const failed = steps.find(item => item.status !== 'passed')
  return failed ? [`步骤 ${failed.name} 失败，后续步骤已停止。`] : []
}

function productionOrigin(value, label) {
  try {
    const url = new URL(String(value || ''))
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error()
    return url
  }
  catch { throw new Error(`${label} 必须是无凭证的 production HTTPS 地址`) }
}

function step(name, status, started, command, summary) {
  return { name, status, durationMs: Date.now() - started, command, exitCode: status === 'passed' ? 0 : 1, summary }
}

function isValidCommit(value) { return /^[0-9a-f]{40}$/i.test(String(value || '').trim()) }
function integer(value) { const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : -1 }
function toCamel(value) { return String(value).replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase()) }
function sleep(delayMs) { return new Promise(resolve => setTimeout(resolve, delayMs)) }

function printHelp() {
  console.log(`用法：
  node scripts/verify-release.mjs quick
  node scripts/verify-release.mjs local-runtime
  node scripts/verify-release.mjs dev-rehearsal
  node scripts/verify-release.mjs release
  node scripts/verify-release.mjs assert-production-allowed
  node scripts/verify-release.mjs assert-production-attribution
  node scripts/verify-release.mjs assert-production-identity`)
}
