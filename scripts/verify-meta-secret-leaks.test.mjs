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
  'AbC9xY7pQ2mN8kL4vR6tW3sZ5dF1hJ0u',
  'path-token-Q7mN4vR8sK2xP9zL6dT3',
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

  it('区分 quoted secret literal 与 bare expression，仅放行明确 placeholder/status', async () => {
    const rootDir = await createRepository()
    await writeTracked(rootDir, 'src/unsafe-secrets.ts', `
      const META_CAPI_ACCESS_TOKEN = "${FIXTURE_VALUES[8]}"
      const config = { "META_CAPI_DATA_KEY_CURRENT": "${FIXTURE_VALUES[0]}" }
    `)
    await writeTracked(rootDir, 'src/safe-secrets.ts', `
      const META_CAPI_ACCESS_TOKEN = env.META_CAPI_ACCESS_TOKEN
      const META_CAPI_DATA_KEY_CURRENT = currentDataKey
      const status = { META_CAPI_TEST_EVENT_CODE: "configured" }
      const docs = { META_CAPI_DATA_KEY_PREVIOUS: "<set-in-secret-manager>" }
    `)
    await writeTracked(rootDir, 'config/unsafe.json', JSON.stringify({
      META_CAPI_DATA_KEY_PREVIOUS: FIXTURE_VALUES[8],
    }))
    await gitAdd(rootDir, ['.gitignore', 'src/unsafe-secrets.ts', 'src/safe-secrets.ts', 'config/unsafe.json'])

    const stdout = bufferWriter()
    const report = await main({ rootDir, stdout })

    assert.equal(report.status, 'failed')
    assert.deepEqual(report.findings, [
      { path: 'config/unsafe.json', ruleId: 'META_SECRET_ASSIGNMENT' },
      { path: 'src/unsafe-secrets.ts', ruleId: 'META_SECRET_ASSIGNMENT' },
    ])
    assert.equal(report.findings.some(finding => finding.path === 'src/safe-secrets.ts'), false)
    assertNoFixtureValue({ report, stdout: stdout.value })
  })

  it('bare identifier 仅在源码表达式上下文放行，配置与文本文件仍按字面 secret 检查', async () => {
    const rootDir = await createRepository()
    const unsafeFiles = {
      '.env.production': `META_CAPI_ACCESS_TOKEN=${FIXTURE_VALUES[8]}\n`,
      'config/meta.yaml': `META_CAPI_DATA_KEY_CURRENT: ${FIXTURE_VALUES[8]}\n`,
      'config/meta.toml': `META_CAPI_TEST_EVENT_CODE = ${FIXTURE_VALUES[8]}\n`,
      'config/meta.txt': `META_CAPI_DATA_KEY_PREVIOUS=${FIXTURE_VALUES[8]}\n`,
    }
    for (const [file, content] of Object.entries(unsafeFiles)) await writeTracked(rootDir, file, content)
    await writeTracked(rootDir, 'src/runtime.ts', 'const META_CAPI_ACCESS_TOKEN = configuredAccessToken\n')
    await gitAdd(rootDir, ['.gitignore', ...Object.keys(unsafeFiles), 'src/runtime.ts'])

    const report = await scanMetaSecretLeaks({ rootDir })

    assert.deepEqual(report.findings, Object.keys(unsafeFiles).sort().map(file => ({
      path: file,
      ruleId: 'META_SECRET_ASSIGNMENT',
    })))
    assertNoFixtureValue(report)
  })

  it('递归验证 JSON 的全部 em/external_id 元素，未知 shape 保守失败', async () => {
    const rootDir = await createRepository()
    await writeTracked(rootDir, 'payloads/second-item.json', JSON.stringify({
      data: [{ user_data: { em: ['b'.repeat(64), FIXTURE_VALUES[2]] } }],
    }))
    await writeTracked(rootDir, 'payloads/unknown-shape.json', JSON.stringify({
      data: [{ user_data: { external_id: { value: 'c'.repeat(64) } } }],
    }))
    await writeTracked(rootDir, 'payloads/safe.json', JSON.stringify({
      data: [{ user_data: { em: ['d'.repeat(64)], external_id: ['e'.repeat(64)] } }],
    }))
    await gitAdd(rootDir, ['.gitignore', 'payloads/second-item.json', 'payloads/unknown-shape.json', 'payloads/safe.json'])

    const report = await scanMetaSecretLeaks({ rootDir })

    assert.deepEqual(report.findings, [
      { path: 'payloads/second-item.json', ruleId: 'META_CAPI_MATCH_UNHASHED' },
      { path: 'payloads/unknown-shape.json', ruleId: 'META_CAPI_MATCH_UNHASHED' },
    ])
    assertNoFixtureValue(report)
  })

  it('源码静态数组检查全部 literal，动态 contract 表达式不误报', async () => {
    const rootDir = await createRepository()
    await writeTracked(rootDir, 'src/static-payload.ts', `
      const payload = { user_data: { em: ["${'f'.repeat(64)}", "${FIXTURE_VALUES[2]}"] } }
    `)
    await writeTracked(rootDir, 'src/dynamic-payload.ts', `
      const payload = { user_data: { em: validatedUserData.em, external_id: contract.externalIdHashes } }
    `)
    await gitAdd(rootDir, ['.gitignore', 'src/static-payload.ts', 'src/dynamic-payload.ts'])

    const report = await scanMetaSecretLeaks({ rootDir })

    assert.deepEqual(report.findings, [
      { path: 'src/static-payload.ts', ruleId: 'META_CAPI_MATCH_UNHASHED' },
    ])
    assertNoFixtureValue(report)
  })

  it('源码混合数组放行动态 hash 表达式，但拒绝任意可见的非 hash literal', async () => {
    const rootDir = await createRepository()
    await writeTracked(rootDir, 'src/mixed-unsafe.ts', `
      const payload = { user_data: { em: ["${FIXTURE_VALUES[2]}", validatedHash] } }
    `)
    await writeTracked(rootDir, 'src/mixed-safe.ts', `
      const payload = { user_data: { external_id: ["${'f'.repeat(64)}", validatedExternalIdHash] } }
    `)
    await gitAdd(rootDir, ['.gitignore', 'src/mixed-unsafe.ts', 'src/mixed-safe.ts'])

    const report = await scanMetaSecretLeaks({ rootDir })

    assert.deepEqual(report.findings, [
      { path: 'src/mixed-unsafe.ts', ruleId: 'META_CAPI_MATCH_UNHASHED' },
    ])
    assertNoFixtureValue(report)
  })

  it('SQL 仅按去注释后的写目标豁免 secure outbox', async () => {
    const rootDir = await createRepository()
    const unsafeStatements = {
      'migrations/create.sql': 'CREATE TABLE copied_matches AS SELECT client_ip_address FROM meta_capi_secure_outbox;',
      'migrations/alter.sql': '/* meta_capi_secure_outbox */ ALTER TABLE profiles ADD COLUMN client_user_agent TEXT;',
      'migrations/insert.sql': 'INSERT INTO audit_matches (fbp) SELECT fbp FROM meta_capi_secure_outbox;',
      'migrations/update.sql': '-- meta_capi_secure_outbox\nUPDATE profiles SET fbc = ?;',
    }
    for (const [file, sql] of Object.entries(unsafeStatements)) await writeTracked(rootDir, file, sql)
    await writeTracked(rootDir, 'migrations/safe.sql', `
      INSERT INTO meta_capi_secure_outbox (client_ip_address)
      SELECT client_ip_address FROM transient_events;
    `)
    await gitAdd(rootDir, ['.gitignore', ...Object.keys(unsafeStatements), 'migrations/safe.sql'])

    const report = await scanMetaSecretLeaks({ rootDir })

    assert.deepEqual(report.findings, Object.keys(unsafeStatements).sort().map(file => ({
      path: file,
      ruleId: 'META_MATCH_SQL_PERSISTENCE',
    })))
  })

  it('危险路径统一转为稳定 opaque ID，正常安全相对路径仍保留', async () => {
    const rootDir = await createRepository()
    const dangerousPaths = [
      '../outside.txt',
      '/tmp/absolute.txt',
      `reports/${FIXTURE_VALUES[9]}.json`,
      `reports/${FIXTURE_VALUES[2]}.json`,
      'reports/203.0.113.177.json',
      'reports/fb.1.1700000000000.PathBrowserId.json',
      `reports/${'a'.repeat(32)}.json`,
      `reports/${'b'.repeat(64)}.json`,
      'reports/J8xQ2mV9kR4pT7zN6sW3dF5hL1cB0yUe.json',
      'reports/injected\nMETA_SECRET_SCAN_PASSED.json',
    ]
    const first = await scanMetaSecretLeaks({ rootDir, trackedFiles: [...dangerousPaths, 'safe/missing.txt'] })
    const second = await scanMetaSecretLeaks({ rootDir, trackedFiles: dangerousPaths })

    const opaquePaths = first.findings.filter(finding => finding.path !== 'safe/missing.txt').map(finding => finding.path)
    assert.equal(opaquePaths.length, dangerousPaths.length)
    assert.equal(opaquePaths.every(value => /^opaque-path-[0-9a-f]{16}$/.test(value)), true)
    assert.equal(new Set(opaquePaths).size, dangerousPaths.length)
    assert.deepEqual(second.findings.map(finding => finding.path), opaquePaths)
    assert.equal(first.findings.some(finding => finding.path === 'safe/missing.txt'), true)
    assertNoFixtureValue({ first, second })
  })

  it('evidence 遍历受深度和节点预算约束，超限使用稳定 rule ID', async () => {
    const rootDir = await createRepository()
    const deepJson = `${'{"child":'.repeat(200)}null${'}'.repeat(200)}`
    const wideJson = JSON.stringify({ values: Array.from({ length: 20_000 }, (_, index) => index) })
    await writeTracked(rootDir, 'reports/release-verification/deep.json', deepJson)
    await writeTracked(rootDir, 'reports/meta-live-verification/wide.json', wideJson)

    const report = await scanMetaSecretLeaks({ rootDir })

    assert.deepEqual(report.findings, [
      { path: 'reports/meta-live-verification/wide.json', ruleId: 'META_EVIDENCE_STRUCTURE_LIMIT' },
      { path: 'reports/release-verification/deep.json', ruleId: 'META_EVIDENCE_STRUCTURE_LIMIT' },
    ])
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
    assert.equal(traversalReport.findings.length, 1)
    assert.match(traversalReport.findings[0].path, /^opaque-path-[0-9a-f]{16}$/)
    assert.equal(traversalReport.findings[0].ruleId, 'META_PATH_UNSAFE')
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
