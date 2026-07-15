import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { after, before, describe, it } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  LEGACY_AD_QUEUES,
  REQUIRED_AD_QUEUES,
  assessAttributionV3Preflight,
  buildProductionCutoverSteps,
  collectProductionQueueStates,
} from './verify-attribution-v3-migration.mjs'
import { runProductionBackup } from './export-attribution-production-backup.mjs'

const scriptsDir = dirname(fileURLToPath(import.meta.url))
const rootDir = dirname(scriptsDir)
const apiDir = join(rootDir, 'packages', 'api')
const tempDir = mkdtempSync(join(tmpdir(), 'meigallery-attribution-v3-'))
const persistDir = join(tempDir, 'd1')
const configPath = join(tempDir, 'wrangler.toml')
const databaseName = 'meigallery-attribution-v3-test'
const fixturePath = join(scriptsDir, 'fixtures', 'attribution-v3', 'production-snapshot.sql')
const migrationPath = join(apiDir, 'migrations', '0051_unified_attribution_expand.sql')
const backfillPath = join(scriptsDir, 'attribution-v3-backfill.sql')
let firstFacts
let secondFacts

before(() => {
  writeFileSync(configPath, `
name = "${databaseName}"
compatibility_date = "2026-05-26"

[[d1_databases]]
binding = "DB"
database_name = "${databaseName}"
database_id = "00000000-0000-0000-0000-000000000513"
`)
  executeFile(fixturePath)
  executeFile(migrationPath)
  executeFile(backfillPath)
  firstFacts = queryRows(`SELECT * FROM attribution_conversion_facts ORDER BY id;`)
  executeFile(backfillPath)
  secondFacts = queryRows(`SELECT * FROM attribution_conversion_facts ORDER BY id;`)
})

after(() => rmSync(tempDir, { recursive: true, force: true }))

describe('通用归因 production 回填', () => {
  it('连续执行两次结果不变，只保留两类标准业务事实', () => {
    assert.deepEqual(secondFacts, firstFacts)
    assert.deepEqual(firstFacts.map(row => [row.id, row.canonical_event]), [
      ['legacy_contact_meta', 'Contact'],
      ['legacy_contact_unattributed', 'Contact'],
      ['legacy_registration_tiktok', 'CompleteRegistration'],
    ])
  })

  it('历史事实不生成新事件编号，并保留可信来源和分析维度', () => {
    const meta = firstFacts.find(row => row.id === 'legacy_contact_meta')
    assert.equal(meta.fact_origin, 'historical_backfill')
    assert.equal(meta.external_event_id, null)
    assert.equal(meta.attribution_provider, 'meta')
    assert.equal(meta.attribution_source, 'historical_backfill')
    assert.equal(meta.dedupe_key, 'contact:meta:001')
    assert.deepEqual(JSON.parse(meta.consent_snapshot_json), {
      consentVersion: 1,
      marketingAllowed: false,
      adUserDataAllowed: false,
      adPersonalizationAllowed: false,
      decidedAt: '2026-07-12T01:00:00.000Z',
    })
    assert.deepEqual(JSON.parse(meta.analytics_dimensions_json).metadata, { surface: 'floating-contact' })

    const unattributed = firstFacts.find(row => row.id === 'legacy_contact_unattributed')
    assert.equal(unattributed.attribution_provider, null)
    assert.equal(unattributed.attribution_source, 'none')
    assert.deepEqual(JSON.parse(unattributed.analytics_dimensions_json).metadata, {})
  })

  it('不迁移旧 Delivery、Outbox、验证、incident 或技术汇总', () => {
    assert.deepEqual(queryRows(`
      SELECT
        (SELECT COUNT(*) FROM attribution_deliveries) AS delivery_count,
        (SELECT COUNT(*) FROM attribution_outbox) AS outbox_count,
        (SELECT COUNT(*) FROM attribution_verifications) AS verification_count,
        (SELECT COUNT(*) FROM attribution_incidents) AS incident_count,
        (SELECT COUNT(*) FROM attribution_usage_daily) AS usage_count,
        (SELECT COUNT(*) FROM analytics_conversion_daily) AS legacy_business_daily_count;
    `), [{
      delivery_count: 0,
      outbox_count: 0,
      verification_count: 0,
      incident_count: 0,
      usage_count: 0,
      legacy_business_daily_count: 1,
    }])
  })
})

describe('通用归因 production preflight', () => {
  it('全部平台关闭、技术积压为零且新资源齐备时通过', () => {
    const report = assessAttributionV3Preflight(validPreflightInput())
    assert.equal(report.status, 'passed')
    assert.deepEqual(report.blockers, [])
  })

  it('任一旧 server、活跃 Delivery、Outbox、Google rollout、Queue 或主密钥异常都失败关闭', () => {
    const cases = [
      ['legacy_server_effective', { legacyServerEffectiveCount: 1 }],
      ['legacy_delivery_active', { legacyActiveDeliveryCount: 1 }],
      ['legacy_outbox_not_empty', { legacyOutboxCount: 1 }],
      ['google_server_effective', { googleServerEffectiveCount: 1 }],
      ['master_key_missing', { masterKeyConfigured: false }],
      ['workflow_missing', { workflowConfigured: false }],
      ['required_queue_missing', { queues: queueState({ missing: REQUIRED_AD_QUEUES[0] }) }],
      ['queue_backlog_not_empty', { queues: queueState({ backlog: LEGACY_AD_QUEUES[0] }) }],
    ]

    for (const [code, override] of cases) {
      const report = assessAttributionV3Preflight({ ...validPreflightInput(), ...override })
      assert.equal(report.status, 'failed')
      assert.ok(report.blockers.includes(code), `${code} 应阻断 production 切换`)
    }
  })

  it('生产切换顺序固定，备份发生在 Expand 前且回填发生在 Worker 部署后', () => {
    assert.deepEqual(buildProductionCutoverSteps(), [
      'verify:quick',
      'attribution:preflight',
      'd1:backup',
      'd1:expand',
      'worker:api',
      'worker:web',
      'attribution:backfill',
      'attribution:reconcile',
      'production:smoke',
    ])
  })

  it('Queue 积压取两次样本的较大值，避免瞬时零值误放行', async () => {
    const queueIds = [...REQUIRED_AD_QUEUES, ...LEGACY_AD_QUEUES].map((name, index) => ({
      queue_name: name,
      queue_id: `queue-${index}`,
    }))
    let metricCall = 0
    const states = await collectProductionQueueStates({
      loadCloudflareAuth: async () => ({ accountId: 'account-test', token: 'private-test-token' }),
      sleepFn: async () => {},
      fetchFn: async (url) => {
        if (url.endsWith('/queues?per_page=100')) return jsonResponse({ success: true, result: queueIds })
        metricCall += 1
        const isFirstSample = metricCall <= queueIds.length
        const isTarget = url.includes('/queue-0/metrics')
        return jsonResponse({
          success: true,
          result: { backlog_count: isFirstSample && isTarget ? 1 : 0 },
        })
      },
    })

    assert.equal(states.find(queue => queue.name === REQUIRED_AD_QUEUES[0]).backlogCount, 1)
    assert.equal(metricCall, queueIds.length * 2)
  })
})

describe('通用归因 production D1 备份', () => {
  it('在仓库外生成 0600 SQL 和带校验值的 manifest', async () => {
    const backupDir = join(tempDir, 'production-backups')
    const result = await runProductionBackup({
      backupDir,
      now: () => new Date('2026-07-15T08:09:10.000Z'),
      exportDatabase: async output => writeFileSync(output, 'CREATE TABLE snapshot (id TEXT);\nINSERT INTO snapshot VALUES (\'ok\');\n'),
      getBookmark: async () => 'bookmark-test-001',
      getCommit: async () => 'a'.repeat(40),
    })

    assert.equal(result.status, 'passed')
    assert.match(result.sha256, /^[0-9a-f]{64}$/)
    assert.equal(statSync(result.sqlPath).mode & 0o777, 0o600)
    assert.equal(statSync(result.manifestPath).mode & 0o777, 0o600)
    const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8'))
    assert.equal(manifest.database, 'meigallery-db')
    assert.equal(manifest.timeTravelBookmark, 'bookmark-test-001')
    assert.equal(manifest.sha256, result.sha256)
    assert.equal(manifest.gitCommit, 'a'.repeat(40))
  })

  it('空或不完整导出失败关闭且不生成可用备份', async () => {
    await assert.rejects(() => runProductionBackup({
      backupDir: join(tempDir, 'invalid-production-backups'),
      exportDatabase: async output => writeFileSync(output, '-- empty export\n'),
      getBookmark: async () => 'bookmark-test-002',
      getCommit: async () => 'b'.repeat(40),
    }), /ATTRIBUTION_BACKUP_SQL_INVALID/)
  })
})

function validPreflightInput() {
  return {
    legacyServerEffectiveCount: 0,
    legacyActiveDeliveryCount: 0,
    legacyOutboxCount: 0,
    googleServerEffectiveCount: 0,
    masterKeyConfigured: true,
    workflowConfigured: true,
    queues: queueState(),
  }
}

function queueState(options = {}) {
  return [...REQUIRED_AD_QUEUES, ...LEGACY_AD_QUEUES].map(name => ({
    name,
    exists: name !== options.missing,
    backlogCount: name === options.backlog ? 1 : 0,
  }))
}

function jsonResponse(body) {
  return {
    ok: true,
    json: async () => body,
  }
}

function executeFile(file) {
  runWrangler(['d1', 'execute', '--file', file, '--json'])
}

function queryRows(sql) {
  return JSON.parse(runWrangler(['d1', 'execute', '--command', sql, '--json']))[0].results
}

function runWrangler(args) {
  return execFileSync(
    process.execPath,
    [
      join(apiDir, 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
      ...args,
      databaseName,
      '--config', configPath,
      '--local',
      '--persist-to', persistDir,
    ],
    { cwd: apiDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
}
