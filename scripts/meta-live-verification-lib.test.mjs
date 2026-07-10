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
const VERIFIED_AT = '2026-07-10T00:00:00.000Z'
const EXPIRES_AT = '2026-07-11T00:00:00.000Z'

function createEvidence() {
  return {
    schemaVersion: 1,
    status: 'passed',
    commit: COMMIT,
    verifiedAt: VERIFIED_AT,
    expiresAt: EXPIRES_AT,
    pixelIdSuffix: '6781',
    events: ['Contact', 'Lead', 'CompleteRegistration'].map(eventName => ({
      eventName,
      browser: true,
      server: true,
      eventIdMatched: true,
      eventIdDigest: 'sha256:4f81c8a9142d',
      deduplicated: true,
    })),
    confirmedBy: 'owner',
  }
}

describe('Meta live evidence', () => {
  it('只接受当前 commit、严格 24 小时和固定三事件的完整证据', () => {
    assert.doesNotThrow(() => {
      assertMetaLiveEvidenceCanGateProduction(createEvidence(), {
        expectedCommit: COMMIT,
        now: '2026-07-10T12:00:00.000Z',
      })
    })

    assert.doesNotThrow(() => {
      assertMetaLiveEvidenceCanGateProduction({ ...createEvidence(), confirmedBy: 'owner:release-01' }, {
        expectedCommit: COMMIT,
        now: '2026-07-10T12:00:00.000Z',
      })
    })

    assert.throws(() => {
      assertMetaLiveEvidenceCanGateProduction(createEvidence(), {
        expectedCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        now: '2026-07-10T12:00:00.000Z',
      })
    }, /commit/)

    assert.throws(() => {
      assertMetaLiveEvidenceCanGateProduction(createEvidence(), {
        expectedCommit: COMMIT,
        now: EXPIRES_AT,
      })
    }, /过期/)

    assert.throws(() => {
      assertMetaLiveEvidenceCanGateProduction({
        ...createEvidence(),
        expiresAt: '2026-07-10T23:59:59.999Z',
      }, {
        expectedCommit: COMMIT,
        now: '2026-07-10T12:00:00.000Z',
      })
    }, /24 小时/)
  })

  it('拒绝缺事件、StartTrial 和任何事件验证失败', () => {
    const evidence = createEvidence()
    const invalidEvidence = [
      { ...evidence, events: evidence.events.slice(0, 2) },
      { ...evidence, events: [...evidence.events, { ...evidence.events[0], eventName: 'StartTrial' }] },
      { ...evidence, events: evidence.events.map((event, index) => index === 0 ? { ...event, browser: false } : event) },
      { ...evidence, events: evidence.events.map((event, index) => index === 0 ? { ...event, server: false } : event) },
      { ...evidence, events: evidence.events.map((event, index) => index === 0 ? { ...event, eventIdMatched: false } : event) },
      { ...evidence, events: evidence.events.map((event, index) => index === 0 ? { ...event, eventIdDigest: 'raw-event-id' } : event) },
      { ...evidence, events: evidence.events.map((event, index) => index === 0 ? { ...event, deduplicated: false } : event) },
    ]

    for (const candidate of invalidEvidence) {
      assert.throws(() => {
        assertMetaLiveEvidenceCanGateProduction(candidate, {
          expectedCommit: COMMIT,
          now: '2026-07-10T12:00:00.000Z',
        })
      })
    }
  })

  it('拒绝原始 event ID、secret、fbp、fbc 和 IP', () => {
    const sensitiveFields = [
      ['browserEventId', 'raw-browser-event-id'],
      ['serverEventId', 'raw-server-event-id'],
      ['eventId', 'raw-event-id'],
      ['accessToken', 'meta-token-value'],
      ['testEventCode', 'TEST123'],
      ['fbp', 'fb.1.1700000000000.123'],
      ['fbc', 'fb.1.1700000000000.click'],
      ['clientIpAddress', '203.0.113.7'],
    ]

    for (const [key, value] of sensitiveFields) {
      assert.throws(() => {
        assertMetaLiveEvidenceCanGateProduction({ ...createEvidence(), [key]: value }, {
          expectedCommit: COMMIT,
          now: '2026-07-10T12:00:00.000Z',
        })
      }, /敏感|字段|格式/)
    }
  })

  it('拒绝允许字段值夹带 fbp/fbc、IPv4/IPv6、token/test code 或原始 event ID', () => {
    for (const confirmedBy of [
      'owner:fb.1.1700000000000.123456789',
      'owner:203.0.113.7',
      'owner:2001:db8::1',
      'owner:test_event_code=TEST123',
      'owner:access_token=EAAB-secret',
      'owner:raw-event-id-123',
    ]) {
      assert.throws(() => {
        assertMetaLiveEvidenceCanGateProduction({ ...createEvidence(), confirmedBy }, {
          expectedCommit: COMMIT,
          now: '2026-07-10T12:00:00.000Z',
        })
      }, /confirmedBy|敏感/)
    }
  })

  it('写入时间戳文件和 latest，且文件不含敏感值', async () => {
    const reportDir = await mkdtemp(path.join(tmpdir(), 'meta-live-'))
    try {
      const files = await writeMetaLiveEvidence(createEvidence(), {
        reportDir,
        expectedCommit: COMMIT,
        now: '2026-07-10T12:00:00.000Z',
      })
      const contents = await Promise.all([
        readFile(files.evidenceFile, 'utf8'),
        readFile(files.latestFile, 'utf8'),
      ])

      assert.deepEqual(JSON.parse(contents[0]), createEvidence())
      assert.deepEqual(JSON.parse(contents[1]), createEvidence())
      assert.notEqual(path.basename(files.evidenceFile), 'latest.json')
      assert.equal(contents.join('\n').includes('raw-event-id'), false)
    } finally {
      await rm(reportDir, { recursive: true, force: true })
    }
  })
})
