import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCommand } from './release-verification-lib.mjs'

const ROOT_DIR = fileURLToPath(new URL('../', import.meta.url))
const PRE_MIGRATION_FILE = 'pre-0034.sql'

const HISTORICAL_DELIVERIES = [
  {
    id: 'delivery_pixel',
    conversion_action_id: 'action_legacy',
    channel: 'meta_pixel',
    external_event_id: 'meta:Contact:old_pixel',
    event_name: 'Contact',
    status: 'sent',
    skip_reason: '',
    error_code: '',
    error_message: '',
    attempt_count: 2,
    last_attempt_at: '2026-07-10T00:00:00.000Z',
    sent_at: '2026-07-10T00:01:00.000Z',
    created_at: '2026-07-09T00:00:00.000Z',
    updated_at: '2026-07-10T00:01:00.000Z',
  },
  {
    id: 'delivery_capi',
    conversion_action_id: 'action_legacy',
    channel: 'meta_capi',
    external_event_id: 'meta:Contact:old_capi',
    event_name: 'Contact',
    status: 'pending',
    skip_reason: '',
    error_code: '',
    error_message: '',
    attempt_count: 0,
    last_attempt_at: null,
    sent_at: null,
    created_at: '2026-07-09T00:00:00.000Z',
    updated_at: '2026-07-09T00:00:00.000Z',
  },
]

export async function runMetaMigrationVerification(options = {}) {
  const rootDir = options.rootDir || ROOT_DIR
  const apiDir = path.join(rootDir, 'packages', 'api')
  const migrationDir = path.join(apiDir, 'migrations')
  const stateDir = path.join(rootDir, '.wrangler-release-verify', 'meta-migration')
  const preMigrationPath = path.join(stateDir, PRE_MIGRATION_FILE)
  const persistTo = path.relative(apiDir, stateDir)
  const preMigrationRelativePath = path.relative(apiDir, preMigrationPath)
  const migration0034RelativePath = path.relative(apiDir, path.join(migrationDir, '0034_meta_production_readiness.sql'))
  const runCommandFn = options.runCommand || runCommand
  const steps = []

  try {
    await rm(stateDir, { recursive: true, force: true })
    await mkdir(stateDir, { recursive: true })
    await writeFile(preMigrationPath, await buildPreMigrationSql(migrationDir))

    if (!await runD1Step(runCommandFn, rootDir, persistTo, 'meta-migration-pre-0034', [
      '--file', preMigrationRelativePath,
      '--yes',
    ], steps)) return failedResult(steps, stateDir)

    if (!await runD1Step(runCommandFn, rootDir, persistTo, 'meta-migration-seed', [
      '--command', seedSql(),
      '--yes',
    ], steps)) return failedResult(steps, stateDir)

    if (!await runD1Step(runCommandFn, rootDir, persistTo, 'meta-migration-apply-0034', [
      '--file', migration0034RelativePath,
      '--yes',
    ], steps)) return failedResult(steps, stateDir)

    const deliveryStep = await runD1Step(runCommandFn, rootDir, persistTo, 'meta-migration-query-deliveries', [
      '--command', deliveryQuerySql(),
      '--json',
      '--yes',
    ], steps)
    if (!deliveryStep) return failedResult(steps, stateDir)

    const indexStep = await runD1Step(runCommandFn, rootDir, persistTo, 'meta-migration-query-indexes', [
      '--command', "PRAGMA index_list('analytics_conversion_deliveries');",
      '--json',
      '--yes',
    ], steps)
    if (!indexStep) return failedResult(steps, stateDir)

    const settingStep = await runD1Step(runCommandFn, rootDir, persistTo, 'meta-migration-query-setting', [
      '--command', "SELECT value FROM site_settings WHERE key = 'meta_tracking_mode';",
      '--json',
      '--yes',
    ], steps)
    if (!settingStep) return failedResult(steps, stateDir)

    assertMigrationResult({
      deliveries: parseWranglerResults(deliveryStep.stdout, 'delivery 查询'),
      indexes: parseWranglerResults(indexStep.stdout, '索引查询'),
      setting: parseWranglerResults(settingStep.stdout, '设置查询'),
    })

    if (!await runD1Step(runCommandFn, rootDir, persistTo, 'meta-migration-insert-attempted', [
      '--command', attemptedDeliverySql(),
      '--yes',
    ], steps)) return failedResult(steps, stateDir)

    return { status: 'passed', steps, artifacts: [stateDir] }
  } catch (error) {
    return failedResult(steps, stateDir, error)
  } finally {
    await rm(preMigrationPath, { force: true })
  }
}

async function buildPreMigrationSql(migrationDir) {
  const migrationNames = (await readdir(migrationDir))
    .filter(name => /^\d{4}_.+\.sql$/.test(name) && Number(name.slice(0, 4)) <= 33)
    .sort()

  if (migrationNames.length !== 33) {
    throw new Error(`预期读取 0001 到 0033 共 33 个 migration，实际为 ${migrationNames.length}`)
  }

  const migrations = await Promise.all(migrationNames.map(name => readFile(path.join(migrationDir, name), 'utf8')))
  return `${migrations.join('\n\n')}\n`
}

async function runD1Step(runCommandFn, cwd, persistTo, name, extraArgs, steps) {
  const step = await runCommandFn('corepack', [
    'pnpm', '--filter', '@meigallery/api', 'exec',
    'wrangler', 'd1', 'execute', 'meigallery-db',
    '--local',
    '--persist-to', persistTo,
    ...extraArgs,
  ], { cwd, name })
  steps.push(step)
  return step.status === 'passed' ? step : null
}

function seedSql() {
  return [
    "INSERT INTO analytics_conversion_actions (id, action_type, dedupe_key, occurred_at, date, visitor_id, session_id) VALUES ('action_legacy', 'contact', 'contact:legacy', '2026-07-09T00:00:00.000Z', '2026-07-09', 'visitor_legacy', 'session_legacy');",
    "INSERT INTO analytics_conversion_deliveries (id, conversion_action_id, channel, external_event_id, event_name, status, skip_reason, error_code, error_message, attempt_count, last_attempt_at, sent_at, created_at, updated_at) VALUES ('delivery_pixel', 'action_legacy', 'meta_pixel', 'meta:Contact:old_pixel', 'Contact', 'sent', '', '', '', 2, '2026-07-10T00:00:00.000Z', '2026-07-10T00:01:00.000Z', '2026-07-09T00:00:00.000Z', '2026-07-10T00:01:00.000Z'), ('delivery_capi', 'action_legacy', 'meta_capi', 'meta:Contact:old_capi', 'Contact', 'pending', '', '', '', 0, NULL, NULL, '2026-07-09T00:00:00.000Z', '2026-07-09T00:00:00.000Z');",
    "INSERT INTO site_settings (key, value, updated_at) VALUES ('meta_tracking_mode', '\"limited\"', datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;",
  ].join('\n')
}

function deliveryQuerySql() {
  return "SELECT id, conversion_action_id, channel, external_event_id, event_name, status, skip_reason, error_code, error_message, attempt_count, has_fbp, has_fbc, last_attempt_at, sent_at, created_at, updated_at FROM analytics_conversion_deliveries WHERE id IN ('delivery_pixel', 'delivery_capi') ORDER BY id;"
}

function attemptedDeliverySql() {
  return "INSERT INTO analytics_conversion_deliveries (id, conversion_action_id, channel, external_event_id, event_name, status) VALUES ('delivery_attempted', 'action_legacy', 'meta_capi', 'meta:Contact:attempted', 'Contact', 'attempted');"
}

function parseWranglerResults(stdout, label) {
  let parsed
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw new Error(`${label}未返回有效 JSON`)
  }

  const result = Array.isArray(parsed) ? parsed[0]?.results : undefined
  if (!Array.isArray(result)) throw new Error(`${label} JSON 结构非法`)
  return result
}

function assertMigrationResult({ deliveries, indexes, setting }) {
  if (deliveries.length !== HISTORICAL_DELIVERIES.length) {
    throw new Error(`历史 delivery 数量不匹配：${deliveries.length}`)
  }

  const deliveryById = new Map(deliveries.map(delivery => [delivery.id, delivery]))
  for (const expected of HISTORICAL_DELIVERIES) {
    const actual = deliveryById.get(expected.id)
    if (!actual) throw new Error(`缺少历史 delivery：${expected.id}`)

    for (const [key, value] of Object.entries(expected)) {
      if (actual[key] !== value) throw new Error(`历史 delivery ${expected.id} 的 ${key} 未保留`)
    }
    if (actual.has_fbp !== 0 || actual.has_fbc !== 0) {
      throw new Error(`历史 delivery ${expected.id} 的覆盖标记未归零`)
    }
  }

  const indexNames = new Set(indexes.map(index => index.name))
  for (const indexName of [
    'idx_analytics_conversion_deliveries_external',
    'idx_analytics_conversion_deliveries_status',
  ]) {
    if (!indexNames.has(indexName)) throw new Error(`缺少 delivery 索引：${indexName}`)
  }

  if (setting.length !== 1 || setting[0]?.value !== '"disabled"') {
    throw new Error('meta_tracking_mode 未保守归一化为 disabled')
  }
}

function failedResult(steps, stateDir, error) {
  return {
    status: 'failed',
    steps,
    artifacts: [stateDir],
    error: error instanceof Error ? error.message : undefined,
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runMetaMigrationVerification()
  for (const step of result.steps) {
    console.log(`${step.status === 'passed' ? 'PASS' : 'FAIL'} ${step.name}`)
  }
  if (result.status !== 'passed') {
    console.error(result.error || 'Meta migration 演练失败')
    process.exitCode = 1
  }
}
