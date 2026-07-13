import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, it } from 'node:test'
import { promisify } from 'node:util'
import { runCommand, writeReport } from './release-verification-lib.mjs'
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
    const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const rootDir = await createRepository()
    const scanner = await readFile(path.join(repositoryRoot, 'scripts/verify-meta-secret-leaks.mjs'), 'utf8')
    await writeTracked(rootDir, 'scripts/verify-meta-secret-leaks.mjs', scanner)
    await gitAdd(rootDir, ['.gitignore', 'scripts/verify-meta-secret-leaks.mjs'])

    const report = await scanMetaSecretLeaks({ rootDir })

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
      remoteUrl: 'ssh://git@github.com/example/repository.git',
      toolVersion: 'vitest@4.0.18',
      packageCoordinate: '@scope/tool@4.0.18',
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

  it('源码数组拒绝可见模板字符串和嵌套明文，同时放行已验证 hash 表达式', async () => {
    const rootDir = await createRepository()
    await writeTracked(rootDir, 'src/template-email.ts', [
      'const payload = { user_data: { em: [`RawPersonUnique@example.test`, validatedHash] } }',
    ].join('\n'))
    await writeTracked(rootDir, 'src/template-interpolation.ts', [
      'const rawId = "raw-id"',
      'const payload = { user_data: { external_id: [`visible-${rawId}`] } }',
    ].join('\n'))
    await writeTracked(rootDir, 'src/nested-raw-id.ts', [
      'const payload = { user_data: { external_id: [["raw-id"]] } }',
    ].join('\n'))
    await writeTracked(rootDir, 'src/validated-hashes.ts', [
      'const payload = { user_data: { em: [validatedEmailHash], external_id: validatedExternalIdHashes } }',
    ].join('\n'))
    await gitAdd(rootDir, [
      '.gitignore',
      'src/template-email.ts',
      'src/template-interpolation.ts',
      'src/nested-raw-id.ts',
      'src/validated-hashes.ts',
    ])

    const report = await scanMetaSecretLeaks({ rootDir })

    assert.deepEqual(report.findings, [
      { path: 'src/nested-raw-id.ts', ruleId: 'META_CAPI_MATCH_UNHASHED' },
      { path: 'src/template-email.ts', ruleId: 'META_CAPI_MATCH_UNHASHED' },
      { path: 'src/template-interpolation.ts', ruleId: 'META_CAPI_MATCH_UNHASHED' },
    ])
    assertNoFixtureValue(report)
  })

  it('源码动态匹配字段仅放行可证明的 hash 来源，并逐项验证数组', async () => {
    const rootDir = await createRepository()
    const unsafeFiles = {
      'src/raw-email.ts': 'const payload = { user_data: { em: rawEmail } }',
      'src/raw-email-array.ts': 'const payload = { user_data: { em: [rawEmail] } }',
      'src/raw-external-id.ts': 'const payload = { user_data: { external_id: input.externalId } }',
      'src/raw-external-id-array.ts': 'const payload = { user_data: { external_id: [input.externalId] } }',
      'src/raw-getter.ts': 'const payload = { user_data: { em: getRawEmail(), external_id: [readRawExternalId()] } }',
      'src/mixed-dynamic-array.ts': 'const payload = { user_data: { em: [validatedEmailHash, rawEmail] } }',
    }
    for (const [file, content] of Object.entries(unsafeFiles)) await writeTracked(rootDir, file, content)
    await writeTracked(rootDir, 'src/proven-hashes.ts', [
      'const payload = {',
      '  user_data: {',
      '    em: validSha256(input.userData?.emailSha256) ? [input.userData!.emailSha256!] : undefined,',
      '    external_id: validSha256(input.userData?.externalIdSha256) ? [input.userData!.externalIdSha256!] : undefined,',
      '    backup_em: [emailHash, profile.emailHashes, input.emailSha256],',
      '    backup_external_id: validatedUserData.external_id,',
      '  },',
      '}',
      'const second = { em: validatedUserData.em, external_id: contract.externalIdHashes }',
    ].join('\n'))
    await gitAdd(rootDir, ['.gitignore', ...Object.keys(unsafeFiles), 'src/proven-hashes.ts'])

    const report = await scanMetaSecretLeaks({ rootDir })

    assert.deepEqual(report.findings, Object.keys(unsafeFiles).sort().map(file => ({
      path: file,
      ruleId: 'META_CAPI_MATCH_UNHASHED',
    })))
  })

  it('真实 Meta CAPI payload 的 validSha256 guard 可通过仓库 scanner', async () => {
    const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

    const report = await scanMetaSecretLeaks({
      rootDir,
      trackedFiles: ['packages/api/src/services/meta-capi.ts'],
    })

    assert.equal(report.findings.some(finding => (
      finding.path === 'packages/api/src/services/meta-capi.ts'
      && finding.ruleId === 'META_CAPI_MATCH_UNHASHED'
    )), false)
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

  it('源码 SQL 模板去注释并逐语句判定每个真实写目标', async () => {
    const rootDir = await createRepository()
    await writeTracked(rootDir, 'src/multi-statement.ts', [
      'const sql = `',
      '  INSERT INTO meta_capi_secure_outbox (fbp) VALUES (?);',
      '  -- UPDATE ignored_comment SET fbc = ?;',
      '  UPDATE profiles SET fbc = ?;',
      '`',
    ].join('\n'))
    await writeTracked(rootDir, 'src/comment-only.ts', [
      'const sql = `',
      '  INSERT INTO meta_capi_secure_outbox (client_ip_address) VALUES (?);',
      '  /* UPDATE profiles SET client_user_agent = ?; */',
      '`',
    ].join('\n'))
    await gitAdd(rootDir, ['.gitignore', 'src/multi-statement.ts', 'src/comment-only.ts'])

    const report = await scanMetaSecretLeaks({ rootDir })

    assert.deepEqual(report.findings, [
      { path: 'src/multi-statement.ts', ruleId: 'META_MATCH_SQL_PERSISTENCE' },
    ])
  })

  it('evidence 扫描所有字符串中的嵌入式敏感值且不误报普通摘要', async () => {
    const rootDir = await createRepository()
    await writeIgnoredEvidence(rootDir, 'reports/release-verification/embedded.json', {
      summary: [
        `联系人 ${FIXTURE_VALUES[2]}`,
        `来源 IPv4=${FIXTURE_VALUES[3]}`,
        '来源 IPv6=2001:db8:85a3::8a2e:370:7334',
        `客户端 ${FIXTURE_VALUES[4]}`,
        `浏览器标识 ${FIXTURE_VALUES[5]}`,
        `匹配标识 prefix-${'d'.repeat(32)}-suffix`,
        `散列标识 prefix-${FIXTURE_VALUES[6]}-suffix`,
      ].join('；'),
      safeSummary: '验证完成，两项正式事件均已通过脱敏检查，未记录原始匹配数据。',
    })

    const report = await scanMetaSecretLeaks({ rootDir })
    const ruleIds = new Set(report.findings.map(finding => finding.ruleId))

    for (const ruleId of [
      'META_EVIDENCE_RAW_EMAIL',
      'META_EVIDENCE_RAW_IP',
      'META_EVIDENCE_RAW_USER_AGENT',
      'META_EVIDENCE_BROWSER_ID',
      'META_EVIDENCE_MATCH_IDENTIFIER',
    ]) assert.equal(ruleIds.has(ruleId), true, ruleId)
    assertNoFixtureValue(report)
  })

  it('evidence 自由文本拒绝裸 Agent、Browser 和 Client User-Agent', async () => {
    const rootDir = await createRepository()
    await writeIgnoredEvidence(rootDir, 'reports/release-verification/bare-user-agent.json', {
      summary: 'ua=Agent/1.0；browser=Browser/2.0；client=Client/3.0',
    })

    const report = await scanMetaSecretLeaks({ rootDir })

    assert.deepEqual(report.findings, [{
      path: 'reports/release-verification/bare-user-agent.json',
      ruleId: 'META_EVIDENCE_RAW_USER_AGENT',
    }])
  })

  it('evidence 自由文本拒绝带端口的 IPv4', async () => {
    const rootDir = await createRepository()
    await writeIgnoredEvidence(rootDir, 'reports/release-verification/ipv4-port.json', {
      summary: '远端地址 ip=203.0.113.177:443',
    })

    const report = await scanMetaSecretLeaks({ rootDir })

    assert.deepEqual(report.findings, [{
      path: 'reports/release-verification/ipv4-port.json',
      ruleId: 'META_EVIDENCE_RAW_IP',
    }])
  })

  it('evidence 递归扫描对象 key 中的敏感数据且正常 schema key 不误报', async () => {
    const rootDir = await createRepository()
    await writeIgnoredEvidence(rootDir, 'reports/release-verification/sensitive-keys.json', {
      [`email-${FIXTURE_VALUES[2]}`]: 'redacted',
      [`ipv4-${FIXTURE_VALUES[3]}:443`]: 'redacted',
      'ipv6-[2001:db8:85a3::8a2e:370:7334]:443': 'redacted',
      [`ua-${FIXTURE_VALUES[4]}`]: 'redacted',
      [`browser-${FIXTURE_VALUES[5]}`]: 'redacted',
      [`match32-${'d'.repeat(32)}`]: 'redacted',
      [`match64-${FIXTURE_VALUES[6]}`]: 'redacted',
      nested: {
        has_fbp: true,
        has_fbc: false,
        userAgent: false,
        client_user_agent_present: true,
      },
    })

    const report = await scanMetaSecretLeaks({ rootDir })
    const ruleIds = new Set(report.findings.map(finding => finding.ruleId))

    for (const ruleId of [
      'META_EVIDENCE_RAW_EMAIL',
      'META_EVIDENCE_RAW_IP',
      'META_EVIDENCE_RAW_USER_AGENT',
      'META_EVIDENCE_BROWSER_ID',
      'META_EVIDENCE_MATCH_IDENTIFIER',
    ]) assert.equal(ruleIds.has(ruleId), true, ruleId)
    assert.equal(report.findings.every(finding => finding.path === 'reports/release-verification/sensitive-keys.json'), true)
    assertNoFixtureValue(report)
  })

  it('evidence 保留 userAgent 与 fbp/fbc 字段上下文门禁', async () => {
    const rootDir = await createRepository()
    await writeIgnoredEvidence(rootDir, 'reports/release-verification/contextual-match.json', {
      client_user_agent: 'custom-runtime',
      userAgent: 'custom-client',
      nested: {
        fbp: 'opaque-browser-value',
        fbc: 'opaque-click-value',
      },
      safeSchema: {
        userAgent: false,
        has_fbp: true,
        has_fbc: false,
      },
    })

    const report = await scanMetaSecretLeaks({ rootDir })

    assert.deepEqual(report.findings, [
      { path: 'reports/release-verification/contextual-match.json', ruleId: 'META_EVIDENCE_BROWSER_ID' },
      { path: 'reports/release-verification/contextual-match.json', ruleId: 'META_EVIDENCE_RAW_USER_AGENT' },
    ])
  })

  it('evidence 字段上下文只放行精确受控脱敏占位符', async () => {
    const rootDir = await createRepository()
    await writeIgnoredEvidence(rootDir, 'reports/release-verification/safe-placeholders.json', {
      userAgent: '[PRIVATE_REDACTED]',
      client_user_agent: '[REDACTED]',
      nested: {
        fbp: '[PRIVATE_REDACTED]',
        fbc: '[REDACTED]',
      },
    })
    await writeIgnoredEvidence(rootDir, 'reports/release-verification/unsafe-placeholders.json', {
      userAgent: 'prefix-[PRIVATE_REDACTED]',
      client_user_agent: '[PRIVATE_REDACTED]-suffix',
      nested: {
        fbp: '[private_redacted]',
        fbc: '[redacted]',
      },
    })

    const report = await scanMetaSecretLeaks({ rootDir })

    assert.deepEqual(report.findings, [
      { path: 'reports/release-verification/unsafe-placeholders.json', ruleId: 'META_EVIDENCE_BROWSER_ID' },
      { path: 'reports/release-verification/unsafe-placeholders.json', ruleId: 'META_EVIDENCE_RAW_USER_AGENT' },
    ])
  })

  it('evidence 只放行与批准契约一致的公开 digest', async () => {
    const rootDir = await createRepository()
    const approvedContractDigest = `sha256:${'9'.repeat(64)}`
    await writeIgnoredEvidence(rootDir, 'reports/release-verification/contract-digests.json', {
      digest: approvedContractDigest,
      datasetQualityContractDigest: approvedContractDigest,
      nested: { digest: `sha256:${'8'.repeat(64)}` },
    })

    const report = await scanMetaSecretLeaks({ rootDir, approvedContractDigest })

    assert.deepEqual(report.findings, [
      { path: 'reports/release-verification/contract-digests.json', ruleId: 'META_EVIDENCE_MATCH_IDENTIFIER' },
    ])
  })

  it('evidence 敏感字段上下文拒绝对象、数组和标量包装且继续扫描子节点', async () => {
    const rootDir = await createRepository()
    await writeIgnoredEvidence(rootDir, 'reports/release-verification/wrapped-context.json', {
      fbp: { value: FIXTURE_VALUES[2] },
      fbc: ['opaque-click-id'],
      userAgent: { value: 'opaque-runtime-agent' },
      client_user_agent: [42],
      nested: {
        fbp: 42,
        fbc: false,
      },
      safeSchema: {
        has_fbp: true,
        has_fbc: false,
      },
    })

    const report = await scanMetaSecretLeaks({ rootDir })

    assert.deepEqual(report.findings, [
      { path: 'reports/release-verification/wrapped-context.json', ruleId: 'META_EVIDENCE_BROWSER_ID' },
      { path: 'reports/release-verification/wrapped-context.json', ruleId: 'META_EVIDENCE_RAW_EMAIL' },
      { path: 'reports/release-verification/wrapped-context.json', ruleId: 'META_EVIDENCE_RAW_USER_AGENT' },
    ])
  })

  it('runCommand、writeReport 与 scanner 端到端保持机器 JSON 并清除落盘隐私', async () => {
    const rootDir = await createRepository()
    const reportDir = path.join(rootDir, 'reports/release-verification')
    const sensitiveKey = 'private-owner@example.test'
    const sensitiveValues = {
      accessToken: 'machine-access-token',
      revision: 'e'.repeat(32),
      ip: '203.0.113.88',
      hash: 'f'.repeat(64),
      userAgent: 'opaque-runtime-agent',
      fbp: 'opaque-browser-id',
      fbc: 'opaque-click-id',
    }
    const embeddedEvidence = JSON.stringify({
      private_redacted_1: 'reserved-value',
      [sensitiveKey]: 'sensitive-key-value',
      nested: {
        access_token: sensitiveValues.accessToken,
        revision: sensitiveValues.revision,
        localAddress: sensitiveValues.ip,
        hash: sensitiveValues.hash,
        userAgent: sensitiveValues.userAgent,
        fbp: sensitiveValues.fbp,
        fbc: sensitiveValues.fbc,
      },
    })
    const step = await runCommand('node', ['-e', `process.stdout.write(${JSON.stringify(embeddedEvidence)})`], {
      reportCommand: 'node machine-evidence',
    })
    const machinePayload = JSON.parse(step.stdout)
    assert.equal(machinePayload.nested.access_token, '[REDACTED]')
    assert.equal(machinePayload.nested.revision, sensitiveValues.revision)
    assert.equal(machinePayload.nested.localAddress, sensitiveValues.ip)
    assert.equal(machinePayload.nested.hash, sensitiveValues.hash)
    assert.equal(machinePayload.nested.userAgent, sensitiveValues.userAgent)
    assert.equal(machinePayload.nested.fbp, sensitiveValues.fbp)
    assert.equal(machinePayload.nested.fbc, sensitiveValues.fbc)
    for (const value of Object.values(sensitiveValues)) assert.equal(step.summary.includes(value), false)
    const report = {
      schemaVersion: 1,
      mode: 'quick',
      status: 'passed',
      startedAt: '2026-07-11T00:00:00.000Z',
      finishedAt: '2026-07-11T00:01:00.000Z',
      durationMs: 60_000,
      git: { branch: 'dev', commit: 'abcdef1234567890', isClean: true, remote: 'origin' },
      versions: { node: 'v24.0.0', pnpm: '10.0.0', wrangler: '4.0.0' },
      steps: [step],
      artifacts: [],
      notes: [],
    }

    const { reportFile, latestFile } = await writeReport(report, { reportDir })
    const contents = await Promise.all([readFile(reportFile, 'utf8'), readFile(latestFile, 'utf8')])
    for (const content of contents) {
      assert.equal(content.includes(sensitiveKey), false)
      for (const value of Object.values(sensitiveValues)) assert.equal(content.includes(value), false)
      const parsedReport = JSON.parse(content)
      const parsedEmbedded = JSON.parse(parsedReport.steps[0].stdout)
      assert.equal(parsedEmbedded.private_redacted_1, 'reserved-value')
      assert.equal(parsedEmbedded.private_redacted_2, 'sensitive-key-value')
      assert.deepEqual(parsedEmbedded.nested, {
        access_token: '[REDACTED]',
        revision: '[PRIVATE_REDACTED]',
        localAddress: '[PRIVATE_REDACTED]',
        hash: '[PRIVATE_REDACTED]',
        userAgent: '[PRIVATE_REDACTED]',
        fbp: '[PRIVATE_REDACTED]',
        fbc: '[PRIVATE_REDACTED]',
      })
    }

    const sanitizedScan = await scanMetaSecretLeaks({ rootDir })
    assert.equal(sanitizedScan.status, 'passed')
    assert.deepEqual(sanitizedScan.findings, [])

    await writeIgnoredEvidence(rootDir, 'reports/release-verification/raw-embedded.json', {
      evidence: JSON.stringify({
        userAgent: sensitiveValues.userAgent,
        fbp: sensitiveValues.fbp,
        fbc: sensitiveValues.fbc,
      }),
    })
    const rawScan = await scanMetaSecretLeaks({ rootDir })
    assert.deepEqual(rawScan.findings, [
      { path: 'reports/release-verification/raw-embedded.json', ruleId: 'META_EVIDENCE_BROWSER_ID' },
      { path: 'reports/release-verification/raw-embedded.json', ruleId: 'META_EVIDENCE_RAW_USER_AGENT' },
    ])
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

  it('Unicode 换行与方向控制字符路径均 opaque，report 和输出不含原始值', async () => {
    const rootDir = await createRepository()
    const dangerousPaths = [
      'reports/line\rbreak.json',
      'reports/line\nbreak.json',
      'reports/line\u2028break.json',
      'reports/line\u2029break.json',
      'reports/direction\u202ebreak.json',
    ]
    const stdout = bufferWriter()

    const report = await main({ rootDir, trackedFiles: dangerousPaths, stdout })
    const serialized = JSON.stringify({ report, stdout: stdout.value })

    assert.equal(report.findings.length, dangerousPaths.length)
    assert.equal(report.findings.every(finding => /^opaque-path-[0-9a-f]{16}$/.test(finding.path)), true)
    for (const dangerousPath of dangerousPaths) assert.equal(serialized.includes(dangerousPath), false)
  })

  it('evidence 遍历受深度和节点预算约束，超限使用稳定 rule ID', async () => {
    const rootDir = await createRepository()
    const deepJson = `${'{"child":'.repeat(200)}null${'}'.repeat(200)}`
    const wideJson = JSON.stringify({ values: Array.from({ length: 20_000 }, (_, index) => index) })
    const embeddedWideJson = JSON.stringify({
      values: Array.from({ length: 200 }, () => JSON.stringify(Array.from({ length: 100 }, (_, index) => index))),
    })
    await writeTracked(rootDir, 'reports/release-verification/deep.json', deepJson)
    await writeTracked(rootDir, 'reports/release-verification/embedded-wide.json', embeddedWideJson)
    await writeTracked(rootDir, 'reports/meta-live-verification/wide.json', wideJson)

    const report = await scanMetaSecretLeaks({ rootDir })

    assert.deepEqual(report.findings, [
      { path: 'reports/meta-live-verification/wide.json', ruleId: 'META_EVIDENCE_STRUCTURE_LIMIT' },
      { path: 'reports/release-verification/deep.json', ruleId: 'META_EVIDENCE_STRUCTURE_LIMIT' },
      { path: 'reports/release-verification/embedded-wide.json', ruleId: 'META_EVIDENCE_STRUCTURE_LIMIT' },
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

  it('部署文档说明普通事件不携带代码，测试会话码只按 Owner 请求使用', async () => {
    const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const deployment = await readFile(path.join(rootDir, 'docs/DEPLOYMENT.md'), 'utf8')

    assert.match(deployment, /普通 test mode 的 `Contact`、`CompleteRegistration` 不自动携带 `test_event_code`/)
    assert.match(deployment, /Owner 在 `\/admin\/attribution\/meta` 输入 Events Manager 当前显示的 `TEST\.\.\.` 会话码/)
    assert.match(deployment, /服务端不持久化、不审计、不回显/)
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
