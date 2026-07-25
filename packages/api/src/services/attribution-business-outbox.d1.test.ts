import { readFileSync } from 'node:fs'
import { Miniflare } from 'miniflare'
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { isAttributionBusinessEventV1 } from '@meigallery/shared'
import {
  buildCompleteRegistrationOutboxStatement,
  claimAttributionBusinessOutbox,
  completeAttributionBusinessOutbox,
  dispatchAttributionBusinessOutbox,
  dispatchAttributionBusinessOutboxImmediately,
  failAttributionBusinessOutbox,
} from './attribution-business-outbox'
import type { AttributionServiceClient } from './attribution-service-client'

const MIGRATION = readFileSync(
  new URL('../../migrations/0058_attribution_business_outbox.sql', import.meta.url),
  'utf8',
)
const FIRST_ATTEMPT = new Date('2026-07-24T08:00:00.000Z')

let miniflare: Miniflare
let db: D1Database

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-05-26',
    d1Databases: { DB: 'attribution-business-outbox' },
  })
  db = (await miniflare.getBindings<{ DB: D1Database }>()).DB
  await db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE
    );
  `.replace(/\s*\r?\n\s*/g, ' '))
  await db.exec(MIGRATION
    .replace(/^--.*$/gm, '')
    .replace(/\s*\r?\n\s*/g, ' '))
  await db.exec(`
    CREATE TABLE attribution_runtime_cutover (
      id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      owner_epoch INTEGER NOT NULL,
      changed_by INTEGER,
      changed_at TEXT NOT NULL
    );
    INSERT INTO attribution_runtime_cutover (
      id, owner, owner_epoch, changed_by, changed_at
    ) VALUES (
      'global', 'draining', 2, 1, '2026-07-24T00:00:00.000Z'
    );
    ALTER TABLE attribution_business_outbox
      ADD COLUMN routing_owner TEXT NOT NULL DEFAULT 'old';
    ALTER TABLE attribution_business_outbox
      ADD COLUMN owner_epoch INTEGER NOT NULL DEFAULT 1;
  `.replace(/\s*\r?\n\s*/g, ' '))
})

beforeEach(async () => {
  await db.exec(cleanSql(`
    DELETE FROM attribution_business_outbox;
    DELETE FROM users;
    DELETE FROM sqlite_sequence WHERE name = 'users';
    UPDATE attribution_runtime_cutover
    SET
      owner = 'draining',
      owner_epoch = 2,
      changed_by = 1,
      changed_at = '2026-07-24T00:00:00.000Z'
    WHERE id = 'global';
  `))
})

afterAll(async () => miniflare.dispose())

describe('注册业务 outbox D1 服务', () => {
  it('在同一 batch 中使用 last_insert_rowid() 写入严格 V1 注册事件', async () => {
    const results = await db.batch([
      db.prepare('INSERT INTO users (email) VALUES (?)')
        .bind('member@example.com'),
      buildCompleteRegistrationOutboxStatement(db, statementInput()),
    ])

    expect(results[0]?.meta.last_row_id).toBe(1)
    expect(results[1]?.results).toEqual([{
      id: 'registration_user_1',
      event_id: 'registration_user_1',
    }])

    const row = await readOutbox('registration_user_1')
    const event = JSON.parse(row!.payload_json)
    expect(isAttributionBusinessEventV1(event)).toBe(true)
    expect(event).toMatchObject({
      eventId: 'registration_user_1',
      dedupeKey: 'registration_user_1',
      eventName: 'CompleteRegistration',
      sourceContextToken: 'opaque_context_token',
      consent: {
        marketingAllowed: true,
        adUserDataAllowed: true,
        adPersonalizationAllowed: false,
      },
      payload: {
        userId: 1,
        hashedEmail: 'a'.repeat(64),
      },
    })
    expect(row).toMatchObject({
      status: 'pending',
      attempt_count: 0,
      completed_at: null,
      routing_owner: 'draining',
      owner_epoch: 2,
    })
  })

  it('old owner 的注册事件保留在业务 D1 且不会投递到新运行时', async () => {
    await setRuntimeOwner('old', 1)
    await seedRegistration()
    await makeDue('registration_user_1', FIRST_ATTEMPT)
    const ingest = vi.fn()

    await expect(dispatchAttributionBusinessOutbox(
      db,
      serviceClient(ingest),
      { now: FIRST_ATTEMPT },
    )).resolves.toEqual({ claimed: 0, accepted: 0, failed: 0 })
    expect(ingest).not.toHaveBeenCalled()
    expect(await readOutbox('registration_user_1')).toMatchObject({
      routing_owner: 'old',
      owner_epoch: 1,
      status: 'pending',
    })
  })

  it('old owner 由旧本地写者消费同一业务 outbox 并完成', async () => {
    await setRuntimeOwner('old', 1)
    await seedRegistration()
    await makeDue('registration_user_1', FIRST_ATTEMPT)
    const ingest = vi.fn()
    const dispatchLegacy = vi.fn(async () => {})

    const result = await dispatchAttributionBusinessOutboxImmediately(
      db,
      serviceClient(ingest),
      'registration_user_1',
      {
        now: FIRST_ATTEMPT,
        dispatchLegacy,
      },
    )

    expect(result).toMatchObject({
      accepted: true,
      eventId: 'registration_user_1',
      instructionToken: null,
    })
    expect(dispatchLegacy).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 'registration_user_1',
        eventName: 'CompleteRegistration',
      }),
      { owner: 'old', epoch: 1 },
    )
    expect(ingest).not.toHaveBeenCalled()
    expect(await readOutbox('registration_user_1')).toMatchObject({
      status: 'completed',
      routing_owner: 'old',
      owner_epoch: 1,
    })
  })

  it('切换后的新 owner 不会消费旧 epoch 遗留事件', async () => {
    await seedRegistration()
    await makeDue('registration_user_1', FIRST_ATTEMPT)
    await setRuntimeOwner('new', 3)
    const ingest = vi.fn()

    await expect(dispatchAttributionBusinessOutbox(
      db,
      serviceClient(ingest),
      { now: FIRST_ATTEMPT },
    )).resolves.toEqual({ claimed: 0, accepted: 0, failed: 0 })
    expect(ingest).not.toHaveBeenCalled()
    expect(await readOutbox('registration_user_1')).toMatchObject({
      status: 'pending',
      routing_owner: 'draining',
      owner_epoch: 2,
    })
  })

  it('用户插入失败时同一 batch 不产生注册 outbox', async () => {
    await db.prepare('INSERT INTO users (email) VALUES (?)')
      .bind('duplicate@example.com')
      .run()

    await expect(db.batch([
      db.prepare('INSERT INTO users (email) VALUES (?)')
        .bind('duplicate@example.com'),
      buildCompleteRegistrationOutboxStatement(db, statementInput()),
    ])).rejects.toThrow()

    expect(await countOutbox()).toBe(0)
  })

  it('statement builder 在进入 D1 前拒绝不严格的事件输入', () => {
    expect(() => buildCompleteRegistrationOutboxStatement(db, {
      ...statementInput(),
      pagePath: 'https://example.com/register',
    })).toThrow('ATTRIBUTION_BUSINESS_OUTBOX_INPUT_INVALID')
    expect(() => buildCompleteRegistrationOutboxStatement(db, {
      ...statementInput(),
      hashedEmail: 'raw@example.com',
    })).toThrow('ATTRIBUTION_BUSINESS_OUTBOX_INPUT_INVALID')
  })

  it('原子领取、完成并拒绝旧 claim 重复修改', async () => {
    await seedRegistration()
    await makeDue('registration_user_1', FIRST_ATTEMPT)

    const [claim] = await claimAttributionBusinessOutbox(db, {
      now: FIRST_ATTEMPT,
      limit: 1,
    })
    expect(claim).toMatchObject({
      id: 'registration_user_1',
      eventId: 'registration_user_1',
      attemptCount: 1,
      routingOwner: 'draining',
      ownerEpoch: 2,
    })
    expect(claim?.claimToken).toMatch(/^[0-9a-f]{32}$/)

    expect(await completeAttributionBusinessOutbox(
      db,
      claim!,
      new Date('2026-07-24T08:00:01.000Z'),
    )).toBe(true)
    expect(await completeAttributionBusinessOutbox(
      db,
      claim!,
      new Date('2026-07-24T08:00:02.000Z'),
    )).toBe(false)
    expect(await claimAttributionBusinessOutbox(db, {
      now: new Date('2026-07-25T08:00:00.000Z'),
    })).toEqual([])
    expect(await readOutbox('registration_user_1')).toMatchObject({
      status: 'completed',
      attempt_count: 1,
      claim_token: null,
      completed_at: '2026-07-24T08:00:01.000Z',
    })
  })

  it('失败按 30、60 秒指数退避，并可安全回收过期 dispatch lease', async () => {
    await seedRegistration()
    await makeDue('registration_user_1', FIRST_ATTEMPT)

    const [first] = await claimAttributionBusinessOutbox(db, {
      now: FIRST_ATTEMPT,
    })
    const firstFailure = await failAttributionBusinessOutbox(
      db,
      first!,
      FIRST_ATTEMPT,
    )
    expect(firstFailure).toEqual({
      updated: true,
      nextAttemptAt: '2026-07-24T08:00:30.000Z',
    })
    expect(await claimAttributionBusinessOutbox(db, {
      now: new Date('2026-07-24T08:00:29.999Z'),
    })).toEqual([])

    const [second] = await claimAttributionBusinessOutbox(db, {
      now: new Date('2026-07-24T08:00:30.000Z'),
    })
    expect(second?.attemptCount).toBe(2)
    expect(await completeAttributionBusinessOutbox(
      db,
      first!,
      new Date('2026-07-24T08:00:31.000Z'),
    )).toBe(false)

    const secondFailure = await failAttributionBusinessOutbox(
      db,
      second!,
      new Date('2026-07-24T08:00:30.000Z'),
    )
    expect(secondFailure.nextAttemptAt).toBe('2026-07-24T08:01:30.000Z')

    const [leased] = await claimAttributionBusinessOutbox(db, {
      now: new Date('2026-07-24T08:01:30.000Z'),
    })
    expect(leased?.attemptCount).toBe(3)
    const [recovered] = await claimAttributionBusinessOutbox(db, {
      now: new Date('2026-07-24T08:06:30.000Z'),
    })
    expect(recovered?.attemptCount).toBe(4)
    expect(recovered?.claimToken).not.toBe(leased?.claimToken)
  })

  it('批量 dispatch 失败后以同一 eventId 幂等重试并最终完成', async () => {
    await seedRegistration()
    await makeDue('registration_user_1', FIRST_ATTEMPT)
    const ingest = vi.fn()
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValueOnce({
        accepted: true,
        eventId: 'registration_user_1',
      })
    const client = serviceClient(ingest)

    await expect(dispatchAttributionBusinessOutbox(db, client, {
      now: FIRST_ATTEMPT,
    })).resolves.toEqual({ claimed: 1, accepted: 0, failed: 1 })
    await expect(dispatchAttributionBusinessOutbox(db, client, {
      now: new Date('2026-07-24T08:00:30.000Z'),
    })).resolves.toEqual({ claimed: 1, accepted: 1, failed: 0 })

    expect(ingest).toHaveBeenCalledTimes(2)
    expect(ingest.mock.calls.map(call => call[0].eventId)).toEqual([
      'registration_user_1',
      'registration_user_1',
    ])
    expect(await readOutbox('registration_user_1')).toMatchObject({
      status: 'completed',
      attempt_count: 2,
    })
  })

  it('即时 dispatch 在 ingest 后返回 instructionToken，重复调用不重复 ingest', async () => {
    await seedRegistration()
    await makeDue('registration_user_1', FIRST_ATTEMPT)
    const ingest = vi.fn(async event => ({
      accepted: true as const,
      eventId: event.eventId,
    }))
    const instruction = vi.fn(async () => ({
      instructionToken: 'instruction_token_0123456789',
    }))
    const client = serviceClient(ingest)
    client.getSignedBrowserInstruction = instruction

    const first = await dispatchAttributionBusinessOutboxImmediately(
      db,
      client,
      'registration_user_1',
      { now: FIRST_ATTEMPT },
    )
    const duplicate = await dispatchAttributionBusinessOutboxImmediately(
      db,
      client,
      'registration_user_1',
      { now: new Date('2026-07-24T08:00:01.000Z') },
    )

    expect(first).toEqual({
      outboxId: 'registration_user_1',
      eventId: 'registration_user_1',
      accepted: true,
      instructionToken: 'instruction_token_0123456789',
    })
    expect(duplicate).toEqual(first)
    expect(ingest).toHaveBeenCalledTimes(1)
    expect(instruction).toHaveBeenCalledTimes(2)
  })
})

function statementInput() {
  return {
    occurredAt: '2026-07-24T07:59:00.000Z',
    pagePath: '/register?source=campaign',
    sourceContextToken: 'opaque_context_token',
    consent: {
      marketingAllowed: true,
      adUserDataAllowed: true,
      adPersonalizationAllowed: false,
    },
    hashedEmail: 'a'.repeat(64),
  }
}

async function seedRegistration() {
  await db.batch([
    db.prepare('INSERT INTO users (email) VALUES (?)')
      .bind('member@example.com'),
    buildCompleteRegistrationOutboxStatement(db, statementInput()),
  ])
}

async function makeDue(id: string, now: Date) {
  await db.prepare(`
    UPDATE attribution_business_outbox
    SET next_attempt_at = ?, updated_at = ?
    WHERE id = ?
  `).bind(now.toISOString(), now.toISOString(), id).run()
}

async function readOutbox(id: string) {
  return db.prepare(`
    SELECT *
    FROM attribution_business_outbox
    WHERE id = ?
  `).bind(id).first<{
    id: string
    payload_json: string
    status: string
    attempt_count: number
    claim_token: string | null
    completed_at: string | null
    routing_owner: string
    owner_epoch: number
  }>()
}

async function countOutbox() {
  const row = await db.prepare(`
    SELECT count(*) AS count
    FROM attribution_business_outbox
  `).first<{ count: number }>()
  return row?.count ?? 0
}

function serviceClient(
  ingestRegistrationEvent: AttributionServiceClient['ingestRegistrationEvent'],
): AttributionServiceClient {
  return {
    async readRuntimeState() {
      return {
        mode: 'bridge',
        activatedAt: null,
        bridgeOwnerEpoch: 2,
        activeOwnerEpoch: null,
        fencedOwnerEpoch: null,
        updatedAt: '2026-07-24T00:00:00.000Z',
        migrationReconciled: true,
        inFlightServerDeliveries: 0,
      }
    },
    async transitionRuntimeState() {
      throw new Error('not implemented')
    },
    async resolvePrivacyDecision() {
      return { state: 'denied', reason: 'explicit' }
    },
    ingestRegistrationEvent,
    async ingestContactEvent() {
      throw new Error('not implemented')
    },
    async translateLegacyContext() {
      throw new Error('not implemented')
    },
    async getSignedBrowserInstruction() {
      return { instructionToken: 'instruction_token_0123456789' }
    },
    async getSignedContactCapabilities() {
      return []
    },
  }
}

async function setRuntimeOwner(
  owner: 'old' | 'draining' | 'new',
  epoch: number,
) {
  await db.prepare(`
    UPDATE attribution_runtime_cutover
    SET owner = ?, owner_epoch = ?, changed_at = ?
    WHERE id = 'global'
  `).bind(owner, epoch, FIRST_ATTEMPT.toISOString()).run()
}

function cleanSql(value: string) {
  return value.replace(/\s*\r?\n\s*/gu, ' ').trim()
}
