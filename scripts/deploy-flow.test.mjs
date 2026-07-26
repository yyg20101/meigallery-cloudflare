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
