import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, it } from 'node:test'
import { promisify } from 'node:util'
import { execFile as execFileCallback } from 'node:child_process'

const execFile = promisify(execFileCallback)
const SETUP_SCRIPT = fileURLToPath(new URL('./setup.sh', import.meta.url))
const TEMP_DIRS = []
const FIXTURE_SECRET = 'setup-stub-secret-must-not-leak'

afterEach(async () => {
  await Promise.all(TEMP_DIRS.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('Cloudflare setup Queue 初始化', () => {
  for (const [environment, expected] of [
    ['dev', ['meigallery-meta-capi-dev', 'meigallery-meta-capi-dev-dlq']],
    ['production', ['meigallery-meta-capi', 'meigallery-meta-capi-dlq']],
    ['all', [
      'meigallery-meta-capi',
      'meigallery-meta-capi-dlq',
      'meigallery-meta-capi-dev',
      'meigallery-meta-capi-dev-dlq',
    ]],
  ]) {
    it(`${environment} 真正创建期望 Queue`, async () => {
      const result = await runSetup(environment)

      assert.deepEqual(await createdQueues(result.logFile), expected)
      assert.equal(`${result.stdout}${result.stderr}`.includes(FIXTURE_SECRET), false)
    })
  }

  it('Queue 已存在时保持幂等并继续创建后续 Queue', async () => {
    const result = await runSetup('all', 'exists')

    assert.deepEqual(await createdQueues(result.logFile), [
      'meigallery-meta-capi',
      'meigallery-meta-capi-dlq',
      'meigallery-meta-capi-dev',
      'meigallery-meta-capi-dev-dlq',
    ])
    assert.match(result.stdout, /已存在，继续/)
    assert.equal(`${result.stdout}${result.stderr}`.includes(FIXTURE_SECRET), false)
  })

  it('非已存在错误立即失败且不回显 Wrangler 原始输出', async () => {
    await assert.rejects(
      runSetup('dev', 'fail'),
      (error) => {
        assert.equal(error.code, 1)
        assert.match(error.stdout, /创建 Queue .*失败/)
        assert.equal(`${error.stdout}${error.stderr}`.includes(FIXTURE_SECRET), false)
        return true
      },
    )
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
    case "$WRANGLER_MODE" in
      success) exit 0 ;;
      exists) printf 'Queue already exists\\n' >&2; exit 1 ;;
      fail) printf 'remote failure %s\\n' "$FIXTURE_SECRET" >&2; exit 2 ;;
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
