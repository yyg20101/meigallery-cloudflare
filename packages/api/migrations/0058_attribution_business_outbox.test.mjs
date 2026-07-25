import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { after, before, describe, it } from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tempDir = mkdtempSync(join(tmpdir(), 'meigallery-attribution-0058-'))
const database = join(tempDir, 'business-outbox.sqlite')
const migration = readFileSync(
  new URL('./0058_attribution_business_outbox.sql', import.meta.url),
  'utf8',
)

before(() => execute(migration))
after(() => rmSync(tempDir, { recursive: true, force: true }))

describe('0058 可信注册业务 outbox migration', () => {
  it('建立待投递与已完成索引，并包含领取和退避字段', () => {
    const columns = rows('PRAGMA table_info(attribution_business_outbox);')
      .map(column => column.name)
    assert.deepEqual(columns, [
      'id',
      'event_id',
      'dedupe_key',
      'event_name',
      'payload_json',
      'status',
      'attempt_count',
      'next_attempt_at',
      'claim_token',
      'created_at',
      'updated_at',
      'completed_at',
    ])

    const indexes = rows(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'index'
        AND tbl_name = 'attribution_business_outbox'
        AND name NOT LIKE 'sqlite_autoindex_%'
      ORDER BY name;
    `).map(index => index.name)
    assert.deepEqual(indexes, [
      'idx_attribution_business_outbox_completed',
      'idx_attribution_business_outbox_due',
    ])
  })

  it('仅接受与列一致的 CompleteRegistration V1 payload', () => {
    assert.doesNotThrow(() => insertPending({
      id: 'registration_user_1',
      eventId: 'registration_user_1',
      dedupeKey: 'registration_user_1',
      userId: 1,
    }))

    assert.throws(() => insertPending({
      id: 'contact_1',
      eventId: 'contact_1',
      dedupeKey: 'contact_1',
      userId: 2,
      eventName: 'Contact',
    }), /CHECK constraint failed/)
    assert.throws(() => insertPending({
      id: 'registration_bad_schema',
      eventId: 'registration_bad_schema',
      dedupeKey: 'registration_bad_schema',
      userId: 3,
      schemaVersion: 2,
    }), /CHECK constraint failed/)
    assert.throws(() => insertPending({
      id: 'registration_mismatch',
      eventId: 'registration_other',
      dedupeKey: 'registration_mismatch',
      userId: 4,
    }), /CHECK constraint failed/)
    assert.throws(() => execute(`
      INSERT INTO attribution_business_outbox (
        id, event_id, dedupe_key, event_name, payload_json
      ) VALUES (
        'registration_invalid_json',
        'registration_invalid_json',
        'registration_invalid_json',
        'CompleteRegistration',
        '{'
      );
    `), /CHECK constraint failed|malformed JSON/)
  })

  it('拒绝重复 eventId、dedupeKey 和负数尝试次数', () => {
    insertPending({
      id: 'registration_user_5',
      eventId: 'registration_user_5',
      dedupeKey: 'registration_user_5',
      userId: 5,
    })

    assert.throws(() => insertPending({
      id: 'registration_user_5',
      eventId: 'registration_user_5',
      dedupeKey: 'registration_duplicate_event',
      userId: 6,
    }), /UNIQUE constraint failed/)
    assert.throws(() => insertPending({
      id: 'registration_duplicate_dedupe',
      eventId: 'registration_duplicate_dedupe',
      dedupeKey: 'registration_user_5',
      userId: 7,
    }), /UNIQUE constraint failed/)
    assert.throws(() => execute(`
      UPDATE attribution_business_outbox
      SET attempt_count = -1
      WHERE id = 'registration_user_5';
    `), /CHECK constraint failed/)
  })

  it('强制 pending、dispatching、completed 状态字段保持一致', () => {
    insertPending({
      id: 'registration_user_8',
      eventId: 'registration_user_8',
      dedupeKey: 'registration_user_8',
      userId: 8,
    })

    assert.throws(() => execute(`
      UPDATE attribution_business_outbox
      SET status = 'dispatching'
      WHERE id = 'registration_user_8';
    `), /CHECK constraint failed/)

    execute(`
      UPDATE attribution_business_outbox
      SET
        status = 'dispatching',
        claim_token = 'claim_0123456789abcdef',
        attempt_count = attempt_count + 1,
        next_attempt_at = '2026-07-24T00:05:00.000Z'
      WHERE id = 'registration_user_8';
    `)

    assert.throws(() => execute(`
      UPDATE attribution_business_outbox
      SET status = 'completed', claim_token = NULL
      WHERE id = 'registration_user_8';
    `), /CHECK constraint failed/)

    execute(`
      UPDATE attribution_business_outbox
      SET
        status = 'completed',
        claim_token = NULL,
        completed_at = '2026-07-24T00:01:00.000Z'
      WHERE id = 'registration_user_8';
    `)
    assert.deepEqual(rows(`
      SELECT status, attempt_count, completed_at
      FROM attribution_business_outbox
      WHERE id = 'registration_user_8';
    `), [{
      status: 'completed',
      attempt_count: 1,
      completed_at: '2026-07-24T00:01:00.000Z',
    }])
  })
})

function insertPending({
  id,
  eventId,
  dedupeKey,
  userId,
  eventName = 'CompleteRegistration',
  schemaVersion = 1,
}) {
  const payload = JSON.stringify({
    schemaVersion,
    eventId,
    eventName,
    occurredAt: '2026-07-24T00:00:00.000Z',
    pagePath: '/register',
    dedupeKey,
    sourceContextToken: null,
    consent: {
      marketingAllowed: true,
      adUserDataAllowed: true,
      adPersonalizationAllowed: true,
    },
    payload: { userId },
  })
  execute(`
    INSERT INTO attribution_business_outbox (
      id, event_id, dedupe_key, event_name, payload_json
    ) VALUES (
      ${quote(id)},
      ${quote(eventId)},
      ${quote(dedupeKey)},
      ${quote(eventName)},
      ${quote(payload)}
    );
  `)
}

function execute(sql) {
  return execFileSync('sqlite3', [database], {
    input: sql,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

function rows(sql) {
  const output = execFileSync(
    'sqlite3',
    ['-json', database, sql],
    { encoding: 'utf8' },
  ).trim()
  return output ? JSON.parse(output) : []
}

function quote(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}
