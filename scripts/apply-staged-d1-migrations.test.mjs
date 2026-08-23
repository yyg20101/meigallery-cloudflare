import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  applyStagedD1Migrations,
  buildTemporaryWranglerConfig,
  main,
  parsePendingMigrations,
  selectMigrationsThrough,
} from './apply-staged-d1-migrations.mjs'

const LOCAL = [
  '0115_app_notification_content_lifecycle.sql',
  '0116_legacy_import_operational_integrity.sql',
  '0117_legacy_import_processing_lease_guard_reservation.sql',
  '0118_external_import_queue_integrity.sql',
  '0119_legacy_import_processing_lease_guards.sql',
]
const EXTENSION_CUTOFF = '0118_external_import_queue_integrity.sql'
const CONTRACT_GUARD = '0119_legacy_import_processing_lease_guards.sql'
const TARGET = { databaseName: 'meigallery-db-dev', databaseId: 'dev-database-id' }

describe('分阶段 D1 migration 执行器', () => {
  it('只选择连续待执行前缀到指定扩展边界', () => {
    const pending = LOCAL.slice(1)
    assert.deepEqual(
      selectMigrationsThrough(LOCAL, pending, EXTENSION_CUTOFF),
      pending.slice(0, -1),
    )
    assert.deepEqual(
      selectMigrationsThrough(LOCAL, pending, '0115_app_notification_content_lifecycle.sql'),
      [],
    )
  })

  it('拒绝跳号、乱序和仓库外 migration 名称', () => {
    assert.throws(
      () => selectMigrationsThrough(LOCAL, [LOCAL[1], LOCAL[3], LOCAL[4]], CONTRACT_GUARD),
      /STAGED_D1_PENDING_MIGRATIONS_NOT_CONTIGUOUS/u,
    )
    assert.throws(
      () => selectMigrationsThrough(LOCAL, [LOCAL[2], LOCAL[1], LOCAL[3], LOCAL[4]], CONTRACT_GUARD),
      /STAGED_D1_PENDING_MIGRATIONS_INVALID/u,
    )
    assert.throws(
      () => selectMigrationsThrough(LOCAL, LOCAL.slice(1), '0120_unknown.sql'),
      /STAGED_D1_CUTOFF_NOT_FOUND/u,
    )
  })

  it('应用后必须精确核对剩余 migration，不能静默越界', async () => {
    const calls = []
    const result = await applyStagedD1Migrations({
      environment: 'dev',
      confirmDatabase: TARGET.databaseName,
      through: EXTENSION_CUTOFF,
      apply: true,
      target: TARGET,
      listLocalMigrations: async () => LOCAL,
      listPendingMigrations: async () => LOCAL.slice(1),
      listPendingMigrationsAfter: async () => [CONTRACT_GUARD],
      applySelectedMigrations: async names => calls.push(names),
    })
    assert.equal(result.status, 'applied')
    assert.deepEqual(calls, [LOCAL.slice(1, -1)])
    assert.deepEqual(result.remaining, [CONTRACT_GUARD])

    await assert.rejects(
      applyStagedD1Migrations({
        environment: 'dev',
        confirmDatabase: TARGET.databaseName,
        through: EXTENSION_CUTOFF,
        apply: true,
        target: TARGET,
        listLocalMigrations: async () => LOCAL,
        listPendingMigrations: async () => LOCAL.slice(1),
        listPendingMigrationsAfter: async () => [],
        applySelectedMigrations: async () => undefined,
      }),
      /STAGED_D1_POST_APPLY_MISMATCH/u,
    )
  })

  it('默认只生成计划，且数据库名称必须逐字确认', async () => {
    let applied = false
    const options = {
      environment: 'dev',
      through: EXTENSION_CUTOFF,
      target: TARGET,
      listLocalMigrations: async () => LOCAL,
      listPendingMigrations: async () => LOCAL.slice(1),
      applySelectedMigrations: async () => { applied = true },
    }
    await assert.rejects(
      applyStagedD1Migrations({ ...options, confirmDatabase: 'meigallery-db' }),
      /STAGED_D1_DATABASE_CONFIRMATION_REQUIRED/u,
    )
    const planned = await applyStagedD1Migrations({ ...options, confirmDatabase: TARGET.databaseName })
    assert.equal(planned.status, 'planned')
    assert.deepEqual(planned.remaining, [CONTRACT_GUARD])
    assert.equal(applied, false)
  })

  it('临时 Wrangler 配置只绑定被确认的目标 D1', () => {
    const source = buildTemporaryWranglerConfig(TARGET)
    assert.match(source, /database_name = "meigallery-db-dev"/u)
    assert.match(source, /database_id = "dev-database-id"/u)
    assert.match(source, /migrations_dir = "migrations"/u)
    assert.doesNotMatch(source, /meigallery-db"/u)
  })

  it('解析 Wrangler 表格去重并以稳定错误码拒绝错误 CLI 目标', async () => {
    assert.deepEqual(parsePendingMigrations(`│ ${LOCAL[1]} │\n│ ${LOCAL[1]} │\n│ ${LOCAL[2]} │`), LOCAL.slice(1, 3))
    let output = ''
    const code = await main({
      argv: ['--environment=production', '--confirm-database=meigallery-db-dev', `--through=${EXTENSION_CUTOFF}`],
      stdout: { write: value => { output += value } },
      target: { databaseName: 'meigallery-db', databaseId: 'production-id' },
    })
    assert.equal(code, 1)
    assert.match(output, /STAGED_D1_DATABASE_CONFIRMATION_REQUIRED/u)
  })
})
