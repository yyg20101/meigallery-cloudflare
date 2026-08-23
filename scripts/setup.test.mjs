import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { promisify } from 'node:util'
import { execFile as execFileCallback } from 'node:child_process'

const execFile = promisify(execFileCallback)
const SETUP_SCRIPT = fileURLToPath(new URL('./setup.sh', import.meta.url))
const FIXTURE_SECRET = 'setup-stub-secret-must-not-leak'
const REQUIRED_PRODUCTION_AD_QUEUES = [
  'meigallery-ad-meta',
  'meigallery-ad-meta-dlq',
  'meigallery-ad-tiktok',
  'meigallery-ad-tiktok-dlq',
  'meigallery-ad-google',
  'meigallery-ad-google-dlq',
]
const BUSINESS_QUEUE_BASES = [
  'meigallery-import-zip',
  'meigallery-app-data-rights-export',
  'meigallery-app-data-rights-deletion',
  'meigallery-import-telegram',
]
const REQUIRED_PRODUCTION_BUSINESS_QUEUES = BUSINESS_QUEUE_BASES.flatMap(name => [name, `${name}-dlq`])
const REQUIRED_DEV_BUSINESS_QUEUES = BUSINESS_QUEUE_BASES.flatMap(name => [`${name}-dev`, `${name}-dev-dlq`])
const REQUIRED_PRODUCTION_QUEUES = [...REQUIRED_PRODUCTION_AD_QUEUES, ...REQUIRED_PRODUCTION_BUSINESS_QUEUES]
const REQUIRED_ALL_QUEUES = [...REQUIRED_PRODUCTION_QUEUES, ...REQUIRED_DEV_BUSINESS_QUEUES]

describe('Cloudflare setup Queue 初始化', () => {
  for (const [environment, expected] of [
    ['dev', REQUIRED_DEV_BUSINESS_QUEUES],
    ['production', REQUIRED_PRODUCTION_QUEUES],
    ['all', REQUIRED_ALL_QUEUES],
  ]) {
    it(`${environment} 真正创建期望 Queue`, async () => {
      await withSetup(environment, 'success', async (execution, logFile) => {
        const result = await execution
        assert.deepEqual(await createdQueues(logFile), expected)
        assert.deepEqual(await inspectedQueues(logFile), expected)
        assert.equal(`${result.stdout}${result.stderr}`.includes(FIXTURE_SECRET), false)
      })
    })
  }

  it('Queue 已存在时保持幂等并继续创建后续 Queue', async () => {
    await withSetup('all', 'create-failed-info-passed', async (execution, logFile) => {
      const result = await execution
      assert.deepEqual(await createdQueues(logFile), REQUIRED_ALL_QUEUES)
      assert.deepEqual(await inspectedQueues(logFile), REQUIRED_ALL_QUEUES)
      assert.match(result.stdout, /已确认存在/)
      assert.equal(`${result.stdout}${result.stderr}`.includes(FIXTURE_SECRET), false)
    })
  })

  it('create 权限错误即使含 exists 字样，info 失败仍通用报错退出', async () => {
    await withSetup('production', 'permission-exists-info-failed', async (execution) => {
      await assert.rejects(execution, (error) => {
        assert.equal(error.code, 1)
        assert.match(error.stdout, /创建 Queue .*失败/)
        assert.equal(`${error.stdout}${error.stderr}`.includes(FIXTURE_SECRET), false)
        return true
      })
    })
  })

  it('create 成功后仍以 info 验证，info 失败时退出', async () => {
    await withSetup('production', 'create-passed-info-failed', async (execution) => {
      await assert.rejects(execution, error => {
        assert.equal(error.code, 1)
        assert.match(error.stdout, /创建 Queue .*失败/)
        assert.equal(`${error.stdout}${error.stderr}`.includes(FIXTURE_SECRET), false)
        return true
      })
    })
  })
})

async function withSetup(environment, mode, callback) {
  const directory = await mkdtemp(path.join(tmpdir(), 'meigallery-setup-'))
  const binDir = path.join(directory, 'bin')
  const stateDir = path.join(directory, 'state')
  const logFile = path.join(directory, 'wrangler.log')
  await writeFile(path.join(directory, '.keep'), '')
  await mkdir(binDir)
  await mkdir(stateDir)
  const wranglerPath = path.join(binDir, 'wrangler')
  await writeFile(wranglerPath, `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$WRANGLER_LOG"
case "\${1:-}" in
  --version) printf 'wrangler-stub\\n'; exit 0 ;;
  whoami) printf '%s\\n' "$FIXTURE_SECRET"; exit 0 ;;
  queues)
    printf '%s\\n' "$FIXTURE_SECRET" >&2
    action="\${2:-}"
    queue_name="\${3:-}"
    state_file="$WRANGLER_STATE_DIR/$queue_name"
    case "$WRANGLER_MODE:$action" in
      success:create) touch "$state_file"; exit 0 ;;
      success:info) test -f "$state_file" ;;
      create-failed-info-passed:create) touch "$state_file"; printf 'remote create failure %s\\n' "$FIXTURE_SECRET" >&2; exit 2 ;;
      create-failed-info-passed:info) test -f "$state_file" ;;
      permission-exists-info-failed:create) printf 'permission denied but docs say queue exists %s\\n' "$FIXTURE_SECRET" >&2; exit 2 ;;
      permission-exists-info-failed:info) printf 'permission denied %s\\n' "$FIXTURE_SECRET" >&2; exit 3 ;;
      create-passed-info-failed:create) exit 0 ;;
      create-passed-info-failed:info) printf 'not visible %s\\n' "$FIXTURE_SECRET" >&2; exit 4 ;;
    esac
    ;;
esac
exit 0
  `)
  await chmod(wranglerPath, 0o755)

  try {
    const execution = execFile('bash', [SETUP_SCRIPT, environment], {
      cwd: path.dirname(SETUP_SCRIPT),
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH || ''}`,
        WRANGLER_LOG: logFile,
        WRANGLER_STATE_DIR: stateDir,
        WRANGLER_MODE: mode,
        FIXTURE_SECRET,
      },
    })
    return await callback(execution, logFile)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function createdQueues(logFile) {
  const lines = (await readFile(logFile, 'utf8')).trim().split('\n')
  return lines
    .filter(line => line.startsWith('queues create '))
    .map(line => line.slice('queues create '.length))
}

async function inspectedQueues(logFile) {
  const lines = (await readFile(logFile, 'utf8')).trim().split('\n')
  return [...new Set(lines
    .filter(line => line.startsWith('queues info '))
    .map(line => line.slice('queues info '.length)))]
}
