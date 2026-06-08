import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const MIGRATION_DIR = new URL('../../migrations/', import.meta.url)

async function readMigration(name: string) {
  return readFile(new URL(name, MIGRATION_DIR), 'utf8')
}

describe('analytics migrations', () => {
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
})
