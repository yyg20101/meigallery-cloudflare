import { readFileSync } from 'node:fs'
import test from 'node:test'
import assert from 'node:assert/strict'

const source = readFileSync(new URL('./deploy.sh', import.meta.url), 'utf8')

test('生产 API/Web 先上传不可见 Version，再迁移并快速激活', () => {
  const apiUpload = source.indexOf('--filter @meigallery/api exec wrangler versions upload')
  const webUpload = source.indexOf('--filter @meigallery/web exec wrangler versions upload')
  const migrate = source.indexOf('wrangler d1 migrations apply')
  const apiActivate = source.indexOf('--filter @meigallery/api exec wrangler versions deploy')
  const webActivate = source.indexOf('--filter @meigallery/web exec wrangler versions deploy')

  assert.ok(apiUpload > 0)
  assert.ok(webUpload > apiUpload)
  assert.ok(migrate > webUpload)
  assert.ok(apiActivate > migrate)
  assert.ok(webActivate > apiActivate)
  assert.match(source, /--version-tag "\$\{API_RELEASE_TAG\}@100%"/)
  assert.match(source, /--version-tag "\$\{WEB_RELEASE_TAG\}@100%"/)
})

test('部署脚本不重复完整 CI，烟测按 Worker 范围执行', () => {
  assert.doesNotMatch(source, /pnpm (?:test|typecheck)\b/)
  assert.doesNotMatch(source, /playwright/)
  assert.doesNotMatch(source, /--dry-run/)
  assert.match(source, /verify-production\.mjs "\$SCOPE"/)
})

test('production 对任意待执行 migration 统一备份，无 migration 时跳过 apply', () => {
  const backup = source.indexOf('export-production-d1-backup.mjs')
  const apply = source.indexOf('wrangler d1 migrations apply')

  assert.match(source, /HAS_PENDING_MIGRATIONS=false/)
  assert.match(source, /UNAPPLIED_MIGRATIONS.*\.sql/s)
  assert.match(source, /无待执行 D1 migration，跳过/)
  assert.ok(backup > 0)
  assert.ok(apply > backup)
  assert.doesNotMatch(source, /0061_attribution_source_router_cleanup/)
})
