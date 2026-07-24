import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const ROOT_URL = new URL('../', import.meta.url)

test('普通部署脚本不部署独立归因 Worker', async () => {
  const source = await readFile(
    new URL('scripts/deploy.sh', ROOT_URL),
    'utf8',
  )

  assert.doesNotMatch(source, /@meigallery\/attribution/)
  assert.match(source, /@meigallery\/api/)
  assert.match(source, /@meigallery\/web/)
})

test('专属脚本只部署归因 Worker 且按门禁顺序执行', async () => {
  const source = await readFile(
    new URL('scripts/deploy-attribution.sh', ROOT_URL),
    'utf8',
  )

  assert.doesNotMatch(source, /@meigallery\/api|@meigallery\/web/)
  assert.match(source, /ATTRIBUTION_D1_RESOURCE_NOT_PROVISIONED/)

  const steps = [
    'test',
    'typecheck',
    'build',
    'd1 migrations apply',
    'deploy',
  ]
  let previousIndex = -1
  for (const step of steps) {
    const index = source.indexOf(step)
    assert.ok(index > previousIndex, `${step} 必须按顺序执行`)
    previousIndex = index
  }
})

test('根命令显式区分归因构建、测试和部署', async () => {
  const packageJson = JSON.parse(await readFile(
    new URL('package.json', ROOT_URL),
    'utf8',
  ))

  assert.equal(
    packageJson.scripts.deploy,
    'corepack pnpm --filter @meigallery/api --filter @meigallery/web deploy',
  )
  assert.doesNotMatch(
    packageJson.scripts.deploy,
    /@meigallery\/attribution/,
  )
  assert.equal(
    packageJson.scripts['build:attribution'],
    'corepack pnpm --filter @meigallery/attribution build',
  )
  assert.equal(
    packageJson.scripts['test:attribution'],
    'corepack pnpm --filter @meigallery/attribution test',
  )
  assert.equal(
    packageJson.scripts['deploy:attribution'],
    'corepack pnpm --filter @meigallery/attribution deploy',
  )
})

test('生产启用凭证维护 Cron，dev 明确禁用', async () => {
  const source = await readFile(
    new URL('packages/attribution/wrangler.toml', ROOT_URL),
    'utf8',
  )

  assert.match(
    source,
    /\[triggers\](?:\s|#[^\n]*\n)*crons\s*=\s*\[\s*"[^"]+"\s*\]/,
  )
  assert.match(
    source,
    /\[env\.dev\.triggers\]\s+crons\s*=\s*\[\s*\]/,
  )
})
