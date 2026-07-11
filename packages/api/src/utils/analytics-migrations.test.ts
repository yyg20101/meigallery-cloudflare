import { readFile, readdir } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const MIGRATION_DIR = new URL('../../migrations/', import.meta.url)

async function readMigration(name: string) {
  return readFile(new URL(name, MIGRATION_DIR), 'utf8')
}

describe('analytics migrations', () => {
  it('migration 索引从 0001 到 0044 连续且编号唯一', async () => {
    const names = (await readdir(MIGRATION_DIR))
      .filter(name => /^\d{4}_.+\.sql$/.test(name))
      .sort()
    const indexes = names.map(name => Number(name.slice(0, 4)))

    expect(indexes).toEqual(Array.from({ length: 44 }, (_, index) => index + 1))
    expect(new Set(indexes).size).toBe(indexes.length)
  })

  it('0023 创建核心分析表、必要索引和默认关闭设置', async () => {
    const sql = await readMigration('0023_analytics_core.sql')
    for (const table of [
      'analytics_visitors',
      'analytics_sessions',
      'analytics_page_summaries',
      'analytics_session_summaries',
      'analytics_events',
      'analytics_ingest_health_daily',
    ]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`)
    }
    for (const index of [
      'idx_analytics_events_name_occurred',
      'idx_analytics_events_session_occurred',
      'idx_analytics_events_entity_occurred',
      'idx_analytics_sessions_started_source',
      'idx_analytics_sessions_visitor_started',
    ]) {
      expect(sql).toContain(index)
    }
    expect(sql).toContain("('analytics_enabled', 'false'")
    expect(sql).toContain("('analytics_sample_rate', '0.01'")
    expect(sql).toContain("('analytics_consent_mode', '\"limited\"'")
    expect(sql).not.toMatch(/CREATE\s+INDEX[^;]+event_props/is)
  })

  it('0024 创建邀请码表、注册事实表和指定索引', async () => {
    const sql = await readMigration('0024_invite_codes.sql')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS invite_codes')
    expect(sql).toContain('code_hash TEXT NOT NULL UNIQUE')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS invite_registrations')
    expect(sql).toContain('idx_invite_codes_status_expires')
    expect(sql).toContain('idx_invite_registrations_invite_registered')
  })

  it('0025 创建日报聚合表并为幂等 upsert 保留唯一索引', async () => {
    const sql = await readMigration('0025_analytics_aggregates.sql')
    for (const table of [
      'analytics_daily_sources',
      'analytics_daily_pages',
      'analytics_daily_events',
      'analytics_path_edges',
      'analytics_invite_daily',
      'analytics_click_daily',
    ]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`)
    }
    for (const index of [
      'idx_analytics_daily_sources_unique',
      'idx_analytics_daily_pages_unique',
      'idx_analytics_daily_events_unique',
      'idx_analytics_path_edges_unique',
      'idx_analytics_invite_daily_unique',
      'idx_analytics_click_daily_unique',
    ]) {
      expect(sql).toContain(`CREATE UNIQUE INDEX IF NOT EXISTS ${index}`)
    }
  })

  it('0026 创建 owner 导出任务需要的状态、R2 key 和过期字段', async () => {
    const sql = await readMigration('0026_analytics_exports.sql')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS analytics_export_jobs')
    for (const column of ['status TEXT', 'kind TEXT', 'range_from TEXT', 'range_to TEXT', 'r2_key TEXT', 'expires_at TEXT', 'created_by INTEGER', 'error_message TEXT']) {
      expect(sql).toContain(column)
    }
    expect(sql).toContain('idx_analytics_export_jobs_status_expires')
    expect(sql).toContain('idx_analytics_export_jobs_created_by')
  })

  it('0028 创建来源维度页面和点击聚合表', async () => {
    const sql = await readMigration('0028_analytics_source_dimensions.sql')
    for (const table of [
      'analytics_source_page_daily',
      'analytics_source_click_daily',
    ]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`)
    }
    for (const index of [
      'idx_analytics_source_page_daily_unique',
      'idx_analytics_source_click_daily_unique',
      'idx_analytics_source_page_daily_source',
      'idx_analytics_source_click_daily_source',
    ]) {
      expect(sql).toContain(index)
    }
    expect(sql).toContain('source_name TEXT NOT NULL DEFAULT')
  })

  it('0034 以兼容方式扩展 Meta delivery 并保留转化事实表', async () => {
    const sql = await readMigration('0034_meta_production_readiness.sql')
    expect(sql).toContain('PRAGMA defer_foreign_keys = true')
    expect(sql).toContain('PRAGMA defer_foreign_keys = false')

    for (const field of [
      'id',
      'conversion_action_id',
      'channel',
      'external_event_id',
      'event_name',
      'status',
      'skip_reason',
      'error_code',
      'error_message',
      'attempt_count',
      'last_attempt_at',
      'sent_at',
      'created_at',
      'updated_at',
    ]) {
      expect(sql).toMatch(new RegExp(`INSERT INTO analytics_conversion_deliveries_v2[\\s\\S]*\\b${field}\\b`))
      expect(sql).toMatch(new RegExp(`SELECT[\\s\\S]*\\b${field}\\b`))
    }

    expect(sql).toContain("'attempted'")
    expect(sql).toContain('has_fbp INTEGER NOT NULL DEFAULT 0')
    expect(sql).toContain('has_fbc INTEGER NOT NULL DEFAULT 0')
    expect(sql).toContain('idx_analytics_conversion_deliveries_external')
    expect(sql).toContain('idx_analytics_conversion_deliveries_status')
    expect(sql).not.toMatch(/DROP TABLE\s+analytics_conversion_actions/i)
  })

  it('0036 建立安全投递与用户匹配结构，不在迁移中加入明文敏感字段', async () => {
    const sql = await readMigration('0036_meta_capi_v2_secure_delivery.sql')
    expect(sql).toContain('ALTER TABLE users ADD COLUMN meta_external_id TEXT')
    expect(sql).toContain('CREATE TABLE meta_connection_verifications')
    expect(sql).toContain('CREATE TABLE meta_capi_secure_outbox')
    expect(sql).toContain('schema_version = 2')
    expect(sql).toContain('has_email INTEGER NOT NULL DEFAULT 0')
    expect(sql).toContain('has_external_id INTEGER NOT NULL DEFAULT 0')
    expect(sql).toContain('encryption_key_id TEXT NOT NULL DEFAULT')
    expect(sql).not.toMatch(/access_token|client_ip|user_agent|\bemail\b|\bfbp\b|\bfbc\b/i)
  })

  it('0037 为 verification 和 delivery 增加兼容历史空值的 revision 绑定', async () => {
    const sql = await readMigration('0037_meta_connection_revision.sql')

    expect(sql).toContain('ALTER TABLE meta_connection_verifications')
    expect(sql).toContain('ADD COLUMN revision TEXT')
    expect(sql).toContain('CREATE UNIQUE INDEX idx_meta_connection_verifications_revision')
    expect(sql).toContain('ALTER TABLE analytics_conversion_deliveries')
    expect(sql).toContain('ADD COLUMN meta_connection_revision TEXT')
    expect(sql).toMatch(/revision IS NULL[\s\S]+length\(revision\) = 32/)
    expect(sql).toMatch(/meta_connection_revision IS NULL[\s\S]+length\(meta_connection_revision\) = 32/)
    expect(sql).not.toMatch(/access_token|test_event_code|client_ip|user_agent/i)
  })

  it('0038 建立不含 PII 的短期 conversion dedupe claim', async () => {
    const sql = await readMigration('0038_conversion_dedupe_claims.sql')

    expect(sql).toContain('CREATE TABLE analytics_conversion_dedupe_claims')
    expect(sql).toContain('dedupe_digest TEXT PRIMARY KEY')
    expect(sql).toContain('owner_action_id TEXT NOT NULL')
    expect(sql).toContain('claim_token TEXT NOT NULL')
    expect(sql).toContain('claimed_at TEXT NOT NULL')
    expect(sql).toContain('expires_at TEXT NOT NULL')
    expect(sql).toContain('idx_analytics_conversion_dedupe_claims_expiry')
    expect(sql).toMatch(/length\(dedupe_digest\)\s*=\s*64/)
    expect(sql).toMatch(/dedupe_digest\s+NOT GLOB '\*\[\^0-9a-f\]\*'/)
    expect(sql).toMatch(/length\(claim_token\)\s*=\s*32/)
    expect(sql).toMatch(/claim_token\s+NOT GLOB '\*\[\^0-9a-f\]\*'/)
    expect(sql).toMatch(/strftime\('%Y-%m-%dT%H:%M:%fZ', claimed_at\)\s+IS NOT NULL[\s\S]+claimed_at\s*=\s*strftime/)
    expect(sql).toMatch(/strftime\('%Y-%m-%dT%H:%M:%fZ', expires_at\)\s+IS NOT NULL[\s\S]+expires_at\s*=\s*strftime/)
    expect(sql).toMatch(/expires_at\s*>\s*claimed_at/)
    expect(sql).not.toContain('dedupe_key')
    expect(sql).not.toMatch(/email|external_id|client_ip|user_agent|\bfbp\b|\bfbc\b|ciphertext/i)
  })

  it('0039 建立 CAPI rollout、incident 与 Dataset Quality 运维约束', async () => {
    const sql = await readMigration('0039_meta_capi_v2_operations.sql')

    for (const field of [
      'rollout_target_percentage',
      'rollout_effective_percentage',
      'rollout_bucket',
    ]) {
      expect(sql).toContain(`ADD COLUMN ${field}`)
    }
    expect(sql).toContain('idx_conversion_delivery_action_channel')
    expect(sql).toMatch(/rollout_bucket IS NULL[\s\S]+typeof\(rollout_bucket\) = 'integer'/)
    expect(sql).toContain('CREATE TABLE meta_capi_incidents')
    expect(sql).toContain("json_valid(evidence)")
    expect(sql).toContain("json_type(evidence) = 'object'")
    expect(sql).toContain('idx_meta_capi_incident_open_trigger')
    expect(sql).toContain('CREATE TABLE meta_dataset_quality_snapshots')
    expect(sql).toMatch(/dataset_id NOT GLOB '\*\[\^0-9\]\*'/)
    expect(sql).toContain("event_name IN ('Contact', 'CompleteRegistration')")
    expect(sql).toContain("('meta_capi_rollout_percentage', '0'")
    expect(sql).toContain('INSERT OR IGNORE INTO site_settings')
    expect(sql).not.toMatch(/DELETE\s+FROM\s+analytics_conversion_(actions|deliveries)/i)
    expect(sql).not.toMatch(/UPDATE\s+site_settings[\s\S]+meta_capi_rollout_percentage/i)
  })

  it('0040 为 CAPI 15 分钟熔断窗口建立覆盖时间索引', async () => {
    const sql = await readMigration('0040_meta_capi_circuit_indexes.sql')
    for (const index of [
      'idx_meta_capi_delivery_attempt_window',
      'idx_meta_capi_delivery_pending_window',
      'idx_meta_capi_delivery_duplicate_window',
      'idx_meta_capi_delivery_created_window',
    ]) expect(sql).toContain(`CREATE INDEX ${index}`)
  })

  it('0041 建立短期一次性 Meta live challenge，原始 ID 可在消费后不可恢复', async () => {
    const sql = await readMigration('0041_meta_live_challenges.sql')
    expect(sql).toContain('CREATE TABLE meta_live_challenges')
    expect(sql).toContain('contact_event_id TEXT')
    expect(sql).toContain('complete_registration_event_id TEXT')
    expect(sql).toContain("status IN ('pending', 'consuming', 'server_sent')")
    expect(sql).toContain('expires_at TEXT NOT NULL')
    expect(sql).toContain('contact_event_digest TEXT')
    expect(sql).toContain('complete_registration_event_digest TEXT')
    expect(sql).not.toMatch(/email|client_ip|user_agent|access_token|test_event_code/i)
  })

  it('0042 建立仅存摘要、绑定环境/commit/nonce 的一次性 attestation ticket', async () => {
    const sql = await readMigration('0042_meta_resource_attestation_tickets.sql')
    expect(sql).toContain('CREATE TABLE meta_resource_attestation_tickets')
    expect(sql).toContain('ticket_digest TEXT PRIMARY KEY')
    expect(sql).toContain("environment IN ('dev', 'production')")
    expect(sql).toContain('commit_sha TEXT NOT NULL')
    expect(sql).toContain('nonce TEXT NOT NULL')
    expect(sql).toContain('owner_user_id INTEGER NOT NULL')
    expect(sql).toContain('expires_at TEXT NOT NULL')
    expect(sql).toContain('consumed_at TEXT')
    expect(sql).not.toMatch(/session|cookie|access_token|test_event_code|email|client_ip|user_agent/i)
  })

  it('0043 为 CAPI delivery 增加短期发送 lease，不保存 token 到其他表', async () => {
    const sql = await readMigration('0043_meta_capi_delivery_lease.sql')
    expect(sql).toContain('ADD COLUMN delivery_lease_token TEXT')
    expect(sql).toContain('ADD COLUMN delivery_lease_expires_at TEXT')
    expect(sql).toContain('idx_meta_capi_delivery_lease_expiry')
    expect(sql).toContain("registration_conversion_recovery_cursor', '0'")
    expect(sql).toMatch(/length\(delivery_lease_token\)\s*=\s*32/)
    expect(sql).not.toMatch(/access_token|test_event_code|client_ip|user_agent|email|ciphertext/i)
  })

  it('0044 将 Dataset Quality 快照绑定 approved contract digest', async () => {
    const sql = await readMigration('0044_meta_dataset_quality_contract_digest.sql')
    expect(sql).toContain('ADD COLUMN contract_digest TEXT NOT NULL')
    expect(sql).toContain("substr(contract_digest, 1, 7) = 'sha256:'")
    expect(sql).toContain('idx_meta_dataset_quality_contract')
  })
})
