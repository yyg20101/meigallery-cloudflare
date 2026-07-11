import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm, symlink, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import {
  ContractRecorderError,
  MAX_RAW_BYTES,
  main,
  recordMetaDatasetQualityContract,
} from './record-meta-dataset-quality-contract.mjs'

const COMMIT = '95fae701b4a38c99b50ef694690e8df2eeec88ae'
const DATASET_ID = '1234567890123456789'
const UNKNOWN_VALUE = 'UNKNOWN_VALUE_MUST_NOT_LEAK'
const TEMP_DIRS = []

afterEach(async () => {
  await Promise.all(TEMP_DIRS.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

function manifest(overrides = {}) {
  const base = {
    schemaVersion: 1,
    environment: 'dev',
    graphVersion: 'v25.0',
    releaseCommit: COMMIT,
    capturedAt: '2026-07-11T00:00:00.000Z',
    officialUrls: [`https://business.facebook.com/events_manager2/list/dataset/${DATASET_ID}/?asset_id=${DATASET_ID}`],
    request: {
      method: 'GET',
      endpointPath: '/{dataset_id}/quality_fixture',
      queryKeys: ['fields'],
      permissions: ['ads_read'],
      datasetId: DATASET_ID,
    },
    ownerAllowlist: {
      approved: true,
      responsePaths: [
        '$.data[].freshness_time',
        '$.data[].metric_name',
        '$.data[].nullable_note',
        '$.data[].score',
        '$.data[].window_days',
      ],
      freshnessPaths: ['$.data[].freshness_time'],
      windowPaths: ['$.data[].window_days'],
    },
    errorClassifications: ['success', 'permission_denied'],
  }
  return {
    ...base,
    ...overrides,
    request: { ...base.request, ...(overrides.request || {}) },
    ownerAllowlist: { ...base.ownerAllowlist, ...(overrides.ownerAllowlist || {}) },
  }
}

function raw(overrides = {}) {
  return {
    data: [{
      metric_name: 'fixture_metric_value',
      score: 7.25,
      nullable_note: null,
      freshness_time: 'fixture_freshness_value',
      window_days: 7,
      unknown_field: UNKNOWN_VALUE,
      ...overrides,
    }],
  }
}

async function fixture(options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dataset-contract-'))
  TEMP_DIRS.push(dir)
  const manifestPath = path.join(dir, 'manifest.json')
  const rawPath = path.join(dir, 'raw.json')
  const outputPath = path.join(dir, 'contract.md')
  await writeFile(manifestPath, JSON.stringify(options.manifest || manifest()))
  await writeFile(rawPath, options.rawText ?? JSON.stringify(options.raw || raw()))
  return { dir, manifestPath, rawPath, outputPath }
}

async function record(files, options = {}) {
  return recordMetaDatasetQualityContract({ ...files, currentCommit: COMMIT, ...options })
}

async function assertMissing(file) {
  await assert.rejects(access(file), error => error?.code === 'ENOENT')
}

async function captureError(run) {
  try {
    await run()
  } catch (error) {
    assert.equal(error instanceof ContractRecorderError, true)
    return error
  }
  assert.fail('预期记录器失败')
}

describe('Dataset Quality 契约记录器', () => {
  it('成功时仅输出脱敏请求元数据、schema 与九个非空章节，并销毁 raw', async () => {
    const files = await fixture()
    await record(files)
    const document = await readFile(files.outputPath, 'utf8')

    assert.equal((document.match(/^## [1-9]\. /gm) || []).length, 9)
    assert.match(document, /1234\.\.\.6789/)
    assert.match(document, /\$\.data\[\]\.score.*number.*否/)
    assert.match(document, /\$\.data\[\]\.nullable_note.*unknown.*是/)
    assert.equal(document.includes(DATASET_ID), false)
    assert.equal(document.includes('fixture_metric_value'), false)
    assert.equal(document.includes('fixture_freshness_value'), false)
    assert.equal(document.includes(UNKNOWN_VALUE), false)
    await assertMissing(files.rawPath)
  })

  it('敏感键无论 allowlist 与否均硬拒绝，且销毁 raw', async () => {
    for (const key of ['access_token', 'test_event_code', 'email', 'phone', 'client_ip_address', 'client_user_agent', 'fbp', 'fbc', 'external_id', 'event_id']) {
      const files = await fixture({ raw: raw({ [key]: 'SENSITIVE_FIXTURE_VALUE' }) })
      const error = await captureError(() => record(files))
      assert.equal(error.code, 'SENSITIVE_KEY_REJECTED', key)
      await assertMissing(files.rawPath)
      await assertMissing(files.outputPath)
    }
  })

  it('未知字段只记录 path，不记录原始值', async () => {
    const files = await fixture()
    await record(files)
    const document = await readFile(files.outputPath, 'utf8')
    assert.match(document, /`\$\.data\[\]\.unknown_field`/)
    assert.equal(document.includes(UNKNOWN_VALUE), false)
  })

  it('raw 删除失败覆盖原结果并不落地 contract', async () => {
    const files = await fixture()
    const error = await captureError(() => record(files, {
      unlinkFile: async () => { throw new Error('DELETE_SECRET_VALUE') },
    }))
    assert.equal(error.code, 'RAW_DELETE_FAILED')
    await access(files.rawPath)
    await assertMissing(files.outputPath)
  })

  it('contract 写入失败仍销毁 raw，且错误不回显底层内容', async () => {
    const files = await fixture()
    const error = await captureError(() => record(files, {
      stageContract: async () => { throw new Error('WRITE_SECRET_VALUE') },
    }))
    assert.equal(error.code, 'CONTRACT_WRITE_FAILED')
    assert.equal(error.message.includes('WRITE_SECRET_VALUE'), false)
    await assertMissing(files.rawPath)
  })

  it('拒绝非法官方 URL、非当前 commit 与非法 Dataset ID，并逐次销毁 raw', async () => {
    const cases = [
      [manifest({ officialUrls: ['https://developers.facebook.com.evil.test/docs'] }), 'OFFICIAL_URL_INVALID'],
      [manifest({ releaseCommit: 'a'.repeat(40) }), 'COMMIT_INVALID'],
      [manifest({ request: { datasetId: '12345678' } }), 'DATASET_ID_INVALID'],
    ]
    for (const [input, code] of cases) {
      const files = await fixture({ manifest: input })
      const error = await captureError(() => record(files))
      assert.equal(error.code, code)
      await assertMissing(files.rawPath)
    }
  })

  it('拒绝 raw symlink 且只删除链接，不删除目标', async () => {
    const files = await fixture()
    const target = path.join(files.dir, 'raw-target.json')
    await writeFile(target, JSON.stringify(raw()))
    await rm(files.rawPath)
    await symlink(target, files.rawPath)

    const error = await captureError(() => record(files))
    assert.equal(error.code, 'RAW_SYMLINK')
    await assertMissing(files.rawPath)
    await access(target)
  })

  it('拒绝超限、目录和非 JSON raw；普通文件均被销毁', async () => {
    const oversized = await fixture({ rawText: ' '.repeat(MAX_RAW_BYTES + 1) })
    assert.equal((await captureError(() => record(oversized))).code, 'RAW_TOO_LARGE')
    await assertMissing(oversized.rawPath)

    const invalidJson = await fixture({ rawText: '{not-json:SENSITIVE_FIXTURE_VALUE' })
    assert.equal((await captureError(() => record(invalidJson))).code, 'RAW_NOT_JSON')
    await assertMissing(invalidJson.rawPath)

    const directory = await fixture()
    await rm(directory.rawPath)
    await mkdir(directory.rawPath)
    assert.equal((await captureError(() => record(directory))).code, 'RAW_NOT_FILE')
  })

  it('CLI stdout/stderr 仅输出稳定状态，不泄漏 raw、Dataset ID 或路径', async () => {
    const files = await fixture({ raw: raw({ access_token: 'CLI_SECRET_FIXTURE' }) })
    const stdout = bufferWriter()
    const stderr = bufferWriter()
    const exitCode = await main({
      argv: [files.manifestPath, files.rawPath, files.outputPath],
      currentCommit: COMMIT,
      stdout,
      stderr,
    })

    const output = `${stdout.value}\n${stderr.value}`
    assert.equal(exitCode, 1)
    assert.match(stderr.value, /SENSITIVE_KEY_REJECTED/)
    for (const secret of ['CLI_SECRET_FIXTURE', DATASET_ID, files.rawPath, files.manifestPath]) {
      assert.equal(output.includes(secret), false)
    }
    await assertMissing(files.rawPath)
  })
})

function bufferWriter() {
  return {
    value: '',
    write(chunk) { this.value += String(chunk) },
  }
}
