import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, it } from 'node:test'
import { promisify } from 'node:util'
import { execFile as execFileCallback } from 'node:child_process'
import { REQUIRED_PRODUCTION_AD_QUEUES } from './verify-ad-platform-queues.mjs'

const execFile = promisify(execFileCallback)
const SETUP_SCRIPT = fileURLToPath(new URL('./setup.sh', import.meta.url))
const TEMP_DIRS = []
const FIXTURE_SECRET = 'setup-stub-secret-must-not-leak'

afterEach(async () => {
  await Promise.all(TEMP_DIRS.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('Cloudflare setup Queue 初始化', () => {
  for (const [environment, expected] of [
    ['dev', []],
    ['production', REQUIRED_PRODUCTION_AD_QUEUES],
    ['all', REQUIRED_PRODUCTION_AD_QUEUES],
  ]) {
    it(`${environment} 真正创建期望 Queue`, async () => {
      const result = await runSetup(environment)

      assert.deepEqual(await createdQueues(result.logFile), expected)
      assert.deepEqual(await inspectedQueues(result.logFile), expected)
      assert.equal(`${result.stdout}${result.stderr}`.includes(FIXTURE_SECRET), false)
    })
  }

  it('Queue 已存在时保持幂等并继续创建后续 Queue', async () => {
    const result = await runSetup('all', 'create-failed-info-passed')

    assert.deepEqual(await createdQueues(result.logFile), REQUIRED_PRODUCTION_AD_QUEUES)
    assert.deepEqual(await inspectedQueues(result.logFile), REQUIRED_PRODUCTION_AD_QUEUES)
    assert.match(result.stdout, /已确认存在/)
    assert.equal(`${result.stdout}${result.stderr}`.includes(FIXTURE_SECRET), false)
  })

  it('create 权限错误即使含 exists 字样，info 失败仍通用报错退出', async () => {
    await assert.rejects(
      runSetup('production', 'permission-exists-info-failed'),
      (error) => {
        assert.equal(error.code, 1)
        assert.match(error.stdout, /创建 Queue .*失败/)
        assert.equal(`${error.stdout}${error.stderr}`.includes(FIXTURE_SECRET), false)
        return true
      },
    )
  })

  it('create 成功后仍以 info 验证，info 失败时退出', async () => {
    await assert.rejects(runSetup('production', 'create-passed-info-failed'), error => {
      assert.equal(error.code, 1)
      assert.match(error.stdout, /创建 Queue .*失败/)
      assert.equal(`${error.stdout}${error.stderr}`.includes(FIXTURE_SECRET), false)
      return true
    })
  })
})

async function runSetup(environment, mode = 'success') {
  const directory = await mkdtemp(path.join(tmpdir(), 'meigallery-setup-'))
  TEMP_DIRS.push(directory)
  const binDir = path.join(directory, 'bin')
  const logFile = path.join(directory, 'wrangler.log')
  await writeFile(path.join(directory, '.keep'), '')
  await mkdir(binDir)
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
    case "$WRANGLER_MODE:$action" in
      success:create|success:info) exit 0 ;;
      create-failed-info-passed:create) printf 'remote create failure %s\\n' "$FIXTURE_SECRET" >&2; exit 2 ;;
      create-failed-info-passed:info) exit 0 ;;
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

  const result = await execFile('bash', [SETUP_SCRIPT, environment], {
    cwd: path.dirname(SETUP_SCRIPT),
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH || ''}`,
      WRANGLER_LOG: logFile,
      WRANGLER_MODE: mode,
      FIXTURE_SECRET,
    },
  })
  return { ...result, logFile }
}

async function createdQueues(logFile) {
  const lines = (await readFile(logFile, 'utf8')).trim().split('\n')
  return lines
    .filter(line => line.startsWith('queues create '))
    .map(line => line.slice('queues create '.length))
}

async function inspectedQueues(logFile) {
  const lines = (await readFile(logFile, 'utf8')).trim().split('\n')
  return lines
    .filter(line => line.startsWith('queues info '))
    .map(line => line.slice('queues info '.length))
}
