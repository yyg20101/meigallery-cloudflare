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
  assert.match(source, /ATTRIBUTION_DEPLOY_ENV_INVALID/)
  assert.match(source, /ATTRIBUTION_DEPLOY_BRANCH_INVALID/)
  assert.match(source, /ATTRIBUTION_DEPLOY_WORKTREE_DIRTY/)
  assert.match(source, /bootstrap-attribution-worker\.mjs/)
  assert.match(source, /https:\/\/track\.616618\.xyz\/health/)
  assert.doesNotMatch(
    source,
    /commit_sha|git_commit|revision.*(gate|allow|deny)/i,
  )

  const steps = [
    'test',
    'typecheck',
    'build',
    'd1 migrations apply',
    'deploy_attribution',
    'verify_health',
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

test('production 复用单个维护 Cron，dev 明确禁用', async () => {
  const source = await readFile(
    new URL('packages/attribution/wrangler.toml', ROOT_URL),
    'utf8',
  )
  const productionTriggers = readTomlSection(source, 'triggers')
  const devTriggers = readTomlSection(source, 'env.dev.triggers')

  assert.match(
    productionTriggers,
    /crons\s*=\s*\[\s*"\*\/15 \* \* \* \*"\s*\]/,
  )
  assert.doesNotMatch(
    productionTriggers,
    /17 3 \* \* \*/,
  )
  assert.match(devTriggers, /crons\s*=\s*\[\s*\]/)
})

function readTomlSection(source, name) {
  const heading = `[${name}]`
  const start = source.indexOf(heading)
  assert.notEqual(start, -1, `缺少 ${heading}`)
  const contentStart = start + heading.length
  const nextSectionOffset = source.slice(contentStart).search(/\n\[/)
  return nextSectionOffset === -1
    ? source.slice(contentStart)
    : source.slice(contentStart, contentStart + nextSectionOffset)
}
