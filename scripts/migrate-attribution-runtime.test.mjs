import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  normalizeOwnerSession,
  parseMigrationArgs,
  runAttributionMigration,
} from './migrate-attribution-runtime.mjs'

const RUN_ID = 'migration-production-v1'
const SESSION = 'a'.repeat(64)
const RESULT = {
  runId: RUN_ID,
  phase: 'initial',
  snapshotHash: 'b'.repeat(64),
  sourceConfigurationHash: 'c'.repeat(64),
  credentialSetHash: 'd'.repeat(64),
  capturedAt: '2026-07-24T12:00:00.000Z',
  replayed: false,
  counts: {
    connections: 2,
    versions: 2,
    credentials: 2,
    bindings: 4,
    managedSources: 1,
    historyRows: 3,
    historyFacts: 10,
  },
}

describe('归因运行时迁移脚本', () => {
  it('仅接受非敏感参数并默认面向生产 API', () => {
    assert.deepEqual(parseMigrationArgs([]), {
      apiUrl: 'https://api.616618.xyz',
      runId: RUN_ID,
      phase: 'initial',
      initialRunId: undefined,
    })
    assert.deepEqual(parseMigrationArgs([
      '--run-id',
      'migration-retry-2',
    ]), {
      apiUrl: 'https://api.616618.xyz',
      runId: 'migration-retry-2',
      phase: 'initial',
      initialRunId: undefined,
    })
    assert.deepEqual(parseMigrationArgs([
      '--run-id',
      'migration-reconcile-1',
      '--phase',
      'reconcile',
      '--initial-run-id',
      RUN_ID,
    ]), {
      apiUrl: 'https://api.616618.xyz',
      runId: 'migration-reconcile-1',
      phase: 'reconcile',
      initialRunId: RUN_ID,
    })
    assert.throws(
      () => parseMigrationArgs([
        '--api-url',
        'https://api.example.com/',
      ]),
      /ATTRIBUTION_MIGRATION_ARGUMENT_INVALID/,
    )
    assert.throws(
      () => parseMigrationArgs(['--token', 'secret']),
      /ATTRIBUTION_MIGRATION_ARGUMENT_INVALID/,
    )
    assert.throws(
      () => parseMigrationArgs(['--cookie', `mei_session=${SESSION}`]),
      /ATTRIBUTION_MIGRATION_ARGUMENT_INVALID/,
    )
  })

  it('只提取规范 Owner 会话 Cookie', () => {
    assert.equal(
      normalizeOwnerSession(SESSION),
      `mei_session=${SESSION}`,
    )
    assert.equal(
      normalizeOwnerSession(`other=x; mei_session=${SESSION}; ignored=y`),
      `mei_session=${SESSION}`,
    )
    assert.throws(
      () => normalizeOwnerSession('mei_session=invalid'),
      /ATTRIBUTION_MIGRATION_ADMIN_SESSION_INVALID/,
    )
  })

  it('请求和输出不携带平台凭证或 Owner 会话', async () => {
    const logs = []
    let request
    const result = await runAttributionMigration({
      argv: [],
      promptSession: async () => SESSION,
      fetch: async (input, init) => {
        request = { input, init }
        return Response.json({ data: RESULT })
      },
      log: message => logs.push(message),
    })

    assert.deepEqual(result, RESULT)
    assert.equal(
      request.input,
      'https://api.616618.xyz/api/admin/attribution-migration',
    )
    assert.equal(request.init.headers.Cookie, `mei_session=${SESSION}`)
    assert.deepEqual(JSON.parse(request.init.body), {
      runId: RUN_ID,
      phase: 'initial',
    })
    assert.equal(JSON.stringify(result).includes(SESSION), false)
    assert.equal(logs.join('\n').includes(SESSION), false)
  })

  it('上游错误正文不会进入异常消息', async () => {
    await assert.rejects(
      runAttributionMigration({
        argv: [],
        promptSession: async () => SESSION,
        fetch: async () => Response.json({
          code: 'ATTRIBUTION_MIGRATION_TARGET_NOT_EMPTY',
          detail: `sensitive-${SESSION}`,
        }, { status: 409 }),
        log: () => {},
      }),
      (error) => {
        assert.match(
          error.message,
          /ATTRIBUTION_MIGRATION_TARGET_NOT_EMPTY/,
        )
        assert.equal(error.message.includes(SESSION), false)
        return true
      },
    )
  })
})
