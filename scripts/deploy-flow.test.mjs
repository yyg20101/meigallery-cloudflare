import { readFileSync } from 'node:fs'
import test from 'node:test'
import assert from 'node:assert/strict'

const source = readFileSync(new URL('./deploy.sh', import.meta.url), 'utf8')

test('生产 API 先上传不可见 Version，再迁移并激活', () => {
  const upload = source.indexOf('wrangler versions upload')
  const migrate = source.indexOf('wrangler d1 migrations apply')
  const activate = source.indexOf('wrangler versions deploy')

  assert.ok(upload > 0)
  assert.ok(migrate > upload)
  assert.ok(activate > migrate)
  assert.match(source, /--version-tag "\$\{RELEASE_TAG\}@100%"/)
})

test('部署脚本不重复完整 CI，烟测按 Worker 范围执行', () => {
  assert.doesNotMatch(source, /pnpm (?:test|typecheck)\b/)
  assert.doesNotMatch(source, /playwright/)
  assert.doesNotMatch(source, /--dry-run/)
  assert.match(source, /verify-production\.mjs "\$SCOPE"/)
})

test('广告来源路由迁移独立验证并在 production 执行前备份', () => {
  const migration = '0061_attribution_source_router_cleanup'
  const migrationCheck = source.indexOf(`${migration}.test.mjs`)
  const backup = source.indexOf('export-production-d1-backup.mjs')
  const apply = source.indexOf('wrangler d1 migrations apply')

  assert.ok(migrationCheck > 0)
  assert.ok(backup > migrationCheck)
  assert.ok(apply > backup)
  assert.doesNotMatch(source, /attribution_privacy_policy|0053_attribution_privacy_policy/)
  assert.doesNotMatch(source, /0060_attribution_control_plane_cleanup/)
})
