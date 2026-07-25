import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  parseAttributionOperationArgs,
  runAttributionCutoverOperation,
} from './operate-attribution-cutover.mjs'

const SESSION = 'a'.repeat(64)

describe('归因生产切换操作工具', () => {
  it('只接受固定生产模式和非敏感 runId', () => {
    assert.deepEqual(parseAttributionOperationArgs(['synthetic']), {
      mode: 'synthetic',
      runId: 'cutover-production-v1',
      apiUrl: 'https://api.616618.xyz',
    })
    assert.deepEqual(parseAttributionOperationArgs([
      'activate',
      '--run-id',
      'cutover-production-2',
    ]), {
      mode: 'activate',
      runId: 'cutover-production-2',
      apiUrl: 'https://api.616618.xyz',
    })
    assert.throws(
      () => parseAttributionOperationArgs([
        'synthetic',
        '--api-url',
        'https://example.com',
      ]),
      /ATTRIBUTION_OPERATION_ARGUMENT_INVALID/,
    )
    assert.throws(
      () => parseAttributionOperationArgs([
        'synthetic',
        '--token',
        'secret',
      ]),
      /ATTRIBUTION_OPERATION_ARGUMENT_INVALID/,
    )
  })

  it('三平台验证只提示所需测试码并等待脱敏终态', async () => {
    const calls = []
    const prompts = []
    const logs = []
    const result = await runAttributionCutoverOperation({
      argv: ['synthetic'],
      promptSession: async () => SESSION,
      promptTestCode: async (provider, name) => {
        prompts.push({ provider, name })
        return 'TEST12345'
      },
      sleep: async () => undefined,
      now: () => 1_000,
      fetch: async (input, init = {}) => {
        const url = new URL(input)
        calls.push({
          path: `${url.pathname}${url.search}`,
          method: init.method,
          headers: Object.fromEntries(new Headers(init.headers)),
          body: init.body,
        })
        if (url.pathname.endsWith('/connections')) {
          return Response.json({
            data: [
              connection('conn_meta', 'meta', {
                state: 'candidate',
              }),
              connection(
                'conn_tiktok',
                'tiktok',
                null,
                'not_configured',
              ),
              connection('conn_google', 'google', {
                state: 'candidate',
              }),
            ],
          })
        }
        if (
          url.pathname.endsWith('/candidate/validation')
          && init.method === 'POST'
        ) {
          return Response.json({ data: {} })
        }
        if (url.pathname.endsWith('/candidate/validation')) {
          const connectionId = url.pathname.includes('conn_meta')
            ? 'conn_meta'
            : 'conn_google'
          const provider = connectionId === 'conn_meta'
            ? 'meta'
            : 'google'
          return Response.json({
            data: {
              provider,
              connectionId,
              status: 'verified',
              failureCode: '',
              candidateChecked: true,
              pairedEventCount: 2,
            },
          })
        }
        return Response.json({
          error: { code: 'UNEXPECTED_REQUEST' },
        }, { status: 500 })
      },
      log: value => logs.push(value),
    })

    assert.deepEqual(prompts, [{
      provider: 'meta',
      name: 'Meta 主连接',
    }])
    assert.deepEqual(result, {
      status: 'ATTRIBUTION_SYNTHETIC_VERIFIED',
      results: [
        {
          provider: 'meta',
          connectionId: 'conn_meta',
          status: 'verified',
          pairedEventCount: 2,
        },
        {
          provider: 'tiktok',
          connectionId: 'conn_tiktok',
          status: 'skipped_not_configured',
          pairedEventCount: 0,
        },
        {
          provider: 'google',
          connectionId: 'conn_google',
          status: 'verified',
          pairedEventCount: 2,
        },
      ],
    })
    const posts = calls.filter(call =>
      call.method === 'POST'
      && call.path.endsWith('/candidate/validation'))
    assert.equal(posts.length, 2)
    assert.equal(
      JSON.parse(posts.find(call =>
        call.path.includes('conn_meta')).body).testEventCode,
      'TEST12345',
    )
    assert.deepEqual(
      JSON.parse(posts.find(call =>
        call.path.includes('conn_google')).body),
      {},
    )
    assert.ok(posts.every(call =>
      /^attribution-operation:[a-f0-9]{64}$/.test(
        call.headers['idempotency-key'],
      )))
    const reads = calls.filter(call =>
      call.method === 'GET'
      && call.path.endsWith('/candidate/validation'))
    assert.equal(reads.length, 2)
    assert.ok(reads.every(read => posts.some(post =>
      post.path === read.path
      && post.headers['idempotency-key']
        === read.headers['idempotency-key'])))
    assert.equal(logs.join('\n').includes(SESSION), false)
    assert.equal(logs.join('\n').includes('TEST12345'), false)
  })

  it('已激活且没有候选的连接不重复发起 synthetic', async () => {
    const calls = []
    const result = await runAttributionCutoverOperation({
      argv: ['synthetic'],
      promptSession: async () => SESSION,
      promptTestCode: async () => {
        throw new Error('不应读取测试码')
      },
      fetch: async (input, init = {}) => {
        const url = new URL(input)
        calls.push({ path: url.pathname, method: init.method })
        return Response.json({
          data: [connection('conn_meta', 'meta', null)],
        })
      },
      log: () => undefined,
    })

    assert.deepEqual(result, {
      status: 'ATTRIBUTION_SYNTHETIC_VERIFIED',
      results: [{
        provider: 'meta',
        connectionId: 'conn_meta',
        status: 'already_verified',
        pairedEventCount: 0,
      }],
    })
    assert.deepEqual(calls, [{
      path: '/api/admin/attribution-runtime/connections',
      method: 'GET',
    }])
  })

  it('激活严格按 old 到 draining 再到 new 推进', async () => {
    const calls = []
    const logs = []
    let owner = 'old'
    let epoch = 1
    const result = await runAttributionCutoverOperation({
      argv: ['activate', '--run-id', 'cutover-production-2'],
      promptSession: async () => SESSION,
      fetch: async (input, init = {}) => {
        const url = new URL(input)
        const body = init.body === undefined
          ? undefined
          : JSON.parse(init.body)
        calls.push({
          path: `${url.pathname}${url.search}`,
          method: init.method,
          body,
          headers: Object.fromEntries(new Headers(init.headers)),
        })
        if (url.pathname.endsWith('/transition')) {
          owner = body.targetOwner
          epoch += 1
          return Response.json({
            data: {
              state: { owner, epoch },
              preflight: {},
            },
          })
        }
        return Response.json({
          data: {
            current: { owner, epoch },
            localReady: true,
          },
        })
      },
      log: value => logs.push(value),
    })

    assert.deepEqual(result, {
      status: 'ATTRIBUTION_RUNTIME_OWNER_NEW',
      owner: 'new',
      epoch: 3,
    })
    const transitions = calls.filter(call =>
      call.path.endsWith('/transition'))
    assert.deepEqual(
      transitions.map(call => call.body.targetOwner),
      ['draining', 'new'],
    )
    assert.deepEqual(
      transitions.map(call => call.body.expectedEpoch),
      [1, 2],
    )
    assert.ok(transitions.every(call =>
      /^attribution-operation:[a-f0-9]{64}$/.test(
        call.headers['idempotency-key'],
      )))
    assert.equal(logs.join('\n').includes(SESSION), false)
  })

  it('进入 draining 后自动等待旧工作排空再切换 new', async () => {
    let owner = 'old'
    let epoch = 1
    let newPreflightReads = 0
    let sleeps = 0
    const result = await runAttributionCutoverOperation({
      argv: ['activate', '--run-id', 'cutover-production-wait'],
      promptSession: async () => SESSION,
      sleep: async () => {
        sleeps += 1
      },
      now: () => 1_000,
      fetch: async (input, init = {}) => {
        const url = new URL(input)
        const body = init.body === undefined
          ? undefined
          : JSON.parse(init.body)
        if (url.pathname.endsWith('/transition')) {
          owner = body.targetOwner
          epoch += 1
          return Response.json({
            data: {
              state: { owner, epoch },
              preflight: {},
            },
          })
        }
        if (url.searchParams.get('targetOwner') === 'new') {
          newPreflightReads += 1
          return Response.json({
            data: {
              current: { owner, epoch },
              localReady: newPreflightReads >= 2,
            },
          })
        }
        return Response.json({
          data: {
            current: { owner, epoch },
            localReady: true,
          },
        })
      },
      log: () => undefined,
    })

    assert.deepEqual(result, {
      status: 'ATTRIBUTION_RUNTIME_OWNER_NEW',
      owner: 'new',
      epoch: 3,
    })
    assert.equal(newPreflightReads, 2)
    assert.equal(sleeps, 1)
  })

  it('上游正文和会话不会进入失败错误', async () => {
    await assert.rejects(
      runAttributionCutoverOperation({
        argv: ['synthetic'],
        promptSession: async () => SESSION,
        fetch: async () => Response.json({
          error: {
            code: 'ATTRIBUTION_CUTOVER_PREFLIGHT_BLOCKED',
            detail: `sensitive-${SESSION}`,
          },
        }, { status: 409 }),
        log: () => undefined,
      }),
      (error) => {
        assert.match(
          error.message,
          /ATTRIBUTION_OPERATION_CUTOVER_PREFLIGHT_BLOCKED/,
        )
        assert.equal(error.message.includes(SESSION), false)
        return true
      },
    )
  })
})

function connection(
  id,
  provider,
  candidate,
  state = candidate ? 'not_configured' : 'active',
) {
  const names = {
    meta: 'Meta 主连接',
    tiktok: 'TikTok 主连接',
    google: 'Google 主连接',
  }
  return {
    id,
    provider,
    name: names[provider],
    state,
    candidate,
  }
}
