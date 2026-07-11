import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import { buildMetaLiveEvidence, recordMetaLiveVerification } from './record-meta-live-verification.mjs'

const COMMIT = '18dc11e0b0e4797683d4551a93a1f22e53dc4628'
const RAW_IDS = {
  Contact: 'meta_verify_contact_0123456789abcdef',
  CompleteRegistration: 'meta_verify_registration_0123456789abcdef',
}

function readiness() {
  return {
    environment: 'dev',
    commitSha: COMMIT,
    pixelId: '12345678906781',
    connectionVerifiedAt: '2026-07-09T23:55:00.000Z',
    enhancedMatch: {
      completeRegistrationEmail: true,
      completeRegistrationExternalId: true,
      contactContainsRegistrationIdentity: false,
    },
    datasetQualityContractVersion: 1,
    datasetQualityCollectorCurrent: true,
  }
}

function validInput() {
  return {
    ...readiness(),
    commit: COMMIT,
    now: '2026-07-10T00:00:00.000Z',
    forbiddenEventsAbsent: { Lead: true, StartTrial: true },
    eventResults: Object.entries(RAW_IDS).map(([eventName, eventId]) => ({
      eventName,
      browserEventId: eventId,
      serverEventId: eventId,
      browserSeen: true,
      serverSeen: true,
      deduplicated: true,
      eventsReceived: 1,
    })),
  }
}

function verifiedRuntimeOptions(overrides = {}) {
  return {
    env: {
      VERIFY_DEV_API_URL: 'https://api-dev.example.workers.dev',
      VERIFY_DEV_WEB_URL: 'https://web-dev.example.workers.dev',
    },
    fetch: async url => new Response(JSON.stringify({
      status: 'ok',
      db: new URL(String(url)).pathname === '/api/health' ? 'ok' : undefined,
      environment: 'dev',
      commit: COMMIT,
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
    readReadiness: async () => readiness(),
    ...overrides,
  }
}

describe('Meta live evidence V2 人工录入', () => {
  it('从 readiness 生成 V2，只保留 Pixel mask 和 event ID 不可逆摘要', () => {
    const evidence = buildMetaLiveEvidence(validInput())
    const serialized = JSON.stringify(evidence)

    assert.equal(evidence.schemaVersion, 2)
    assert.equal(evidence.commitSha, COMMIT)
    assert.equal(evidence.environment, 'dev')
    assert.equal(evidence.pixelIdMasked, '1234****6781')
    assert.deepEqual(evidence.events.map(event => event.eventName), ['Contact', 'CompleteRegistration'])
    for (const event of evidence.events) {
      const expected = createHash('sha256').update(RAW_IDS[event.eventName]).digest('hex')
      assert.equal(event.browserEventId, `sha256:${expected}`)
      assert.equal(event.serverEventId, event.browserEventId)
      assert.equal(serialized.includes(RAW_IDS[event.eventName]), false)
    }
    assert.equal(serialized.includes('12345678906781'), false)
  })

  it('拒绝非本次 opaque 合成 ID、ID 不同、未 seen/去重/接收和禁止事件未确认', () => {
    const base = validInput()
    const mutateFirst = patch => ({
      ...base,
      eventResults: base.eventResults.map((event, index) => index === 0 ? { ...event, ...patch } : event),
    })
    for (const candidate of [
      mutateFirst({ serverEventId: 'meta_verify_different_0123456789abcdef' }),
      mutateFirst({ browserEventId: 'person@example.com', serverEventId: 'person@example.com' }),
      mutateFirst({ browserSeen: false }),
      mutateFirst({ serverSeen: false }),
      mutateFirst({ deduplicated: false }),
      mutateFirst({ eventsReceived: 0 }),
      { ...base, eventResults: base.eventResults.slice(0, 1) },
      { ...base, forbiddenEventsAbsent: { Lead: false, StartTrial: true } },
      { ...base, forbiddenEventsAbsent: { Lead: true, StartTrial: false } },
    ]) assert.throws(() => buildMetaLiveEvidence(candidate))
  })

  it('Q5 contract/collector pending 或增强匹配不足时稳定失败', () => {
    const base = validInput()
    for (const candidate of [
      { ...base, datasetQualityContractVersion: 0 },
      { ...base, datasetQualityCollectorCurrent: false },
      { ...base, enhancedMatch: { ...base.enhancedMatch, completeRegistrationEmail: false } },
      { ...base, enhancedMatch: { ...base.enhancedMatch, completeRegistrationExternalId: false } },
      { ...base, enhancedMatch: { ...base.enhancedMatch, contactContainsRegistrationIdentity: true } },
    ]) assert.throws(() => buildMetaLiveEvidence(candidate))
  })

  it('交互逐项确认 Browser、Server、dedup 和禁止事件，且从 D1 readiness 取增强匹配', async () => {
    const answers = [
      RAW_IDS.Contact, RAW_IDS.Contact, 'yes', 'yes', 'yes', 'yes',
      RAW_IDS.CompleteRegistration, RAW_IDS.CompleteRegistration, 'yes', 'yes', 'yes', 'yes',
      'yes', 'yes',
    ]
    let written
    const result = await recordMetaLiveVerification({
      ...verifiedRuntimeOptions(),
      ask: async () => answers.shift(),
      output: () => {},
      getCommit: async () => COMMIT,
      now: '2026-07-10T00:00:00.000Z',
      writeEvidence: async evidence => {
        written = evidence
        return { evidenceFile: '/tmp/evidence.json', latestFile: '/tmp/latest.json' }
      },
    })

    assert.equal(result.evidence.schemaVersion, 2)
    assert.deepEqual(written.enhancedMatch, readiness().enhancedMatch)
    assert.equal(answers.length, 0)
  })

  it('readiness 查询失败、旧 commit 或 pending 时均不进入录入也不写 evidence', async () => {
    for (const overrides of [
      { readReadiness: async () => { throw new Error('query failed') } },
      { readReadiness: async () => ({ ...readiness(), commitSha: 'a'.repeat(40) }) },
      { readReadiness: async () => ({ ...readiness(), datasetQualityCollectorCurrent: false }) },
    ]) {
      let asks = 0
      let writes = 0
      await assert.rejects(() => recordMetaLiveVerification({
        ...verifiedRuntimeOptions(overrides),
        ask: async () => { asks += 1; return '' },
        getCommit: async () => COMMIT,
        writeEvidence: async () => { writes += 1 },
      }))
      assert.equal(asks, 0)
      assert.equal(writes, 0)
    }
  })

  it('任一 Worker 不是当前 commit 时不读取 readiness、不录入、不写文件', async () => {
    let readinessReads = 0
    let asks = 0
    let writes = 0
    await assert.rejects(() => recordMetaLiveVerification({
      ...verifiedRuntimeOptions({
        fetch: async url => new Response(JSON.stringify({
          status: 'ok',
          environment: 'dev',
          commit: new URL(String(url)).pathname === '/__release' ? 'a'.repeat(40) : COMMIT,
        }), { status: 200 }),
        readReadiness: async () => { readinessReads += 1; return readiness() },
      }),
      ask: async () => { asks += 1; return '' },
      getCommit: async () => COMMIT,
      writeEvidence: async () => { writes += 1 },
    }), /Web 发布 commit/)
    assert.equal(readinessReads, 0)
    assert.equal(asks, 0)
    assert.equal(writes, 0)
  })
})
