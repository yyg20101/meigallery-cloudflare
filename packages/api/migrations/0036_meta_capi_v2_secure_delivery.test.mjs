import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createCipheriv, randomBytes } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const migrationDir = dirname(fileURLToPath(import.meta.url))
const apiDir = dirname(migrationDir)
const tempDir = mkdtempSync(join(tmpdir(), 'meigallery-meta-0036-'))
const migrationCopyDir = join(tempDir, 'migrations')
const persistDir = join(tempDir, 'd1')
const configPath = join(tempDir, 'wrangler.toml')
const databaseName = 'meigallery-meta-0036-test'
let summary

before(() => {
  mkdirSync(migrationCopyDir)
  for (const name of readdirSync(migrationDir).filter(name => /^00(?:[0-2]\d|3[0-5])_.*\.sql$/.test(name))) {
    copyFileSync(join(migrationDir, name), join(migrationCopyDir, name))
  }
  appendHistoricalFixture()
  const migration = join(migrationDir, '0036_meta_capi_v2_secure_delivery.sql')
  if (existsSync(migration)) copyFileSync(migration, join(migrationCopyDir, '0036_meta_capi_v2_secure_delivery.sql'))
  writeFileSync(configPath, `
name = "${databaseName}"
compatibility_date = "2026-05-26"

[[d1_databases]]
binding = "DB"
database_name = "${databaseName}"
database_id = "00000000-0000-0000-0000-000000000036"
migrations_dir = "migrations"
`)

  applyMigrations()
  prepareAssertions()
  summary = queryJson(`
    SELECT
      (
        SELECT meta_external_id FROM users
        WHERE password_hash = 'hash_legacy_1'
      ) AS legacy_external_id_1,
      (
        SELECT meta_external_id FROM users
        WHERE password_hash = 'hash_legacy_2'
      ) AS legacy_external_id_2,
      (
        SELECT meta_external_id FROM users WHERE password_hash = 'hash_new'
      ) AS new_external_id,
      (
        SELECT count(*) FROM meta_connection_verifications WHERE environment = 'dev'
      ) AS connection_count,
      (
        SELECT length(verified_commit) FROM meta_connection_verifications WHERE environment = 'dev'
      ) AS verified_commit_length,
      (
        SELECT dataset_quality_status FROM meta_connection_verifications WHERE environment = 'dev'
      ) AS dataset_quality_status,
      (
        SELECT count(*) FROM pragma_table_info('meta_connection_verifications') WHERE name = 'access_token'
      ) AS access_token_column_count,
      (
        SELECT count(*) FROM meta_capi_secure_outbox WHERE delivery_id = 'delivery_envelope' AND schema_version = 1
      ) AS v1_outbox_count,
      (
        SELECT count(*) FROM meta_capi_secure_outbox WHERE delivery_id = 'delivery_envelope' AND schema_version = 2
      ) AS v2_outbox_count,
      (
        SELECT count(*) FROM meta_capi_secure_outbox WHERE delivery_id = 'delivery_cascade'
      ) AS cascaded_outbox_count,
      (
        SELECT has_email FROM analytics_conversion_deliveries WHERE id = 'delivery_new'
      ) AS new_has_email,
      (
        SELECT has_external_id FROM analytics_conversion_deliveries WHERE id = 'delivery_new'
      ) AS new_has_external_id,
      (
        SELECT encryption_key_id FROM analytics_conversion_deliveries WHERE id = 'delivery_new'
      ) AS new_encryption_key_id,
      (
        SELECT action.action_type
        FROM analytics_conversion_actions action
        JOIN analytics_conversion_deliveries delivery ON delivery.conversion_action_id = action.id
        WHERE action.id = 'conversion_legacy'
      ) AS legacy_action_type,
      (
        SELECT delivery.status
        FROM analytics_conversion_actions action
        JOIN analytics_conversion_deliveries delivery ON delivery.conversion_action_id = action.id
        WHERE action.id = 'conversion_legacy'
      ) AS legacy_delivery_status,
      (
        SELECT delivery.attempt_count
        FROM analytics_conversion_actions action
        JOIN analytics_conversion_deliveries delivery ON delivery.conversion_action_id = action.id
        WHERE action.id = 'conversion_legacy'
      ) AS legacy_attempt_count
  `)[0]
})

after(() => rmSync(tempDir, { recursive: true, force: true }))

describe('0036 Meta CAPI v2 secure delivery migration', () => {
  it('为历史用户回填唯一的随机 external ID，允许应用显式写入新的随机 ID', () => {
    assert.match(summary.legacy_external_id_1, /^[0-9a-f]{32}$/)
    assert.match(summary.legacy_external_id_2, /^[0-9a-f]{32}$/)
    assert.notEqual(summary.legacy_external_id_1, summary.legacy_external_id_2)
    assert.match(summary.new_external_id, /^[0-9a-f]{32}$/)
  })

  it('唯一索引拒绝将两个用户更新为相同的 external ID', () => {
    assert.throws(() => executeSql(`
      UPDATE users
      SET meta_external_id = '00000000000000000000000000000000'
      WHERE password_hash IN ('hash_legacy_1', 'hash_legacy_2');
    `))
  })

  it('约束连接验证环境、commit、Dataset Quality 状态，并且不保存 access token 字段', () => {
    assert.equal(summary.connection_count, 1)
    assert.equal(summary.verified_commit_length, 40)
    assert.equal(summary.dataset_quality_status, 'permission_denied')
    assert.equal(summary.access_token_column_count, 0)
  })

  it('连接验证 CHECK 拒绝错误长度、非十六进制 commit 和非法 Dataset Quality 状态', () => {
    assert.throws(() => executeSql(`
      INSERT INTO meta_connection_verifications (
        environment, pixel_id, token_fingerprint, graph_api_version,
        verified_event_name, verified_commit, dataset_quality_status, verified_at
      ) VALUES (
        'production', 'pixel_invalid_length', lower(hex(randomblob(32))), 'v25.0',
        'Contact', lower(hex(randomblob(19))), 'available', '2026-07-11 00:00:00'
      );
    `))
    assert.throws(() => executeSql(`
      INSERT INTO meta_connection_verifications (
        environment, pixel_id, token_fingerprint, graph_api_version,
        verified_event_name, verified_commit, dataset_quality_status, verified_at
      ) VALUES (
        'production', 'pixel_invalid_hex', lower(hex(randomblob(32))), 'v25.0',
        'Contact', 'g' || lower(hex(randomblob(19))) || '0', 'available', '2026-07-11 00:00:00'
      );
    `))
    assert.throws(() => executeSql(`
      INSERT INTO meta_connection_verifications (
        environment, pixel_id, token_fingerprint, graph_api_version,
        verified_event_name, verified_commit, dataset_quality_status, verified_at
      ) VALUES (
        'production', 'pixel_invalid_status', lower(hex(randomblob(32))), 'v25.0',
        'Contact', lower(hex(randomblob(20))), 'unexpected_status', '2026-07-11 00:00:00'
      );
    `))
  })

  it('仅接受 V2 的真实 AES-GCM envelope，并会随 delivery 级联删除', () => {
    assert.equal(summary.v1_outbox_count, 0)
    assert.equal(summary.v2_outbox_count, 1)
    assert.equal(summary.cascaded_outbox_count, 0)
  })

  it('为新 delivery 使用保守用户匹配默认值，并保存非敏感的密钥标识', () => {
    assert.equal(summary.new_has_email, 0)
    assert.equal(summary.new_has_external_id, 0)
    assert.equal(summary.new_encryption_key_id, 'test-key-v2')
  })

  it('不修改迁移前的 conversion action 与 delivery 状态，并允许 Wrangler 重复执行顺序迁移', () => {
    assert.equal(summary.legacy_action_type, 'contact')
    assert.equal(summary.legacy_delivery_status, 'sent')
    assert.equal(summary.legacy_attempt_count, 2)
    applyMigrations()
  })
})

function appendHistoricalFixture() {
  const migrationPath = join(migrationCopyDir, '0035_meta_capi_delivery_recovery.sql')
  writeFileSync(migrationPath, `${readFileSync(migrationPath, 'utf8')}

INSERT INTO users (email, password_hash)
VALUES
  (lower(hex(randomblob(16))) || '@' || 'invalid.local', 'hash_legacy_1'),
  (lower(hex(randomblob(16))) || '@' || 'invalid.local', 'hash_legacy_2');

INSERT INTO analytics_conversion_actions (id, action_type, dedupe_key, occurred_at, date)
VALUES ('conversion_legacy', 'contact', 'dedupe_legacy', '2026-07-10 00:00:00', '2026-07-10');

INSERT INTO analytics_conversion_deliveries (
  id, conversion_action_id, channel, external_event_id, event_name, status, attempt_count
) VALUES (
  'delivery_legacy', 'conversion_legacy', 'meta_capi', 'event_legacy', 'Contact', 'sent', 2
);
`)
}

function prepareAssertions() {
  const envelope = createEnvelope()
  executeSql(`
    INSERT INTO users (email, password_hash, meta_external_id)
    VALUES (
      lower(hex(randomblob(16))) || '@' || 'invalid.local',
      'hash_new',
      lower(hex(randomblob(16)))
    );

    INSERT INTO meta_connection_verifications (
      environment, pixel_id, token_fingerprint, graph_api_version,
      verified_event_name, verified_commit, dataset_quality_status, verified_at
    ) VALUES (
      'dev', 'pixel_test', lower(hex(randomblob(32))), 'v25.0',
      'Contact', lower(hex(randomblob(20))), 'permission_denied', '2026-07-10 00:00:00'
    );
    INSERT OR IGNORE INTO meta_connection_verifications (
      environment, pixel_id, token_fingerprint, graph_api_version,
      verified_event_name, verified_commit, dataset_quality_status, verified_at
    ) VALUES (
      'dev', 'pixel_test_2', lower(hex(randomblob(32))), 'v25.0',
      'CompleteRegistration', lower(hex(randomblob(20))), 'available', '2026-07-10 00:00:00'
    );

    INSERT INTO analytics_conversion_actions (id, action_type, dedupe_key, occurred_at, date)
    VALUES
      ('conversion_envelope', 'contact', 'dedupe_envelope', '2026-07-10 00:00:30', '2026-07-10'),
      ('conversion_cascade', 'contact', 'dedupe_cascade', '2026-07-10 00:00:40', '2026-07-10'),
      ('conversion_new', 'contact', 'dedupe_new', '2026-07-10 00:01:00', '2026-07-10');
    INSERT INTO analytics_conversion_deliveries (
      id, conversion_action_id, channel, external_event_id, event_name, encryption_key_id
    ) VALUES
      ('delivery_envelope', 'conversion_envelope', 'meta_capi', 'event_envelope', 'Contact', 'test-key-v1'),
      ('delivery_cascade', 'conversion_cascade', 'meta_capi', 'event_cascade', 'Contact', 'test-key-v1'),
      ('delivery_new', 'conversion_new', 'meta_capi', 'event_new', 'Contact', 'test-key-v2');
    INSERT OR IGNORE INTO meta_capi_secure_outbox (
      delivery_id, schema_version, key_id, iv, ciphertext, tag, expires_at
    ) VALUES (
      'delivery_envelope', 1, 'test-key-v1', '${envelope.iv}',
      '${envelope.ciphertext}', '${envelope.tag}', '2026-07-11 00:00:00'
    );
    INSERT INTO meta_capi_secure_outbox (
      delivery_id, schema_version, key_id, iv, ciphertext, tag, expires_at
    ) VALUES
      ('delivery_envelope', 2, 'test-key-v1', '${envelope.iv}', '${envelope.ciphertext}', '${envelope.tag}', '2026-07-11 00:00:00'),
      ('delivery_cascade', 2, 'test-key-v1', '${envelope.iv}', '${envelope.ciphertext}', '${envelope.tag}', '2026-07-11 00:00:00');
    UPDATE OR IGNORE analytics_conversion_deliveries SET has_email = 2 WHERE id = 'delivery_new';
    UPDATE OR IGNORE analytics_conversion_deliveries SET has_external_id = -1 WHERE id = 'delivery_new';
    DELETE FROM analytics_conversion_deliveries WHERE id = 'delivery_cascade';
  `)
}

function applyMigrations() {
  return runWrangler(['d1', 'migrations', 'apply', databaseName, '--config', configPath, '--local', '--persist-to', persistDir])
}

function executeSql(command) {
  return runWrangler(['d1', 'execute', databaseName, '--config', configPath, '--local', '--persist-to', persistDir, '--command', command, '--json'])
}

function queryJson(command) {
  return JSON.parse(executeSql(command))[0].results
}

function runWrangler(args) {
  try {
    return execFileSync('corepack', ['pnpm', 'exec', 'wrangler', ...args], {
      cwd: apiDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    const stderr = error && typeof error === 'object' && 'stderr' in error
      ? String(error.stderr).trim()
      : ''
    throw new Error(`Wrangler 本地 D1 命令失败${stderr ? `: ${stderr}` : ''}`, { cause: error })
  }
}

function createEnvelope() {
  const key = randomBytes(32)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update('schema-test', 'utf8'), cipher.final()])
  return {
    iv: iv.toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
  }
}
