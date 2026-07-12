import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { after, before, describe, it } from 'node:test'
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const migrationDir = dirname(fileURLToPath(import.meta.url))
const apiDir = dirname(migrationDir)
const tempDir = mkdtempSync(join(tmpdir(), 'meigallery-meta-0039-'))
const migrationCopyDir = join(tempDir, 'migrations')
const persistDir = join(tempDir, 'd1')
const configPath = join(tempDir, 'wrangler.toml')
const databaseName = 'meigallery-meta-0039-test'
const existingSettingMigrationDir = join(tempDir, 'existing-setting-migrations')
const existingSettingPersistDir = join(tempDir, 'existing-setting-d1')
const existingSettingConfigPath = join(tempDir, 'existing-setting-wrangler.toml')
const existingSettingDatabaseName = 'meigallery-meta-0039-existing-setting-test'
const OPENED_AT = '2026-07-11T00:00:00.000Z'
const OBSERVED_AT = '2026-07-11T00:05:00.000Z'
const CLOSED_AT = '2026-07-11T00:10:00.000Z'
let summary

before(() => {
  mkdirSync(migrationCopyDir)
  const migrations = readdirSync(migrationDir)
    .filter(name => /^\d{4}_.+\.sql$/.test(name) && Number(name.slice(0, 4)) <= 39)
    .sort()
  assert.equal(migrations.length, 39)
  assert.deepEqual(
    migrations.map(name => Number(name.slice(0, 4))),
    Array.from({ length: 39 }, (_, index) => index + 1),
  )
  for (const name of migrations) copyFileSync(join(migrationDir, name), join(migrationCopyDir, name))
  appendHistoricalFixture()
  writeFileSync(configPath, `
name = "${databaseName}"
compatibility_date = "2026-05-26"

[[d1_databases]]
binding = "DB"
database_name = "${databaseName}"
database_id = "00000000-0000-0000-0000-000000000039"
migrations_dir = "migrations"
`)

  applyMigrations()
  summary = queryJson(`
    SELECT
      (SELECT count(*) FROM analytics_conversion_actions WHERE id = 'action_0039_history') AS action_count,
      (SELECT action_type FROM analytics_conversion_actions WHERE id = 'action_0039_history') AS action_type,
      (SELECT count(*) FROM analytics_conversion_deliveries WHERE conversion_action_id = 'action_0039_history') AS delivery_count,
      (SELECT status FROM analytics_conversion_deliveries WHERE id = 'delivery_0039_pixel') AS pixel_status,
      (SELECT status FROM analytics_conversion_deliveries WHERE id = 'delivery_0039_capi') AS capi_status,
      (SELECT count(*) FROM meta_connection_verifications WHERE environment = 'dev') AS verification_count,
      (SELECT length(revision) FROM meta_connection_verifications WHERE environment = 'dev') AS verification_revision_length,
      (SELECT count(*) FROM meta_capi_secure_outbox WHERE delivery_id = 'delivery_0039_capi') AS outbox_count,
      (SELECT schema_version FROM meta_capi_secure_outbox WHERE delivery_id = 'delivery_0039_capi') AS outbox_schema_version,
      (SELECT count(*) FROM analytics_conversion_dedupe_claims WHERE owner_action_id = 'action_0039_history') AS claim_count,
      (SELECT length(claim_token) FROM analytics_conversion_dedupe_claims WHERE owner_action_id = 'action_0039_history') AS claim_token_length,
      (SELECT rollout_target_percentage FROM analytics_conversion_deliveries WHERE id = 'delivery_0039_capi') AS target_percentage,
      (SELECT rollout_effective_percentage FROM analytics_conversion_deliveries WHERE id = 'delivery_0039_capi') AS effective_percentage,
      (SELECT rollout_bucket FROM analytics_conversion_deliveries WHERE id = 'delivery_0039_capi') AS rollout_bucket,
      (SELECT value FROM site_settings WHERE key = 'meta_capi_rollout_percentage') AS rollout_setting
  `)[0]
})

after(() => rmSync(tempDir, { recursive: true, force: true }))

describe('0039 Meta CAPI v2 质量运营 migration', () => {
  it('真实顺序执行 0001-0039 并保留所有历史 Meta 事实', () => {
    assert.equal(summary.action_count, 1)
    assert.equal(summary.action_type, 'contact')
    assert.equal(summary.delivery_count, 2)
    assert.equal(summary.pixel_status, 'attempted')
    assert.equal(summary.capi_status, 'pending')
    assert.equal(summary.verification_count, 1)
    assert.equal(summary.verification_revision_length, 32)
    assert.equal(summary.outbox_count, 1)
    assert.equal(summary.outbox_schema_version, 2)
    assert.equal(summary.claim_count, 1)
    assert.equal(summary.claim_token_length, 32)
    assert.equal(summary.target_percentage, 0)
    assert.equal(summary.effective_percentage, 0)
    assert.equal(summary.rollout_bucket, null)
    assert.equal(JSON.parse(summary.rollout_setting), 0)
    assert.equal(typeof JSON.parse(summary.rollout_setting), 'number')
  })

  it('rollout 百分比只接受离散值，bucket 只接受 null 或 0-99', () => {
    for (const percentage of [0, 10, 50, 100]) {
      executeSql(`
        UPDATE analytics_conversion_deliveries
        SET rollout_target_percentage = ${percentage}, rollout_effective_percentage = ${percentage}
        WHERE id = 'delivery_0039_capi';
      `)
    }
    for (const percentage of [-1, 1, 99, 101]) {
      assert.throws(() => executeSql(`
        UPDATE analytics_conversion_deliveries SET rollout_target_percentage = ${percentage}
        WHERE id = 'delivery_0039_capi';
      `))
      assert.throws(() => executeSql(`
        UPDATE analytics_conversion_deliveries SET rollout_effective_percentage = ${percentage}
        WHERE id = 'delivery_0039_capi';
      `))
    }
    for (const bucket of [0, 50, 99]) {
      executeSql(`UPDATE analytics_conversion_deliveries SET rollout_bucket = ${bucket} WHERE id = 'delivery_0039_capi';`)
    }
    executeSql("UPDATE analytics_conversion_deliveries SET rollout_bucket = NULL WHERE id = 'delivery_0039_capi';")
    for (const bucket of ['-1', '100', '0.5', '1.5', "'invalid'", "'1.5'"]) {
      assert.throws(() => executeSql(`UPDATE analytics_conversion_deliveries SET rollout_bucket = ${bucket} WHERE id = 'delivery_0039_capi';`))
    }
  })

  it('同一 action/channel 的第二条 delivery 被唯一索引拒绝', () => {
    assert.throws(() => executeSql(`
      INSERT INTO analytics_conversion_deliveries (
        id, conversion_action_id, channel, external_event_id, event_name
      ) VALUES (
        'delivery_0039_duplicate', 'action_0039_history', 'meta_capi',
        'event_0039_duplicate', 'Contact'
      );
    `))
  })

  it('incident evidence 仅接受 JSON object', () => {
    insertOpenIncident('incident_valid', 'delivery_failure_rate', '{}')
    for (const [id, evidence] of [
      ['incident_invalid_json', '{'],
      ['incident_json_array', '[]'],
      ['incident_json_string', '"redacted"'],
      ['incident_json_number', '1'],
      ['incident_json_null', 'null'],
    ]) {
      assert.throws(() => insertOpenIncident(id, id, evidence))
    }
  })

  it('同环境同 trigger 仅允许一个 open incident，关闭后可以再次打开', () => {
    assert.throws(() => insertOpenIncident('incident_duplicate', 'delivery_failure_rate', '{}'))
    executeSql(`
      UPDATE meta_capi_incidents
      SET status = 'closed', closed_at = '${CLOSED_AT}', resolution = 'rollout_disabled'
      WHERE id = 'incident_valid';
    `)
    insertOpenIncident('incident_reopened', 'delivery_failure_rate', '{}')
  })

  it('incident 生命周期和 UTC ISO 时间保持一致', () => {
    for (const sql of [
      incidentSql('incident_open_with_close', 'open_with_close', '{}', {
        closedAt: CLOSED_AT,
        resolution: 'invalid_close',
      }),
      incidentSql('incident_open_with_actor', 'open_with_actor', '{}', {
        closedByUserId: 1,
      }),
      incidentSql('incident_closed_without_time', 'closed_without_time', '{}', {
        status: 'closed',
        resolution: 'resolved',
      }),
      incidentSql('incident_closed_without_resolution', 'closed_without_resolution', '{}', {
        status: 'closed',
        closedAt: CLOSED_AT,
      }),
      incidentSql('incident_reverse_observation', 'reverse_observation', '{}', {
        lastObservedAt: '2026-07-10T23:59:59.000Z',
      }),
      incidentSql('incident_bad_opened_time', 'bad_opened_time', '{}', {
        openedAt: '2026-07-11 00:00:00',
      }),
      incidentSql('incident_bad_observed_time', 'bad_observed_time', '{}', {
        lastObservedAt: '2026-07-11T00:00:00Z',
      }),
      incidentSql('incident_close_before_observed', 'close_before_observed', '{}', {
        status: 'closed',
        closedAt: '2026-07-11T00:01:00.000Z',
        resolution: 'resolved',
      }),
    ]) {
      assert.throws(() => executeSql(sql))
    }
  })

  it('quality snapshot 只接受合法 Dataset ID、活动事件和稳定分类', () => {
    insertQualitySnapshot('quality_success', {
      collectionStatus: 'success',
      metricValue: '0.98',
      errorCategory: '',
    })
    insertQualitySnapshot('quality_error', {
      collectionStatus: 'error',
      metricValue: 'NULL',
      errorCategory: 'permission_denied',
    })
    for (const [id, overrides] of [
      ['quality_bad_dataset_alpha', { datasetId: '12abc' }],
      ['quality_bad_dataset_empty', { datasetId: '' }],
      ['quality_bad_dataset_leading_zero', { datasetId: '012345' }],
      ['quality_bad_event', { eventName: 'Lead' }],
      ['quality_bad_metric_key', { metricKey: 'raw.response' }],
      ['quality_bad_contract_zero', { contractVersion: 0 }],
      ['quality_bad_contract_fraction', { contractVersion: 1.5 }],
      ['quality_bad_collected_time', { collectedAt: '2026-07-11 01:00:00' }],
      ['quality_bad_window_partial', { windowEnd: 'NULL' }],
      ['quality_bad_window_order', {
        windowStart: "'2026-07-11T01:00:00.000Z'",
        windowEnd: "'2026-07-11T00:00:00.000Z'",
      }],
      ['quality_bad_window_future', {
        windowEnd: "'2026-07-11T02:00:00.000Z'",
      }],
    ]) {
      assert.throws(() => insertQualitySnapshot(id, overrides))
    }
  })

  it('quality snapshot 的 success/error 数据互斥', () => {
    for (const [id, overrides] of [
      ['quality_success_without_metric', {
        collectionStatus: 'success', metricValue: 'NULL', errorCategory: '',
      }],
      ['quality_success_with_error', {
        collectionStatus: 'success', metricValue: '1', errorCategory: 'server_error',
      }],
      ['quality_error_with_metric', {
        collectionStatus: 'error', metricValue: '1', errorCategory: 'server_error',
      }],
      ['quality_error_without_category', {
        collectionStatus: 'error', metricValue: 'NULL', errorCategory: '',
      }],
      ['quality_error_raw_category', {
        collectionStatus: 'error', metricValue: 'NULL', errorCategory: '{"message":"denied"}',
      }],
    ]) {
      assert.throws(() => insertQualitySnapshot(id, overrides))
    }
  })

  it('Wrangler 重复执行 migration gate 不改变历史数据', () => {
    applyMigrations()
    const retained = queryJson(`
      SELECT
        (SELECT count(*) FROM analytics_conversion_actions WHERE id = 'action_0039_history') AS action_count,
        (SELECT count(*) FROM analytics_conversion_deliveries WHERE conversion_action_id = 'action_0039_history') AS delivery_count
    `)[0]
    assert.equal(retained.action_count, 1)
    assert.equal(retained.delivery_count, 2)
  })

  it('已有 rollout JSON number 值由 INSERT OR IGNORE 原样保留', () => {
    mkdirSync(existingSettingMigrationDir)
    for (const name of readdirSync(migrationDir)
      .filter(name => /^\d{4}_.+\.sql$/.test(name) && Number(name.slice(0, 4)) <= 38)) {
      copyFileSync(join(migrationDir, name), join(existingSettingMigrationDir, name))
    }
    writeFileSync(existingSettingConfigPath, `
name = "${existingSettingDatabaseName}"
compatibility_date = "2026-05-26"

[[d1_databases]]
binding = "DB"
database_name = "${existingSettingDatabaseName}"
database_id = "00000000-0000-0000-0000-000000000139"
migrations_dir = "existing-setting-migrations"
`)
    runWranglerFor(
      existingSettingDatabaseName,
      existingSettingConfigPath,
      existingSettingPersistDir,
      ['d1', 'migrations', 'apply'],
    )
    runWranglerFor(
      existingSettingDatabaseName,
      existingSettingConfigPath,
      existingSettingPersistDir,
      ['d1', 'execute', '--command', "INSERT INTO site_settings (key, value) VALUES ('meta_capi_rollout_percentage', '10');", '--json'],
    )
    runWranglerFor(
      existingSettingDatabaseName,
      existingSettingConfigPath,
      existingSettingPersistDir,
      ['d1', 'execute', '--file', join(migrationDir, '0039_meta_capi_v2_operations.sql'), '--json'],
    )
    const result = JSON.parse(runWranglerFor(
      existingSettingDatabaseName,
      existingSettingConfigPath,
      existingSettingPersistDir,
      ['d1', 'execute', '--command', "SELECT value FROM site_settings WHERE key = 'meta_capi_rollout_percentage';", '--json'],
    ))[0].results[0]
    assert.equal(result.value, '10')
    assert.equal(JSON.parse(result.value), 10)
  })
})

function appendHistoricalFixture() {
  const migrationPath = join(migrationCopyDir, '0038_conversion_dedupe_claims.sql')
  writeFileSync(migrationPath, `${readFileSync(migrationPath, 'utf8')}

INSERT INTO analytics_conversion_actions (
  id, action_type, dedupe_key, occurred_at, date, visitor_id, session_id
) VALUES (
  'action_0039_history', 'contact', 'dedupe_0039_history',
  '2026-07-11T00:00:00.000Z', '2026-07-11', 'visitor_0039', 'session_0039'
);

INSERT INTO analytics_conversion_deliveries (
  id, conversion_action_id, channel, external_event_id, event_name, status
) VALUES
  ('delivery_0039_pixel', 'action_0039_history', 'meta_pixel', 'event_0039_pixel', 'Contact', 'attempted'),
  ('delivery_0039_capi', 'action_0039_history', 'meta_capi', 'event_0039_capi', 'Contact', 'pending');

INSERT INTO meta_connection_verifications (
  environment, pixel_id, token_fingerprint, graph_api_version,
  verified_event_name, verified_commit, verified_at, revision
) VALUES (
  'dev', '1234567890', lower(hex(randomblob(32))), 'v25.0',
  'Contact', lower(hex(randomblob(20))), '2026-07-11T00:00:00.000Z', lower(hex(randomblob(16)))
);

INSERT INTO meta_capi_secure_outbox (
  delivery_id, schema_version, key_id, iv, ciphertext, tag, expires_at
) VALUES (
  'delivery_0039_capi', 2, 'key-current', 'iv-redacted', 'ciphertext-redacted',
  'tag-redacted', '2026-07-12T00:00:00.000Z'
);

INSERT INTO analytics_conversion_dedupe_claims (
  dedupe_digest, owner_action_id, claim_token, claimed_at, expires_at
) VALUES (
  '${'a'.repeat(64)}', 'action_0039_history', '${'b'.repeat(32)}',
  '2026-07-11T00:00:00.000Z', '2026-07-11T00:01:00.000Z'
);
`)
}

function insertOpenIncident(id, triggerCode, evidence) {
  executeSql(incidentSql(id, triggerCode, evidence))
}

function incidentSql(id, triggerCode, evidence, overrides = {}) {
  const status = overrides.status ?? 'open'
  const openedAt = overrides.openedAt ?? OPENED_AT
  const lastObservedAt = overrides.lastObservedAt ?? OBSERVED_AT
  const closedAt = overrides.closedAt ? `'${overrides.closedAt}'` : 'NULL'
  const closedByUserId = overrides.closedByUserId ?? 'NULL'
  const resolution = overrides.resolution ?? ''
  return `
    INSERT INTO meta_capi_incidents (
      id, environment, status, severity, trigger_code, trigger_summary,
      target_rollout_percentage, effective_rollout_percentage, evidence,
      opened_at, last_observed_at, closed_at, closed_by_user_id, resolution
    ) VALUES (
      '${id}', 'dev', '${status}', 'critical', '${triggerCode}', 'redacted summary',
      10, 0, '${evidence.replaceAll("'", "''")}',
      '${openedAt}', '${lastObservedAt}', ${closedAt}, ${closedByUserId}, '${resolution}'
    );
  `
}

function insertQualitySnapshot(id, overrides = {}) {
  const datasetId = overrides.datasetId ?? '1234567890'
  const eventName = overrides.eventName ?? 'Contact'
  const metricKey = overrides.metricKey ?? 'event_match_quality'
  const metricValue = overrides.metricValue ?? '1'
  const windowStart = overrides.windowStart ?? "'2026-07-11T00:00:00.000Z'"
  const windowEnd = overrides.windowEnd ?? "'2026-07-11T00:30:00.000Z'"
  const collectionStatus = overrides.collectionStatus ?? 'success'
  const errorCategory = overrides.errorCategory ?? ''
  const collectedAt = overrides.collectedAt ?? '2026-07-11T01:00:00.000Z'
  const contractVersion = overrides.contractVersion ?? 1
  executeSql(`
    INSERT INTO meta_dataset_quality_snapshots (
      id, environment, dataset_id, event_name, metric_key, metric_value,
      window_start, window_end, collection_status, error_category,
      collected_at, contract_version
    ) VALUES (
      '${id}', 'dev', '${datasetId}', '${eventName}', '${metricKey}', ${metricValue},
      ${windowStart}, ${windowEnd}, '${collectionStatus}', '${errorCategory}',
      '${collectedAt}', ${contractVersion}
    );
  `)
}

function applyMigrations() {
  return runWrangler(['d1', 'migrations', 'apply'])
}

function executeSql(command) {
  return runWrangler(['d1', 'execute', '--command', command, '--json'])
}

function queryJson(command) {
  return JSON.parse(executeSql(command))[0].results
}

function runWrangler(args) {
  return runWranglerFor(databaseName, configPath, persistDir, args)
}

function runWranglerFor(targetDatabase, targetConfigPath, targetPersistDir, args) {
  try {
    const [scope, action, ...rest] = args
    const commandArgs = scope === 'd1' && action === 'migrations'
      ? ['d1', 'migrations', ...rest, targetDatabase, '--config', targetConfigPath, '--local', '--persist-to', targetPersistDir]
      : ['d1', 'execute', targetDatabase, '--config', targetConfigPath, '--local', '--persist-to', targetPersistDir, ...rest]
    return execFileSync('corepack', ['pnpm', 'exec', 'wrangler', ...commandArgs], {
      cwd: apiDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  }
  catch (error) {
    const stderr = error && typeof error === 'object' && 'stderr' in error
      ? String(error.stderr).trim()
      : ''
    throw new Error(`Wrangler 本地 D1 命令失败${stderr ? `: ${stderr}` : ''}`, { cause: error })
  }
}
