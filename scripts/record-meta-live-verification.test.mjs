import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import {
  buildMetaLiveEvidence,
  recordMetaLiveVerification,
} from './record-meta-live-verification.mjs'

const COMMIT = '18dc11e0b0e4797683d4551a93a1f22e53dc4628'
const RAW_IDS = {
  Contact: 'contact-browser-server-raw-id',
  Lead: 'lead-browser-server-raw-id',
  CompleteRegistration: 'registration-browser-server-raw-id',
}

function verifiedRuntimeOptions(overrides = {}) {
  return {
    env: {
      VERIFY_DEV_API_URL: 'https://api-dev.example.workers.dev',
      VERIFY_DEV_WEB_URL: 'https://web-dev.example.workers.dev',
    },
    fetch: async url => {
      const pathname = new URL(String(url)).pathname
      return new Response(JSON.stringify({
        status: 'ok',
        db: pathname === '/api/health' ? 'ok' : undefined,
        environment: 'dev',
        commit: COMMIT,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
    ...overrides,
  }
}

function validInput() {
  return {
    confirmedBy: 'owner',
    pixelId: '12345678906781',
    commit: COMMIT,
    now: '2026-07-10T00:00:00.000Z',
    noStartTrial: true,
    eventResults: Object.entries(RAW_IDS).map(([eventName, eventId]) => ({
      eventName,
      browserEventId: eventId,
      serverEventId: eventId,
      deduplicated: true,
    })),
  }
}

describe('Meta live evidence 人工录入', () => {
  it('只保留 Pixel 后四位和 event ID 摘要', () => {
    const evidence = buildMetaLiveEvidence(validInput())
    const serialized = JSON.stringify(evidence)

    assert.equal(evidence.pixelIdSuffix, '6781')
    assert.deepEqual(evidence.events.map(event => event.eventName), ['Contact', 'Lead', 'CompleteRegistration'])
    for (const event of evidence.events) {
      const rawId = RAW_IDS[event.eventName]
      const expected = createHash('sha256').update(rawId).digest('hex').slice(0, 12)
      assert.equal(event.eventIdDigest, `sha256:${expected}`)
      assert.equal(event.eventIdMatched, true)
      assert.equal(serialized.includes(rawId), false)
    }
    assert.equal(serialized.includes('12345678906781'), false)
  })

  it('拒绝 ID 不同、未去重、事件缺失和存在 StartTrial', () => {
    const base = validInput()
    const invalidInputs = [
      {
        ...base,
        eventResults: base.eventResults.map((event, index) => index === 0 ? { ...event, serverEventId: 'different-id' } : event),
      },
      {
        ...base,
        eventResults: base.eventResults.map((event, index) => index === 0 ? { ...event, deduplicated: false } : event),
      },
      { ...base, eventResults: base.eventResults.slice(0, 2) },
      { ...base, noStartTrial: false },
    ]

    for (const input of invalidInputs) assert.throws(() => buildMetaLiveEvidence(input))
  })

  it('交互命令不打印原始 ID，且验证失败时不写文件', async () => {
    const answers = [
      'owner',
      '12345678906781',
      RAW_IDS.Contact,
      RAW_IDS.Contact,
      'yes',
      RAW_IDS.Lead,
      'different-lead-id',
      'yes',
      RAW_IDS.CompleteRegistration,
      RAW_IDS.CompleteRegistration,
      'yes',
      'yes',
    ]
    const output = []
    let writeCount = 0

    await assert.rejects(async () => {
      await recordMetaLiveVerification({
        ...verifiedRuntimeOptions(),
        ask: async () => answers.shift(),
        output: message => output.push(String(message)),
        getCommit: async () => COMMIT,
        now: '2026-07-10T00:00:00.000Z',
        writeEvidence: async () => {
          writeCount += 1
        },
      })
    }, /ID 不一致/)

    assert.equal(writeCount, 0)
    for (const value of Object.values(RAW_IDS)) assert.equal(output.join('\n').includes(value), false)
    assert.equal(output.join('\n').includes('different-lead-id'), false)
  })

  it('confirmedBy 夹带敏感值时拒绝且不写文件', async () => {
    for (const confirmedBy of [
      'owner:fb.1.1700000000000.123456789',
      'owner:2001:db8::1',
      'owner:test_event_code=TEST123',
      'owner:raw-event-id-123',
    ]) {
      const answers = [
        confirmedBy,
        '12345678906781',
        RAW_IDS.Contact,
        RAW_IDS.Contact,
        'yes',
        RAW_IDS.Lead,
        RAW_IDS.Lead,
        'yes',
        RAW_IDS.CompleteRegistration,
        RAW_IDS.CompleteRegistration,
        'yes',
        'yes',
      ]
      let writeCount = 0
      await assert.rejects(async () => {
        await recordMetaLiveVerification({
          ...verifiedRuntimeOptions(),
          ask: async () => answers.shift(),
          output: () => {},
          getCommit: async () => COMMIT,
          now: '2026-07-10T00:00:00.000Z',
          writeEvidence: async () => {
            writeCount += 1
          },
        })
      }, /确认人|confirmedBy|敏感/)
      assert.equal(writeCount, 0)
    }
  })

  it('任一 Worker 仍是旧 commit 时不进入录入且不写 evidence', async () => {
    let askCount = 0
    let writeCount = 0

    await assert.rejects(() => recordMetaLiveVerification({
      ...verifiedRuntimeOptions({
        fetch: async url => new Response(JSON.stringify({
          status: 'ok',
          environment: 'dev',
          commit: new URL(String(url)).pathname === '/__release'
            ? 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
            : COMMIT,
        }), { status: 200 }),
      }),
      ask: async () => {
        askCount += 1
        return ''
      },
      getCommit: async () => COMMIT,
      writeEvidence: async () => {
        writeCount += 1
      },
    }), /Web 发布 commit 与本地 Git HEAD 不一致/)

    assert.equal(askCount, 0)
    assert.equal(writeCount, 0)
  })

  it('发布身份 endpoint 缺失时不写 evidence，错误不泄露 URL 凭证或响应原文', async () => {
    const secretResponse = 'raw-response-with-secret'
    let writeCount = 0
    let caught

    try {
      await recordMetaLiveVerification({
        ...verifiedRuntimeOptions({
          fetch: async url => new URL(String(url)).pathname === '/__release'
            ? new Response(secretResponse, { status: 404 })
            : new Response(JSON.stringify({ status: 'ok', db: 'ok', environment: 'dev', commit: COMMIT }), { status: 200 }),
        }),
        ask: async () => '',
        getCommit: async () => COMMIT,
        writeEvidence: async () => {
          writeCount += 1
        },
      })
    } catch (error) {
      caught = error
    }

    assert.match(String(caught?.message || caught), /Web 发布身份端点不可用/)
    assert.equal(String(caught?.message || caught).includes(secretResponse), false)
    assert.equal(writeCount, 0)
  })

  it('缺少 VERIFY_DEV URL 时在录入前失败', async () => {
    let writeCount = 0
    await assert.rejects(() => recordMetaLiveVerification({
      env: {},
      ask: async () => '',
      getCommit: async () => COMMIT,
      writeEvidence: async () => {
        writeCount += 1
      },
    }), /VERIFY_DEV_API_URL/)
    assert.equal(writeCount, 0)
  })
})
