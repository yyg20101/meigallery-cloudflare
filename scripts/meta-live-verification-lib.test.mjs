import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import {
  assertMetaLiveEvidenceCanGateProduction,
  writeMetaLiveEvidence,
} from './meta-live-verification-lib.mjs'

const COMMIT = '18dc11e0b0e4797683d4551a93a1f22e53dc4628'
const CAPTURED_AT = '2026-07-10T00:00:00.000Z'
const EXPIRES_AT = '2026-07-11T00:00:00.000Z'
const EVENT_IDS = {
  Contact: `sha256:${'1'.repeat(64)}`,
  CompleteRegistration: `sha256:${'2'.repeat(64)}`,
}

function createEvidence() {
  return {
    schemaVersion: 2,
    commitSha: COMMIT,
    environment: 'dev',
    pixelIdMasked: '1234****6781',
    connectionVerifiedAt: '2026-07-09T23:55:00.000Z',
    capturedAt: CAPTURED_AT,
    expiresAt: EXPIRES_AT,
    events: ['Contact', 'CompleteRegistration'].map(eventName => ({
      eventName,
      browserEventId: EVENT_IDS[eventName],
      serverEventId: EVENT_IDS[eventName],
      browserSeen: true,
      serverSeen: true,
      deduplicated: true,
      eventsReceived: 1,
    })),
    enhancedMatch: {
      completeRegistrationEmail: true,
      completeRegistrationExternalId: true,
      contactContainsRegistrationIdentity: false,
    },
    forbiddenEventsAbsent: {
      Lead: true,
      StartTrial: true,
    },
    datasetQualityContractVersion: 1,
    datasetQualityCollectorCurrent: true,
  }
}

function assertValid(evidence = createEvidence(), overrides = {}) {
  return assertMetaLiveEvidenceCanGateProduction(evidence, {
    expectedCommit: COMMIT,
    expectedEnvironment: 'dev',
    now: '2026-07-10T12:00:00.000Z',
    ...overrides,
  })
}

describe('Meta live evidence V2', () => {
  it('只接受当前 40-char commit、匹配环境和严格 24 小时的 V2', () => {
    assert.doesNotThrow(() => assertValid())
    assert.throws(() => assertValid({ ...createEvidence(), schemaVersion: 1 }), /schemaVersion|V2|过期/)
    assert.throws(() => assertValid({ ...createEvidence(), commitSha: 'a'.repeat(40) }), /commit/)
    assert.throws(() => assertValid(createEvidence(), { expectedEnvironment: 'production' }), /环境|environment/)
    assert.throws(() => assertValid(createEvidence(), { now: EXPIRES_AT }), /过期/)
    assert.throws(() => assertValid({ ...createEvidence(), expiresAt: '2026-07-10T23:59:59.999Z' }), /24 小时/)
    assert.throws(() => assertValid({ ...createEvidence(), connectionVerifiedAt: '2026-07-10T00:01:00.000Z' }), /connectionVerifiedAt/)
  })

  it('要求恰好两个事件及 Browser/Server 同 ID、seen、deduplicated、eventsReceived=1', () => {
    const evidence = createEvidence()
    const invalid = [
      { ...evidence, events: evidence.events.slice(0, 1) },
      { ...evidence, events: [...evidence.events, { ...evidence.events[0], eventName: 'Lead' }] },
      { ...evidence, events: [...evidence.events, { ...evidence.events[0], eventName: 'StartTrial' }] },
      { ...evidence, events: [...evidence.events, { ...evidence.events[0], eventName: 'Purchase' }] },
      { ...evidence, events: evidence.events.map((event, index) => index ? event : { ...event, browserSeen: false }) },
      { ...evidence, events: evidence.events.map((event, index) => index ? event : { ...event, serverSeen: false }) },
      { ...evidence, events: evidence.events.map((event, index) => index ? event : { ...event, serverEventId: `sha256:${'3'.repeat(64)}` }) },
      { ...evidence, events: evidence.events.map((event, index) => index ? event : { ...event, deduplicated: false }) },
      { ...evidence, events: evidence.events.map((event, index) => index ? event : { ...event, eventsReceived: 0 }) },
      { ...evidence, events: evidence.events.map((event, index) => index ? event : { ...event, browserEventId: 'raw-user-event-id', serverEventId: 'raw-user-event-id' }) },
    ]

    for (const candidate of invalid) assert.throws(() => assertValid(candidate))
  })

  it('增强匹配、禁止事件和 Dataset Quality 均为硬门禁', () => {
    const evidence = createEvidence()
    for (const candidate of [
      { ...evidence, enhancedMatch: { ...evidence.enhancedMatch, completeRegistrationEmail: false } },
      { ...evidence, enhancedMatch: { ...evidence.enhancedMatch, completeRegistrationExternalId: false } },
      { ...evidence, enhancedMatch: { ...evidence.enhancedMatch, contactContainsRegistrationIdentity: true } },
      { ...evidence, forbiddenEventsAbsent: { ...evidence.forbiddenEventsAbsent, Lead: false } },
      { ...evidence, forbiddenEventsAbsent: { ...evidence.forbiddenEventsAbsent, StartTrial: false } },
      { ...evidence, datasetQualityContractVersion: 0 },
      { ...evidence, datasetQualityCollectorCurrent: false },
    ]) assert.throws(() => assertValid(candidate))
  })

  it('拒绝未知字段和用户级敏感内容', () => {
    for (const [key, value] of [
      ['accessToken', 'meta-token-value'],
      ['testEventCode', 'TEST123'],
      ['fbp', 'fb.1.1700000000000.123'],
      ['fbc', 'fb.1.1700000000000.click'],
      ['clientIpAddress', '203.0.113.7'],
      ['confirmedBy', 'owner'],
    ]) assert.throws(() => assertValid({ ...createEvidence(), [key]: value }), /敏感|字段/)
  })

  it('写入时间戳文件和 latest，文件只含 V2 脱敏证据', async () => {
    const reportDir = await mkdtemp(path.join(tmpdir(), 'meta-live-v2-'))
    try {
      const evidence = createEvidence()
      const files = await writeMetaLiveEvidence(evidence, {
        reportDir,
        expectedCommit: COMMIT,
        expectedEnvironment: 'dev',
        now: '2026-07-10T12:00:00.000Z',
      })
      const contents = await Promise.all([readFile(files.evidenceFile, 'utf8'), readFile(files.latestFile, 'utf8')])
      assert.deepEqual(JSON.parse(contents[0]), evidence)
      assert.deepEqual(JSON.parse(contents[1]), evidence)
      assert.notEqual(path.basename(files.evidenceFile), 'latest.json')
      assert.doesNotMatch(contents.join('\n'), /raw-user-event-id|access_token|test_event_code/i)
    } finally {
      await rm(reportDir, { recursive: true, force: true })
    }
  })
})
