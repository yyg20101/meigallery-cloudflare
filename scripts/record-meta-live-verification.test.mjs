import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { describe, it } from 'node:test'
import {
  buildProductionMetaLiveReadinessSql,
  buildMetaLiveEvidence,
  normalizeD1UtcTimestamp,
  recordMetaLiveVerification,
} from './record-meta-live-verification.mjs'

const COMMIT = '18dc11e0b0e4797683d4551a93a1f22e53dc4628'
const CONTRACT = { version: 1, digest: `sha256:${'9'.repeat(64)}` }
const DIGESTS = {
  Contact: `sha256:${'a'.repeat(64)}`,
  CompleteRegistration: `sha256:${'b'.repeat(64)}`,
}

function readiness() {
  return {
    environment: 'production',
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
    datasetQualityCollectorCurrent: false,
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
      VERIFY_PRODUCTION_API_URL: 'https://api.example.com',
      VERIFY_PRODUCTION_WEB_URL: 'https://www.example.com',
    },
    fetch: async () => new Response(JSON.stringify({ status: 'ok', environment: 'production', commit: COMMIT }), { status: 200 }),
    getCommit: async () => COMMIT,
    verifyContract: async () => CONTRACT,
    readReadiness: async () => readiness(),
    destroyChallenge: async () => {},
    recordSummary: async () => ({ status: 'passed' }),
    output: () => {},
    now: '2026-07-10T00:00:00.000Z',
    ...overrides,
  }
}

describe('Meta live evidence V2 Worker challenge 录入', () => {
  it('production live readiness 不直接读取 Dataset Quality 快照', () => {
    const sql = buildProductionMetaLiveReadinessSql(COMMIT, CONTRACT)
    assert.equal(sql.includes('meta_dataset_quality_snapshots'), false)
    assert.equal(sql.includes('analytics_conversion_deliveries'), false)
    const program = `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(':memory:');
      db.exec(${JSON.stringify(`
      CREATE TABLE meta_connection_verifications (
        environment TEXT, pixel_id TEXT, verified_commit TEXT, verified_at TEXT, invalidated_at TEXT
      );
      CREATE TABLE meta_live_challenges (
        id TEXT, environment TEXT, commit_sha TEXT, contact_event_digest TEXT,
        complete_registration_event_digest TEXT, status TEXT, events_received INTEGER,
        expires_at TEXT, consumed_at TEXT, registration_email_covered INTEGER,
        registration_external_id_covered INTEGER, contact_registration_identity_absent INTEGER
      );
      INSERT INTO meta_connection_verifications VALUES ('production', '12345678906781', '${COMMIT}', datetime('now'), NULL);
      INSERT INTO meta_live_challenges VALUES (
        'mlc_${'c'.repeat(32)}', 'production', '${COMMIT}', '${DIGESTS.Contact}', '${DIGESTS.CompleteRegistration}',
        'server_sent', 2, datetime('now', '+1 hour'), datetime('now'), 1, 1, 1
      );
      `)});
      const sql = ${JSON.stringify(sql)};
      const row = db.prepare(sql).get();
      db.close();
      console.log(JSON.stringify([row.registration_email, row.registration_external_id, row.contact_registration_identity]));
    `
    const result = execFileSync(process.execPath, [
      '--disable-warning=ExperimentalWarning',
      '--input-type=module',
      '--eval',
      program,
    ], { encoding: 'utf8' })
    assert.deepEqual(JSON.parse(result), [1, 1, 0])
  })

  it('只接受 Worker 返回的不可逆摘要，证据不含原始 ID', () => {
    const evidence = buildMetaLiveEvidence(validInput())
    assert.equal(evidence.schemaVersion, 2)
    assert.deepEqual(evidence.events.map(event => event.browserEventId), Object.values(DIGESTS))
    assert.equal(JSON.stringify(evidence).includes('mlv_'), false)
  })

  it('不再询问或生成 event ID，只逐项确认 Browser/Server/去重并在成功后销毁 challenge', async () => {
    const prompts = []
    let destroyed = 0
    const summaries = []
    const result = await recordMetaLiveVerification(runtime({
      ask: async prompt => { prompts.push(prompt); return 'yes' },
      destroyChallenge: async challengeId => {
        destroyed += 1
        assert.equal(challengeId, readiness().challengeId)
      },
      writeEvidence: async () => ({ evidenceFile: '/tmp/evidence.json', latestFile: '/tmp/latest.json' }),
      recordSummary: async options => {
        summaries.push(options)
        return { status: 'passed' }
      },
    }))
    assert.equal(result.evidence.schemaVersion, 2)
    assert.equal(result.summaryRecorded, true)
    assert.equal(prompts.some(prompt => /event ID/i.test(prompt)), false)
    assert.equal(prompts.length, 10)
    assert.equal(destroyed, 1)
    assert.equal(summaries.length, 1)
    assert.deepEqual(summaries[0].summary.events, ['Contact', 'CompleteRegistration'])
    assert.equal(summaries[0].summary.datasetQualityContractDigest, CONTRACT.digest)
  })

  it('D1 摘要写入失败时拒绝成功并仍销毁 challenge', async () => {
    let destroyed = 0
    await assert.rejects(recordMetaLiveVerification(runtime({
      ask: async () => 'yes',
      destroyChallenge: async () => { destroyed += 1 },
      writeEvidence: async () => ({ evidenceFile: '/tmp/evidence.json', latestFile: '/tmp/latest.json' }),
      recordSummary: async () => ({ status: 'failed' }),
    })), /脱敏摘要写入失败/)
    assert.equal(destroyed, 1)
  })

  it('将 D1 无时区时间按 UTC 规范化，避免本地时区偏移', () => {
    assert.equal(normalizeD1UtcTimestamp('2026-07-13 09:07:35'), '2026-07-13T09:07:35.000Z')
    assert.equal(normalizeD1UtcTimestamp('2026-07-13T09:07:35.123'), '2026-07-13T09:07:35.123Z')
    assert.equal(normalizeD1UtcTimestamp('2026-07-13T09:07:35.000Z'), '2026-07-13T09:07:35.000Z')
    assert.equal(normalizeD1UtcTimestamp('2026-99-13 09:07:35'), '2026-99-13 09:07:35')
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

  it('缺失 challenge、错误 commit 或契约不一致时不进入人工确认', async () => {
    for (const partial of [
      { challengeId: '' },
      { commitSha: 'd'.repeat(40) },
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

  it('任一 production Worker 不是当前 commit 时不读 D1 challenge', async () => {
    let reads = 0
    await assert.rejects(recordMetaLiveVerification(runtime({
      fetch: async url => new Response(JSON.stringify({
        status: 'ok',
        environment: 'production',
        commit: new URL(String(url)).pathname === '/__release' ? 'd'.repeat(40) : COMMIT,
      }), { status: 200 }),
      readReadiness: async () => { reads += 1; return readiness() },
    })), /Web 发布 commit/)
    assert.equal(reads, 0)
  })
})
