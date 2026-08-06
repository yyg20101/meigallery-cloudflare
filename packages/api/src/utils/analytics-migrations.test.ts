import { readFile, readdir } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const MIGRATION_DIR = new URL('../../migrations/', import.meta.url)

async function readMigration(name: string) {
  return readFile(new URL(name, MIGRATION_DIR), 'utf8')
}

describe('数据库迁移契约', () => {
  it('migration 索引从 0001 到 0073 连续且编号唯一', async () => {
    const names = (await readdir(MIGRATION_DIR))
      .filter(name => /^\d{4}_.+\.sql$/.test(name))
      .sort()
    const indexes = names.map(name => Number(name.slice(0, 4)))

    expect(indexes).toEqual(Array.from({ length: 73 }, (_, index) => index + 1))
    expect(new Set(indexes).size).toBe(indexes.length)
  })

  it('0072 只建立默认关闭的平台话题结构，不写入账号、grant 或会话数据', async () => {
    const sql = await readMigration('0072_app_managed_conversations.sql')

    expect(sql).toContain('CREATE TABLE app_conversations')
    expect(sql).toContain('CREATE TABLE app_conversation_messages')
    expect(sql).toContain('CREATE TABLE app_conversation_quota_consumptions')
    expect(sql).toContain('CREATE TABLE app_messaging_idempotency')
    expect(sql).toContain("operation_mode IN ('platform_managed')")
    expect(sql).toContain("sender_type IN ('viewer', 'platform_operator', 'system')")
    expect(sql).not.toMatch(/INSERT INTO\s+app_conversations/iu)
    expect(sql).not.toMatch(/INSERT INTO\s+app_membership_grants/iu)
    expect(sql).not.toMatch(/UPDATE\s+app_membership_catalog_versions[\s\S]+production_ready\s*=\s*1/iu)
  })

  it('0073 只建立默认关闭的安全运营结构，不预置举报、拉黑或会话分配', async () => {
    const sql = await readMigration('0073_app_messaging_safety_operations.sql')

    expect(sql).toContain('CREATE TABLE app_profile_blocks')
    expect(sql).toContain('CREATE TABLE app_safety_reports')
    expect(sql).toContain('CREATE TABLE app_conversation_assignment_state')
    expect(sql).toContain('CREATE TABLE app_messaging_runtime_controls')
    expect(sql).toContain("'unresolved'")
    expect(sql).toContain('purge_enabled')
    expect(sql).not.toMatch(/INSERT INTO\s+app_safety_reports/iu)
    expect(sql).not.toMatch(/INSERT INTO\s+app_profile_blocks/iu)
    expect(sql).not.toMatch(/INSERT INTO\s+app_conversation_assignment_state/iu)
  })

  it('0071 只写开发会员目录，不迁移旧会员或预发放账号权益', async () => {
    const sql = await readMigration('0071_app_membership_catalog_and_grants.sql')

    expect(sql).toContain('CREATE TABLE app_membership_catalog_versions')
    expect(sql).toContain('CREATE TABLE app_entitlement_definitions')
    expect(sql).toContain('PRIMARY KEY (catalog_version_id, entitlement_key)')
    expect(sql).toContain('REFERENCES app_entitlement_definitions(catalog_version_id, entitlement_key)')
    expect(sql).toContain('idx_app_membership_grants_user_business_reference')
    expect(sql).toContain('CREATE TABLE app_membership_grants')
    expect(sql).toContain('CREATE TABLE app_membership_grant_revocations')
    expect(sql).toContain("'development',\n  0,")
    expect(sql).toContain("'planned'")
    expect(sql).not.toMatch(/INSERT INTO\s+app_membership_grants/iu)
    expect(sql).not.toMatch(/FROM\s+user_memberships/iu)
  })

  it('0023 建立第一方数据分析核心表和必要索引', async () => {
    const sql = await readMigration('0023_analytics_core.sql')
    for (const table of [
      'analytics_visitors',
      'analytics_sessions',
      'analytics_page_summaries',
      'analytics_session_summaries',
      'analytics_events',
      'analytics_ingest_health_daily',
    ]) expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`)
    for (const index of [
      'idx_analytics_events_name_occurred',
      'idx_analytics_events_session_occurred',
      'idx_analytics_sessions_started_source',
      'idx_analytics_sessions_visitor_started',
    ]) expect(sql).toContain(index)
  })

  it('0056 只允许可信点击或受管链接生成平台归因事实', async () => {
    const sql = await readMigration('0056_attribution_fact_source_integrity.sql')
    expect(sql).toContain("attribution_source NOT IN ('none', 'conflict')")
    expect(sql).toContain("attribution_source NOT IN ('click_id', 'managed_link')")
    expect(sql).toContain('CREATE TRIGGER attribution_fact_source_insert_guard')
    expect(sql).toContain('CREATE TRIGGER attribution_fact_source_update_guard')
    expect(sql).toContain("RAISE(ABORT, 'ATTRIBUTION_FACT_SOURCE_INVALID')")
  })

  it('0057 只从有效联系事实重建联系日报', async () => {
    const sql = await readMigration('0057_contact_aggregate_integrity.sql')
    expect(sql).toContain("DELETE FROM analytics_daily_events\nWHERE event_name = 'contact_method_click'")
    expect(sql).toContain("date(datetime(occurred_at, '+8 hours'))")
    expect(sql).toContain("DELETE FROM analytics_source_click_daily\nWHERE element_id = 'contact_method_click'")
    expect(sql).toContain("summary.source_channel != 'direct'")
    expect(sql).not.toContain("WHERE event_name = 'page_view'")
  })

  it('0060 至 0065 收口来源路由并统一转化事实口径', async () => {
    const controlCleanup = await readMigration('0060_attribution_control_plane_cleanup.sql')
    const routerCleanup = await readMigration('0061_attribution_source_router_cleanup.sql')
    const garbageCleanup = await readMigration('0062_attribution_runtime_garbage_cleanup.sql')
    const sourceContract = await readMigration('0063_attribution_tracking_source_contract.sql')
    const runtimeSlimdown = await readMigration('0064_attribution_runtime_slimdown.sql')
    const conversionTruth = await readMigration('0065_analytics_conversion_truth.sql')

    expect(controlCleanup).toContain('DROP TABLE IF EXISTS attribution_verifications')
    expect(routerCleanup).toContain('DROP TABLE IF EXISTS attribution_privacy_policy')
    expect(garbageCleanup).toContain('DROP TABLE IF EXISTS attribution_usage_daily')
    expect(sourceContract).toContain('CREATE TABLE analytics_tracking_sources_next')
    expect(sourceContract).toContain("CHECK (ad_provider IN ('', 'meta', 'tiktok', 'google'))")
    expect(sourceContract).not.toMatch(/link_proof|mg_proof/i)
    expect(runtimeSlimdown).toContain("DELETE FROM site_settings WHERE key = 'analytics_consent_mode'")
    expect(runtimeSlimdown).toContain("provider = 'meta' AND collection_status IN ('error', 'unavailable')")
    expect(conversionTruth).toContain("DELETE FROM analytics_events\nWHERE event_name = 'register_success'")
    expect(conversionTruth).toContain('idx_attribution_conversion_facts_occurred_event')
    expect(conversionTruth).toContain('UPDATE analytics_session_summaries')
    expect(conversionTruth).toContain('UPDATE analytics_daily_sources')
    expect(conversionTruth).toContain('UPDATE analytics_daily_pages')
    expect(conversionTruth).toContain('UPDATE analytics_source_page_daily')
    expect(conversionTruth).toContain('UPDATE analytics_path_edges')
  })

  it('0066 删除旧 Contact 行为副本且不补造历史事实', async () => {
    const sql = await readMigration('0066_contact_fact_analytics_cleanup.sql')

    expect(sql).toContain("DELETE FROM analytics_events\nWHERE event_name = 'contact_method_click'")
    expect(sql).toContain("DELETE FROM analytics_click_daily\nWHERE element_id = 'contact_method_click'")
    expect(sql).toContain("DELETE FROM analytics_source_click_daily\nWHERE element_id = 'contact_method_click'")
    expect(sql).toContain('UPDATE analytics_invite_daily')
    expect(sql).toContain('CREATE TRIGGER analytics_contact_event_insert_guard')
    expect(sql).not.toContain('INSERT INTO attribution_conversion_facts')
    expect(sql).not.toMatch(/pixel|token|delivery/i)
  })
})
