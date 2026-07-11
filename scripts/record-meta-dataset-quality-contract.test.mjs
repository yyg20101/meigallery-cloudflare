import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, open, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import {
  ContractRecorderError,
  MAX_RAW_BYTES,
  assertSafeContractDocument,
  main,
  recordMetaDatasetQualityContract,
} from './record-meta-dataset-quality-contract.mjs'

const COMMIT = '95fae701b4a38c99b50ef694690e8df2eeec88ae'
const DATASET_ID = '1234567890123456789'
const UNKNOWN_VALUE = 'UNKNOWN_VALUE_MUST_NOT_LEAK'
const ENCODED_DATASET_ID = [...DATASET_ID]
  .map(character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
  .join('')
const DOUBLE_ENCODED_DATASET_ID = ENCODED_DATASET_ID.replaceAll('%', '%25')
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
    assert.equal(decodePercentTwice(document).includes(DATASET_ID), false)
    assert.equal(document.includes('fixture_metric_value'), false)
    assert.equal(document.includes('fixture_freshness_value'), false)
    assert.equal(document.includes(UNKNOWN_VALUE), false)
    await assertMissing(files.rawPath)
  })

  it('三个审查反例均在 stage 前以稳定脱敏错误拒绝并销毁 raw', async () => {
    const baseManifest = manifest()
    const allowlistedLeakPath = `$.data[].allowlisted_${DATASET_ID}`
    const cases = [
      { manifest: manifest({ request: { endpointPath: `/{dataset_id}/quality_${DATASET_ID}` } }) },
      { manifest: manifest({ request: { permissions: [`ads_${DATASET_ID}`] } }) },
      {
        manifest: manifest({
          ownerAllowlist: {
            responsePaths: [...baseManifest.ownerAllowlist.responsePaths, allowlistedLeakPath],
          },
        }),
        raw: raw({
          [`allowlisted_${DATASET_ID}`]: 1,
          [`rejected_${DATASET_ID}`]: 1,
        }),
      },
    ]

    for (const input of cases) {
      const files = await fixture(input)
      let stageCalled = false
      const error = await captureError(() => record(files, {
        stageContract: async () => {
          stageCalled = true
          throw new Error('不应进入 stage')
        },
      }))

      assert.equal(error.code, 'CONTRACT_REDACTION_FAILED')
      assert.equal(error.message.includes(DATASET_ID), false)
      assert.equal(stageCalled, false)
      await assertMissing(files.rawPath)
      await assertMissing(files.outputPath)
    }
  })

  it('最终 Markdown 兜底扫描拒绝明文、百分号与双编码且不回显 Dataset ID', () => {
    for (const exposed of [DATASET_ID, ENCODED_DATASET_ID, DOUBLE_ENCODED_DATASET_ID]) {
      assert.throws(
        () => assertSafeContractDocument(`# contract\n\n${exposed}\n`, DATASET_ID),
        error => {
          assert.equal(error.code, 'CONTRACT_REDACTION_FAILED')
          assert.equal(error.message.includes(DATASET_ID), false)
          assert.equal(error.message.includes(exposed), false)
          return true
        },
      )
    }
  })

  it('敏感键无论 allowlist 与否均硬拒绝，且销毁 raw', async () => {
    for (const key of ['access_token', 'test_event_code', 'email', 'phone', 'client_ip', 'clientIp', 'client_ua', 'clientUa', 'client_ip_address', 'client_user_agent', 'fbp', 'fbc', 'external_id', 'event_id', 'eventId', 'delivery_id', 'deliveryId']) {
      const files = await fixture({ raw: raw({ [key]: 'SENSITIVE_FIXTURE_VALUE' }) })
      const error = await captureError(() => record(files))
      assert.equal(error.code, 'SENSITIVE_KEY_REJECTED', key)
      await assertMissing(files.rawPath)
      await assertMissing(files.outputPath)
    }
  })

  it('敏感父路径下的 id/ids 数组及命名变体全部拒绝，误 allowlist 同样失败', async () => {
    for (const [parent, child] of [
      ['user', { id: 'SENSITIVE_FIXTURE_VALUE' }],
      ['event', { ids: ['SENSITIVE_FIXTURE_VALUE'] }],
      ['session', { details: { i_d: 'SENSITIVE_FIXTURE_VALUE' } }],
      ['delivery', { details: { 'i-d-s': ['SENSITIVE_FIXTURE_VALUE'] } }],
      ['users', [{ IDs: ['SENSITIVE_FIXTURE_VALUE'] }]],
      ['deliveries', [{ record: { ID: 'SENSITIVE_FIXTURE_VALUE' } }]],
    ]) {
      const files = await fixture({ raw: raw({ [parent]: child }) })
      const error = await captureError(() => record(files))
      assert.equal(error.code, 'SENSITIVE_KEY_REJECTED', parent)
      await assertMissing(files.rawPath)
      await assertMissing(files.outputPath)
    }

    for (const sensitivePath of [
      '$.data[].user.id',
      '$.data[].event.ids[]',
      '$.data[].session.details.i_d',
      '$.data[].delivery.details.i-d-s[]',
    ]) {
      const files = await fixture({
        manifest: manifest({ ownerAllowlist: { responsePaths: [sensitivePath] } }),
      })
      const error = await captureError(() => record(files))
      assert.equal(error.code, 'SENSITIVE_KEY_REJECTED', sensitivePath)
      await assertMissing(files.rawPath)
      await assertMissing(files.outputPath)
    }
  })

  it('允许 Owner 明确批准合法聚合 metric.id 与 metric.ids[]，且不输出其值', async () => {
    const approvedPaths = ['$.data[].metric.id', '$.data[].metric.ids[]']
    const baseManifest = manifest()
    const files = await fixture({
      raw: raw({ metric: { id: 'AGGREGATE_METRIC_ID_VALUE', ids: ['AGGREGATE_METRIC_IDS_VALUE'] } }),
      manifest: manifest({
        ownerAllowlist: {
          responsePaths: [...baseManifest.ownerAllowlist.responsePaths, ...approvedPaths],
        },
      }),
    })

    await record(files)
    const document = await readFile(files.outputPath, 'utf8')
    assert.match(document, /\$\.data\[\]\.metric\.id.*string.*否/)
    assert.match(document, /\$\.data\[\]\.metric\.ids\[\].*string.*否/)
    assert.equal(document.includes('AGGREGATE_METRIC_ID_VALUE'), false)
    assert.equal(document.includes('AGGREGATE_METRIC_IDS_VALUE'), false)
  })

  it('未知字段只记录 path，不记录原始值', async () => {
    const files = await fixture()
    await record(files)
    const document = await readFile(files.outputPath, 'utf8')
    assert.match(document, /`\$\.data\[\]\.unknown_field`/)
    assert.equal(document.includes(UNKNOWN_VALUE), false)
  })

  it('truncate、sync、close 或 unlink 失败均以稳定 cleanup error 优先', async () => {
    for (const operation of ['truncate', 'sync', 'close', 'unlink']) {
      const files = await fixture({ raw: raw({ access_token: 'PRIMARY_SECRET_VALUE' }) })
      const failure = operation === 'unlink' ? null : failingRawOperation(files.rawPath, operation)
      let error
      try {
        error = await captureError(() => record(files, operation === 'unlink'
          ? { unlinkFile: async () => { throw new Error('DELETE_SECRET_VALUE') } }
          : { openFile: failure.openFile }))
      } finally {
        await failure?.release()
      }

      assert.equal(error.code, 'RAW_DELETE_FAILED', operation)
      assert.equal(error.message.includes('SECRET_VALUE'), false)
      await assertMissing(files.outputPath)
      if (operation === 'unlink') {
        assert.equal((await stat(files.rawPath)).size, 0)
        assert.equal(await readFile(files.rawPath, 'utf8'), '')
      } else {
        await assertMissing(files.rawPath)
      }
    }
  })

  it('raw 读取后被改名时仍通过原 fd 清零移动后的 inode', async () => {
    const files = await fixture()
    const movedPath = path.join(files.dir, 'raw-moved.json')

    await record(files, {
      stageContract: async (outputPath, document) => {
        await rename(files.rawPath, movedPath)
        let active = true
        return {
          async finalize() {
            if (!active) throw new Error('inactive')
            await writeFile(outputPath, document)
            active = false
          },
          async abort() { active = false },
        }
      },
    })

    await assertMissing(files.rawPath)
    assert.equal((await stat(movedPath)).size, 0)
    assert.equal(await readFile(movedPath, 'utf8'), '')
    await access(files.outputPath)
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

  it('真实 contract 写入失败叠加 cleanup 失败时稳定以 cleanup error 优先', async () => {
    const files = await fixture()
    await writeFile(files.outputPath, 'EXISTING_CONTRACT')
    const failure = failingRawOperation(files.rawPath, 'close')
    let error
    try {
      error = await captureError(() => record(files, { openFile: failure.openFile }))
    } finally {
      await failure.release()
    }

    assert.equal(error.code, 'RAW_DELETE_FAILED')
    assert.equal(error.message.includes('CONTRACT'), false)
    assert.equal(await readFile(files.outputPath, 'utf8'), 'EXISTING_CONTRACT')
    await assertMissing(files.rawPath)
  })

  it('拒绝非法官方 URL、非当前 commit 与非法 Dataset ID，并逐次销毁 raw', async () => {
    const cases = [
      [manifest({ officialUrls: ['https://developers.facebook.com.evil.test/docs'] }), 'OFFICIAL_URL_INVALID'],
      [manifest({ officialUrls: [`https://business.facebook.com/events_manager2/list/dataset/${DATASET_ID}%/`] }), 'OFFICIAL_URL_INVALID'],
      [manifest({ officialUrls: [`https://business.facebook.com/events_manager2/list/dataset/${DOUBLE_ENCODED_DATASET_ID}/`] }), 'OFFICIAL_URL_INVALID'],
      [manifest({ officialUrls: [`https://business.facebook.com/events_manager2/list/dataset/?asset_id=${DATASET_ID}`] }), 'OFFICIAL_URL_INVALID'],
      [manifest({ officialUrls: [`https://business.facebook.com/events_manager2/list/dataset/prefix${DATASET_ID}/`] }), 'OFFICIAL_URL_INVALID'],
      [manifest({ officialUrls: [`https://business.facebook.com/events_manager2/list/dataset/${DATASET_ID}/asset_${ENCODED_DATASET_ID}`] }), 'OFFICIAL_URL_INVALID'],
      [manifest({ officialUrls: [`https://business.facebook.com/events_manager2/list/dataset/${DATASET_ID}/?asset_${ENCODED_DATASET_ID}=score`] }), 'OFFICIAL_URL_INVALID'],
      [manifest({ officialUrls: [`https://business.facebook.com/events_manager2/list/dataset/${DATASET_ID}/?asset_${DOUBLE_ENCODED_DATASET_ID}=score`] }), 'OFFICIAL_URL_INVALID'],
      [manifest({ request: { queryKeys: [`asset_${DATASET_ID}`] } }), 'REQUEST_INVALID'],
      [manifest({ releaseCommit: 'a'.repeat(40) }), 'COMMIT_INVALID'],
      [manifest({ request: { datasetId: '12345678' } }), 'DATASET_ID_INVALID'],
    ]
    for (const [input, code] of cases) {
      const files = await fixture({ manifest: input })
      const error = await captureError(() => record(files))
      assert.equal(error.code, code)
      assert.equal(error.message.includes(DATASET_ID), false)
      assert.equal(error.message.toUpperCase().includes(ENCODED_DATASET_ID), false)
      await assertMissing(files.rawPath)
    }
  })

  it('逐字符百分号编码的 Dataset ID 仅生成不可逆 mask，query 仅保留 key', async () => {
    const files = await fixture({
      manifest: manifest({
        officialUrls: [
          `https://business.facebook.com/events_manager2/list/dataset/${ENCODED_DATASET_ID}/?fields=score&asset_id=${ENCODED_DATASET_ID}`,
        ],
      }),
    })

    await record(files)
    const document = await readFile(files.outputPath, 'utf8')
    assert.match(document, /https:\/\/business\.facebook\.com\/events_manager2\/list\/dataset\/1234\.\.\.6789\/?\?asset_id&fields/)
    assert.equal(document.includes(DATASET_ID), false)
    assert.equal(document.toUpperCase().includes(ENCODED_DATASET_ID), false)
    assert.equal(decodeURIComponent(document).includes(DATASET_ID), false)
    assert.equal(document.includes('asset_id='), false)
    assert.equal(document.includes('fields='), false)
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

function decodePercentTwice(value) {
  let decoded = value
  for (let pass = 0; pass < 2; pass += 1) {
    decoded = decoded.replace(/%([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
  }
  return decoded
}

function failingRawOperation(rawPath, operation) {
  let rawHandle = null
  return {
    async openFile(filePath, flags) {
      const handle = await open(filePath, flags)
      if (filePath !== rawPath) return handle
      rawHandle = handle

      return {
        stat: (...args) => handle.stat(...args),
        readFile: (...args) => handle.readFile(...args),
        truncate: (...args) => operation === 'truncate'
          ? Promise.reject(new Error('TRUNCATE_SECRET_VALUE'))
          : handle.truncate(...args),
        sync: (...args) => operation === 'sync'
          ? Promise.reject(new Error('SYNC_SECRET_VALUE'))
          : handle.sync(...args),
        close: (...args) => operation === 'close'
          ? Promise.reject(new Error('CLOSE_SECRET_VALUE'))
          : handle.close(...args),
      }
    },
    async release() {
      await rawHandle?.close().catch(() => {})
    },
  }
}
