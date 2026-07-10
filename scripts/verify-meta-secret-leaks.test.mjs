import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, it } from 'node:test'
import { promisify } from 'node:util'
import { main, scanMetaSecretLeaks } from './verify-meta-secret-leaks.mjs'

const execFile = promisify(execFileCallback)
const TEMP_DIRS = []
const FIXTURE_VALUES = [
  'token-fixture-unique-7Qk3mN9p',
  'url-token-fixture-4Jx8vL2s',
  'RawPersonUnique@example.test',
  '203.0.113.177',
  'ScannerFixtureAgent/9.7',
  'fb.1.1700000000000.ScannerFixtureBrowserId',
  'a'.repeat(64),
  'not-a-lowercase-sha256-fixture',
]

afterEach(async () => {
  await Promise.all(TEMP_DIRS.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('Meta secret 静态泄漏扫描', () => {
  it('scanner 自身不会被 SQL 持久化规则误报', async () => {
    const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const report = await scanMetaSecretLeaks({
      rootDir,
      trackedFiles: ['scripts/verify-meta-secret-leaks.mjs'],
    })

    assert.equal(report.status, 'passed')
    assert.deepEqual(report.findings, [])
  })

  it('扫描 tracked 文件和 ignored release evidence，按稳定 rule ID 失败且不回显原值', async () => {
    const rootDir = await createRepository()
    await writeTracked(rootDir, 'src/runtime.ts', `
      META_CAPI_ACCESS_TOKEN=${FIXTURE_VALUES[0]}
      const endpoint = "https://graph.example/events?access_token=${FIXTURE_VALUES[1]}"
      const payload = { user_data: { em: ["${FIXTURE_VALUES[2]}"], external_id: ["${FIXTURE_VALUES[7]}"] } }
    `)
    await writeTracked(rootDir, 'migrations/unsafe.sql', `
      CREATE TABLE unsafe_meta_match (client_ip_address TEXT, client_user_agent TEXT, fbp TEXT, fbc TEXT);
    `)
    await writeIgnoredEvidence(rootDir, 'reports/release-verification/latest.json', {
      rawEmail: FIXTURE_VALUES[2],
      clientIp: FIXTURE_VALUES[3],
      userAgent: FIXTURE_VALUES[4],
      fbp: FIXTURE_VALUES[5],
      matchIdentifier: FIXTURE_VALUES[6],
    })
    await gitAdd(rootDir, ['.gitignore', 'src/runtime.ts', 'migrations/unsafe.sql'])

    const stdout = bufferWriter()
    const stderr = bufferWriter()
    const report = await main({ rootDir, stdout, stderr })
    const ruleIds = new Set(report.findings.map(finding => finding.ruleId))

    for (const ruleId of [
      'META_SECRET_ASSIGNMENT',
      'META_TOKEN_IN_URL',
      'META_CAPI_MATCH_UNHASHED',
      'META_MATCH_SQL_PERSISTENCE',
      'META_EVIDENCE_RAW_EMAIL',
      'META_EVIDENCE_RAW_IP',
      'META_EVIDENCE_RAW_USER_AGENT',
      'META_EVIDENCE_BROWSER_ID',
      'META_EVIDENCE_MATCH_IDENTIFIER',
    ]) assert.equal(ruleIds.has(ruleId), true, ruleId)
    assert.equal(report.status, 'failed')
    assert.equal(report.findings.some(finding => finding.path === 'reports/release-verification/latest.json'), true)
    assertNoFixtureValue({ report, stdout: stdout.value, stderr: stderr.value })
  })

  it('额外递归扫描 ignored meta live evidence，且不误报 coverage booleans 和合法 hash payload', async () => {
    const rootDir = await createRepository()
    await writeTracked(rootDir, 'src/safe.ts', `
      const payload = { user_data: { em: ["${'b'.repeat(64)}"], external_id: ["${'c'.repeat(64)}"] } }
      const labels = { system: '系统' }
    `)
    await writeTracked(rootDir, 'src/safe.test.ts', `
      const META_CAPI_ACCESS_TOKEN = "${FIXTURE_VALUES[0]}"
    `)
    await writeIgnoredEvidence(rootDir, 'reports/meta-live-verification/latest.json', {
      has_fbp: true,
      has_fbc: false,
      fbp_coverage: 0.9,
      fbc_sample_count: 20,
      commit: 'd'.repeat(40),
      remote: 'git@github.com:example/repository.git',
    })
    await gitAdd(rootDir, ['.gitignore', 'src/safe.ts', 'src/safe.test.ts'])

    const report = await scanMetaSecretLeaks({ rootDir })

    assert.equal(report.status, 'passed')
    assert.deepEqual(report.findings, [])
    assertNoFixtureValue(report)
  })

  it('拒绝路径遍历和仓库外 symlink，不读取外部 secret', async () => {
    const rootDir = await createRepository()
    const outsideDir = await mkdtemp(path.join(tmpdir(), 'meta-scan-outside-'))
    TEMP_DIRS.push(outsideDir)
    const outsideFile = path.join(outsideDir, 'outside.txt')
    await writeFile(outsideFile, `META_CAPI_ACCESS_TOKEN="${FIXTURE_VALUES[0]}"`)
    await mkdir(path.join(rootDir, 'src'), { recursive: true })
    await symlink(outsideFile, path.join(rootDir, 'src', 'outside-link'))
    await gitAdd(rootDir, ['.gitignore', 'src/outside-link'])

    const symlinkReport = await scanMetaSecretLeaks({ rootDir })
    const traversalReport = await scanMetaSecretLeaks({ rootDir, trackedFiles: ['../outside.txt'] })

    assert.deepEqual(symlinkReport.findings, [{ path: 'src/outside-link', ruleId: 'META_PATH_UNSAFE' }])
    assert.deepEqual(traversalReport.findings, [{ path: '../outside.txt', ruleId: 'META_PATH_UNSAFE' }])
    assertNoFixtureValue({ symlinkReport, traversalReport })
  })

  it('拒绝跟随仓库外的 evidence 目录 symlink', async () => {
    const rootDir = await createRepository()
    const outsideDir = await mkdtemp(path.join(tmpdir(), 'meta-evidence-outside-'))
    TEMP_DIRS.push(outsideDir)
    await writeFile(path.join(outsideDir, 'latest.json'), JSON.stringify({ email: FIXTURE_VALUES[2] }))
    await mkdir(path.join(rootDir, 'reports'), { recursive: true })
    await symlink(outsideDir, path.join(rootDir, 'reports', 'release-verification'))

    const report = await scanMetaSecretLeaks({ rootDir })

    assert.deepEqual(report.findings, [{
      path: 'reports/release-verification',
      ruleId: 'META_PATH_UNSAFE',
    }])
    assertNoFixtureValue(report)
  })

  it('跳过二进制并对超大文本 fail closed，输出仍不包含文件内容', async () => {
    const rootDir = await createRepository()
    await mkdir(path.join(rootDir, 'assets'), { recursive: true })
    await writeFile(path.join(rootDir, 'assets', 'binary.dat'), Buffer.from([0, 1, 2, 3, 255]))
    await writeFile(path.join(rootDir, 'assets', 'large.txt'), `${FIXTURE_VALUES[1]}${'x'.repeat(1_100_000)}`)
    await gitAdd(rootDir, ['.gitignore', 'assets/binary.dat', 'assets/large.txt'])

    const report = await scanMetaSecretLeaks({ rootDir })

    assert.deepEqual(report.findings, [{ path: 'assets/large.txt', ruleId: 'META_FILE_TOO_LARGE' }])
    assertNoFixtureValue(report)
  })
})

async function createRepository() {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'meta-secret-scan-'))
  TEMP_DIRS.push(rootDir)
  await execFile('git', ['init', '--quiet'], { cwd: rootDir })
  await writeFile(path.join(rootDir, '.gitignore'), 'reports/\n')
  return rootDir
}

async function writeTracked(rootDir, relativePath, content) {
  const filePath = path.join(rootDir, relativePath)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, content)
}

async function writeIgnoredEvidence(rootDir, relativePath, value) {
  await writeTracked(rootDir, relativePath, `${JSON.stringify(value, null, 2)}\n`)
}

async function gitAdd(rootDir, relativePaths) {
  await execFile('git', ['add', '--', ...relativePaths], { cwd: rootDir })
}

function bufferWriter() {
  return {
    value: '',
    write(value) {
      this.value += String(value)
    },
  }
}

function assertNoFixtureValue(value) {
  const serialized = JSON.stringify(value)
  for (const fixture of FIXTURE_VALUES) assert.equal(serialized.includes(fixture), false, fixture)
}
