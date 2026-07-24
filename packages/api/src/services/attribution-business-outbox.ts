import {
  isAttributionBusinessEventV1,
  type AttributionBusinessEventV1,
} from '@meigallery/shared'
import type { AttributionServiceClient } from './attribution-service-client'
import {
  assertAttributionRuntimeOwner,
  isAttributionForwardingOwner,
  readAttributionRuntimeOwner,
} from './attribution-runtime-owner'

const DEFAULT_DISPATCH_LIMIT = 25
const MAX_DISPATCH_LIMIT = 100
const CLAIM_LEASE_SECONDS = 5 * 60
const RETRY_BASE_SECONDS = 30
const RETRY_MAX_SECONDS = 60 * 60

export interface RegistrationBusinessOutboxStatementInput {
  occurredAt: string
  pagePath: string
  sourceContextToken: string | null
  consent: AttributionBusinessEventV1['consent']
  hashedEmail?: string
}

export interface AttributionBusinessOutboxClaim {
  id: string
  eventId: string
  event: AttributionBusinessEventV1
  attemptCount: number
  claimToken: string
  routingOwner: 'old' | 'draining' | 'new'
  ownerEpoch: number
}

export interface AttributionBusinessOutboxDispatchResult {
  claimed: number
  accepted: number
  failed: number
}

export interface AttributionBusinessOutboxImmediateResult {
  outboxId: string
  eventId: string
  accepted: boolean
  instructionToken: string | null
}

export type AttributionLegacyRegistrationDispatcher = (
  event: AttributionBusinessEventV1,
  ownership: {
    owner: 'old'
    epoch: number
  },
) => Promise<void>

type AttributionBusinessOutboxRow = {
  id: string
  event_id: string
  event_name: string
  payload_json: string
  attempt_count: number
  claim_token: string
  routing_owner: string
  owner_epoch: number
}

/**
 * 必须紧跟 users INSERT 放入同一个 D1.batch()。
 * SQLite 会在同一事务连接中用 last_insert_rowid() 构造不可伪造的 userId。
 */
export function buildCompleteRegistrationOutboxStatement(
  db: D1Database,
  input: RegistrationBusinessOutboxStatementInput,
): D1PreparedStatement {
  assertRegistrationStatementInput(input)

  const hashedEmailEntry = input.hashedEmail === undefined
    ? ''
    : `, 'hashedEmail', ?`
  const payloadArguments = input.hashedEmail === undefined
    ? []
    : [input.hashedEmail]
  const marketingAllowed = jsonBoolean(input.consent.marketingAllowed)
  const adUserDataAllowed = jsonBoolean(input.consent.adUserDataAllowed)
  const adPersonalizationAllowed = jsonBoolean(
    input.consent.adPersonalizationAllowed,
  )

  return db.prepare(`
    INSERT INTO attribution_business_outbox (
      id,
      event_id,
      dedupe_key,
      event_name,
      payload_json,
      routing_owner,
      owner_epoch
    )
    SELECT
      'registration_user_' || CAST(last_insert_rowid() AS TEXT),
      'registration_user_' || CAST(last_insert_rowid() AS TEXT),
      'registration_user_' || CAST(last_insert_rowid() AS TEXT),
      'CompleteRegistration',
      json_object(
        'schemaVersion', 1,
        'eventId', 'registration_user_' || CAST(last_insert_rowid() AS TEXT),
        'eventName', 'CompleteRegistration',
        'occurredAt', ?,
        'pagePath', ?,
        'dedupeKey', 'registration_user_' || CAST(last_insert_rowid() AS TEXT),
        'sourceContextToken', ?,
        'consent', json_object(
          'marketingAllowed', ${marketingAllowed},
          'adUserDataAllowed', ${adUserDataAllowed},
          'adPersonalizationAllowed', ${adPersonalizationAllowed}
        ),
        'payload', json_object(
          'userId', last_insert_rowid()
          ${hashedEmailEntry}
        )
      ),
      runtime.owner,
      runtime.owner_epoch
    FROM attribution_runtime_cutover AS runtime
    WHERE runtime.id = 'global'
      AND last_insert_rowid() > 0
    ON CONFLICT(id) DO NOTHING
    RETURNING id, event_id
  `).bind(
    input.occurredAt,
    input.pagePath,
    input.sourceContextToken,
    ...payloadArguments,
  )
}

export async function claimAttributionBusinessOutbox(
  db: D1Database,
  options: {
    limit?: number
    now?: Date
    outboxId?: string
  } = {},
): Promise<AttributionBusinessOutboxClaim[]> {
  const limit = normalizeLimit(options.limit)
  const now = validDate(options.now ?? new Date())
  const nowIso = now.toISOString()
  const leaseUntil = new Date(
    now.getTime() + CLAIM_LEASE_SECONDS * 1_000,
  ).toISOString()
  const outboxFilter = options.outboxId === undefined
    ? ''
    : 'AND id = ?'
  const filterArguments = options.outboxId === undefined
    ? []
    : [normalizeOutboxId(options.outboxId)]

  const result = await db.prepare(`
    UPDATE attribution_business_outbox
    SET
      status = 'dispatching',
      attempt_count = attempt_count + 1,
      claim_token = lower(hex(randomblob(16))),
      next_attempt_at = ?,
      updated_at = ?
    WHERE id IN (
      SELECT id
      FROM attribution_business_outbox
      WHERE status IN ('pending', 'dispatching')
        AND EXISTS (
          SELECT 1
          FROM attribution_runtime_cutover AS runtime
          WHERE runtime.id = 'global'
            AND runtime.owner = attribution_business_outbox.routing_owner
            AND runtime.owner_epoch =
              attribution_business_outbox.owner_epoch
        )
        AND julianday(next_attempt_at) <= julianday(?)
        ${outboxFilter}
      ORDER BY next_attempt_at ASC, created_at ASC, id ASC
      LIMIT ?
    )
    RETURNING
      id,
      event_id,
      event_name,
      payload_json,
      attempt_count,
      claim_token,
      routing_owner,
      owner_epoch
  `).bind(
    leaseUntil,
    nowIso,
    nowIso,
    ...filterArguments,
    limit,
  ).all<AttributionBusinessOutboxRow>()

  return result.results.map(parseClaim)
}

export async function completeAttributionBusinessOutbox(
  db: D1Database,
  claim: AttributionBusinessOutboxClaim,
  now = new Date(),
): Promise<boolean> {
  const completedAt = validDate(now).toISOString()
  const result = await db.prepare(`
    UPDATE attribution_business_outbox
    SET
      status = 'completed',
      claim_token = NULL,
      next_attempt_at = ?,
      updated_at = ?,
      completed_at = ?
    WHERE id = ?
      AND status = 'dispatching'
      AND claim_token = ?
      AND attempt_count = ?
  `).bind(
    completedAt,
    completedAt,
    completedAt,
    claim.id,
    claim.claimToken,
    claim.attemptCount,
  ).run()
  return result.meta.changes === 1
}

export async function failAttributionBusinessOutbox(
  db: D1Database,
  claim: AttributionBusinessOutboxClaim,
  now = new Date(),
): Promise<{ updated: boolean; nextAttemptAt: string }> {
  const failedAt = validDate(now)
  const retryDelaySeconds = retryDelay(claim.attemptCount)
  const nextAttemptAt = new Date(
    failedAt.getTime() + retryDelaySeconds * 1_000,
  ).toISOString()
  const result = await db.prepare(`
    UPDATE attribution_business_outbox
    SET
      status = 'pending',
      claim_token = NULL,
      next_attempt_at = ?,
      updated_at = ?,
      completed_at = NULL
    WHERE id = ?
      AND status = 'dispatching'
      AND claim_token = ?
      AND attempt_count = ?
  `).bind(
    nextAttemptAt,
    failedAt.toISOString(),
    claim.id,
    claim.claimToken,
    claim.attemptCount,
  ).run()
  return {
    updated: result.meta.changes === 1,
    nextAttemptAt,
  }
}

export async function dispatchAttributionBusinessOutbox(
  db: D1Database,
  client: AttributionServiceClient,
  options: { limit?: number; now?: Date } = {},
): Promise<AttributionBusinessOutboxDispatchResult> {
  const ownership = await readAttributionRuntimeOwner(db)
  if (!isAttributionForwardingOwner(ownership)) {
    return { claimed: 0, accepted: 0, failed: 0 }
  }
  const claims = await claimAttributionBusinessOutbox(db, options)
  const result: AttributionBusinessOutboxDispatchResult = {
    claimed: claims.length,
    accepted: 0,
    failed: 0,
  }

  for (const claim of claims) {
    try {
      await assertAttributionRuntimeOwner(db, {
        owner: claim.routingOwner,
        epoch: claim.ownerEpoch,
      })
      if (
        claim.routingOwner !== 'draining'
        && claim.routingOwner !== 'new'
      ) {
        throw new Error('ATTRIBUTION_BUSINESS_OUTBOX_OWNER_INVALID')
      }
      await client.ingestRegistrationEvent(claim.event, {
        owner: claim.routingOwner,
        epoch: claim.ownerEpoch,
      })
      const completed = await completeAttributionBusinessOutbox(
        db,
        claim,
        options.now,
      )
      if (!completed) {
        result.failed += 1
        continue
      }
      result.accepted += 1
    }
    catch {
      await failAttributionBusinessOutbox(db, claim, options.now)
      result.failed += 1
    }
  }
  return result
}

export async function dispatchAttributionBusinessOutboxImmediately(
  db: D1Database,
  client: AttributionServiceClient,
  outboxId: string,
  options: {
    now?: Date
    dispatchLegacy?: AttributionLegacyRegistrationDispatcher
  } = {},
): Promise<AttributionBusinessOutboxImmediateResult> {
  const normalizedId = normalizeOutboxId(outboxId)
  const ownership = await readAttributionRuntimeOwner(db)
  if (ownership.owner === 'old' && !options.dispatchLegacy) {
    return {
      outboxId: normalizedId,
      eventId: normalizedId,
      accepted: false,
      instructionToken: null,
    }
  }
  const claims = await claimAttributionBusinessOutbox(db, {
    limit: 1,
    now: options.now,
    outboxId: normalizedId,
  })
  const claim = claims[0]
  if (!claim) {
    const completed = await readCompletedEventId(db, normalizedId)
    if (!completed) {
      return {
        outboxId: normalizedId,
        eventId: normalizedId,
        accepted: false,
        instructionToken: null,
      }
    }
    return {
      outboxId: normalizedId,
      eventId: completed,
      accepted: true,
      instructionToken: isAttributionForwardingOwner(ownership)
        ? await readInstructionToken(
            client,
            completed,
            ownership,
          )
        : null,
    }
  }

  try {
    await assertAttributionRuntimeOwner(db, {
      owner: claim.routingOwner,
      epoch: claim.ownerEpoch,
    })
    if (claim.routingOwner === 'old') {
      await options.dispatchLegacy?.(claim.event, {
        owner: 'old',
        epoch: claim.ownerEpoch,
      })
      if (!options.dispatchLegacy) {
        throw new Error('ATTRIBUTION_LEGACY_DISPATCH_UNAVAILABLE')
      }
    } else {
      await client.ingestRegistrationEvent(claim.event, {
        owner: claim.routingOwner,
        epoch: claim.ownerEpoch,
      })
    }
    const completed = await completeAttributionBusinessOutbox(
      db,
      claim,
      options.now,
    )
    if (!completed) {
      return {
        outboxId: claim.id,
        eventId: claim.eventId,
        accepted: false,
        instructionToken: null,
      }
    }
    return {
      outboxId: claim.id,
      eventId: claim.eventId,
      accepted: true,
      instructionToken: isAttributionForwardingOwner(ownership)
        ? await readInstructionToken(
            client,
            claim.eventId,
            ownership,
          )
        : null,
    }
  }
  catch {
    await failAttributionBusinessOutbox(db, claim, options.now)
    return {
      outboxId: claim.id,
      eventId: claim.eventId,
      accepted: false,
      instructionToken: null,
    }
  }
}

function assertRegistrationStatementInput(
  input: RegistrationBusinessOutboxStatementInput,
) {
  const candidate: AttributionBusinessEventV1 = {
    schemaVersion: 1,
    eventId: 'registration_user_1',
    eventName: 'CompleteRegistration',
    occurredAt: input.occurredAt,
    pagePath: input.pagePath,
    dedupeKey: 'registration_user_1',
    sourceContextToken: input.sourceContextToken,
    consent: input.consent,
    payload: input.hashedEmail === undefined
      ? { userId: 1 }
      : { userId: 1, hashedEmail: input.hashedEmail },
  }
  if (!isAttributionBusinessEventV1(candidate)) {
    throw new Error('ATTRIBUTION_BUSINESS_OUTBOX_INPUT_INVALID')
  }
}

function parseClaim(
  row: AttributionBusinessOutboxRow,
): AttributionBusinessOutboxClaim {
  let event: unknown
  try {
    event = JSON.parse(row.payload_json)
  }
  catch {
    throw new Error('ATTRIBUTION_BUSINESS_OUTBOX_PAYLOAD_INVALID')
  }
  if (
    !isAttributionBusinessEventV1(event)
    || event.eventName !== 'CompleteRegistration'
    || event.eventId !== row.event_id
    || row.event_name !== 'CompleteRegistration'
    || !Number.isSafeInteger(row.attempt_count)
    || row.attempt_count < 1
    || !/^[0-9a-f]{32}$/.test(row.claim_token)
    || (
      row.routing_owner !== 'old'
      && row.routing_owner !== 'draining'
      && row.routing_owner !== 'new'
    )
    || !Number.isSafeInteger(row.owner_epoch)
    || row.owner_epoch < 1
  ) {
    throw new Error('ATTRIBUTION_BUSINESS_OUTBOX_PAYLOAD_INVALID')
  }
  return {
    id: row.id,
    eventId: row.event_id,
    event,
    attemptCount: row.attempt_count,
    claimToken: row.claim_token,
    routingOwner: row.routing_owner,
    ownerEpoch: row.owner_epoch,
  }
}

async function readCompletedEventId(
  db: D1Database,
  outboxId: string,
): Promise<string | null> {
  const row = await db.prepare(`
    SELECT event_id
    FROM attribution_business_outbox
    WHERE id = ? AND status = 'completed'
    LIMIT 1
  `).bind(outboxId).first<{ event_id: string }>()
  return row?.event_id ?? null
}

async function readInstructionToken(
  client: AttributionServiceClient,
  eventId: string,
  ownership: {
    owner: 'draining' | 'new'
    epoch: number
  },
): Promise<string | null> {
  try {
    const result = await client.getSignedBrowserInstruction(
      { eventId },
      ownership,
    )
    return result.instructionToken
  }
  catch {
    return null
  }
}

function normalizeLimit(value = DEFAULT_DISPATCH_LIMIT) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_DISPATCH_LIMIT) {
    throw new Error('ATTRIBUTION_BUSINESS_OUTBOX_LIMIT_INVALID')
  }
  return value
}

function normalizeOutboxId(value: string) {
  if (!/^[A-Za-z0-9:_-]{1,160}$/.test(value)) {
    throw new Error('ATTRIBUTION_BUSINESS_OUTBOX_ID_INVALID')
  }
  return value
}

function validDate(value: Date) {
  if (!Number.isFinite(value.getTime())) {
    throw new Error('ATTRIBUTION_BUSINESS_OUTBOX_TIME_INVALID')
  }
  return value
}

function retryDelay(attemptCount: number) {
  if (!Number.isSafeInteger(attemptCount) || attemptCount < 1) {
    throw new Error('ATTRIBUTION_BUSINESS_OUTBOX_ATTEMPT_INVALID')
  }
  return Math.min(
    RETRY_MAX_SECONDS,
    RETRY_BASE_SECONDS * 2 ** Math.min(attemptCount - 1, 16),
  )
}

function jsonBoolean(value: boolean) {
  return value ? "json('true')" : "json('false')"
}
