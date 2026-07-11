import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildMetaLiveEvidence, recordMetaLiveVerification } from './record-meta-live-verification.mjs'

const COMMIT = '18dc11e0b0e4797683d4551a93a1f22e53dc4628'
const CONTRACT = { version: 1, digest: `sha256:${'9'.repeat(64)}` }
const DIGESTS = {
  Contact: `sha256:${'a'.repeat(64)}`,
  CompleteRegistration: `sha256:${'b'.repeat(64)}`,
}

function readiness() {
  return {
    environment: 'dev',
    commitSha: COMMIT,
    pixelId: '12345678906781',
    connectionVerifiedAt: '2026-07-09T23:55:00.000Z',
    challengeId: `mlc_${'c'.repeat(32)}`,
    eventDigests: DIGESTS,
    enhancedMatch: {
      completeRegistrationEmail: true,
      completeRegistrationExternalId: true,
      contactContainsRegistrationIdentity: false,
    },
    datasetQualityContractVersion: 1,
    datasetQualityContractDigest: CONTRACT.digest,
    datasetQualityCollectorCurrent: true,
  }
}

function validInput() {
  return {
    ...readiness(),
    commit: COMMIT,
    now: '2026-07-10T00:00:00.000Z',
    forbiddenEventsAbsent: { Lead: true, StartTrial: true },
    eventResults: Object.entries(DIGESTS).map(([eventName, eventIdDigest]) => ({
      eventName,
      eventIdDigest,
      browserSeen: true,
      serverSeen: true,
      deduplicated: true,
      eventsReceived: 1,
    })),
  }
}

function runtime(overrides = {}) {
  return {
    env: {
      VERIFY_DEV_API_URL: 'https://api-dev.example.workers.dev',
      VERIFY_DEV_WEB_URL: 'https://web-dev.example.workers.dev',
    },
    fetch: async () => new Response(JSON.stringify({ status: 'ok', environment: 'dev', commit: COMMIT }), { status: 200 }),
    getCommit: async () => COMMIT,
    verifyContract: async () => CONTRACT,
    readReadiness: async () => readiness(),
    destroyChallenge: async () => {},
    output: () => {},
    now: '2026-07-10T00:00:00.000Z',
    ...overrides,
  }
}

describe('Meta live evidence V2 Worker challenge 录入', () => {
  it('只接受 Worker 返回的不可逆摘要，证据不含原始 ID', () => {
    const evidence = buildMetaLiveEvidence(validInput())
    assert.equal(evidence.schemaVersion, 2)
    assert.deepEqual(evidence.events.map(event => event.browserEventId), Object.values(DIGESTS))
    assert.equal(JSON.stringify(evidence).includes('mlv_'), false)
  })

  it('不再询问或生成 event ID，只逐项确认 Browser/Server/去重并在成功后销毁 challenge', async () => {
    const prompts = []
    let destroyed = 0
    const result = await recordMetaLiveVerification(runtime({
      ask: async prompt => { prompts.push(prompt); return 'yes' },
      destroyChallenge: async challengeId => {
        destroyed += 1
        assert.equal(challengeId, readiness().challengeId)
      },
      writeEvidence: async () => ({ evidenceFile: '/tmp/evidence.json', latestFile: '/tmp/latest.json' }),
    }))
    assert.equal(result.evidence.schemaVersion, 2)
    assert.equal(prompts.some(prompt => /event ID/i.test(prompt)), false)
    assert.equal(prompts.length, 10)
    assert.equal(destroyed, 1)
  })

  it('Owner 任一确认失败时仍销毁 challenge 且不写 evidence', async () => {
    let destroyed = 0
    let writes = 0
    const answers = ['no', ...Array(9).fill('yes')]
    await assert.rejects(recordMetaLiveVerification(runtime({
      ask: async () => answers.shift(),
      destroyChallenge: async () => { destroyed += 1 },
      writeEvidence: async () => { writes += 1 },
    })), /确认不完整|Browser/)
    assert.equal(destroyed, 1)
    assert.equal(writes, 0)
  })

  it('缺失 challenge、错误 commit 或 Q5/collector pending 时不进入人工确认', async () => {
    for (const partial of [
      { challengeId: '' },
      { commitSha: 'd'.repeat(40) },
      { datasetQualityCollectorCurrent: false },
      { datasetQualityContractDigest: `sha256:${'8'.repeat(64)}` },
      { eventDigests: { ...DIGESTS, Contact: 'raw-event-id' } },
    ]) {
      let asks = 0
      await assert.rejects(recordMetaLiveVerification(runtime({
        readReadiness: async () => ({ ...readiness(), ...partial }),
        ask: async () => { asks += 1; return 'yes' },
      })))
      assert.equal(asks, 0)
    }
  })

  it('任一 dev Worker 不是当前 commit 时不读 D1 challenge', async () => {
    let reads = 0
    await assert.rejects(recordMetaLiveVerification(runtime({
      fetch: async url => new Response(JSON.stringify({
        status: 'ok',
        environment: 'dev',
        commit: new URL(String(url)).pathname === '/__release' ? 'd'.repeat(40) : COMMIT,
      }), { status: 200 }),
      readReadiness: async () => { reads += 1; return readiness() },
    })), /Web 发布 commit/)
    assert.equal(reads, 0)
  })
})
