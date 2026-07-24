import { recordRegistrationFactOnly } from './conversions'
import {
  AttributionRuntimeOwnerError,
  readAttributionRuntimeOwner,
  type AttributionRuntimeOwnerState,
} from './attribution-runtime-owner'

const RECOVERY_LIMIT = 100
const RECOVERY_GRACE_MS = 10 * 60 * 1_000
const RECOVERY_CURSOR_SETTING = 'registration_conversion_recovery_cursor'

type MissingRegistrationFactUser = {
  id: number
  created_at: string
}

export type RegistrationConversionRecoveryResult = {
  scanned: number
  created: number
  existing: number
  failed: number
}

export async function recoverRegistrationConversionFacts(
  db: D1Database,
  now = new Date(),
): Promise<RegistrationConversionRecoveryResult> {
  let ownership = await readAttributionRuntimeOwner(db)
  if (ownership.owner === 'new') {
    return {
      scanned: 0,
      created: 0,
      existing: 0,
      failed: 0,
    }
  }
  await reconcileOldRegistrationBusinessOutbox(db, ownership, now)
  const cursor = await readRecoveryCursor(db)
  const matureBefore = new Date(
    now.getTime() - RECOVERY_GRACE_MS,
  ).toISOString()
  const users = await db.prepare(`
    SELECT u.id, u.created_at
    FROM users u
    WHERE u.id > ?
      AND datetime(u.created_at) <= datetime(?)
      AND NOT EXISTS (
        SELECT 1
        FROM attribution_conversion_facts AS fact
        WHERE fact.canonical_event = 'CompleteRegistration'
          AND CAST(json_extract(fact.analytics_dimensions_json, '$.userId') AS INTEGER) = u.id
      )
      AND (
        ? = 'old'
        OR EXISTS (
          SELECT 1
          FROM attribution_business_outbox AS business_outbox
          WHERE CAST(json_extract(
            business_outbox.payload_json,
            '$.payload.userId'
          ) AS INTEGER) = u.id
            AND business_outbox.routing_owner = 'old'
        )
      )
    ORDER BY u.id ASC
    LIMIT 100
  `).bind(
    cursor,
    matureBefore,
    ownership.owner,
  ).all<MissingRegistrationFactUser>()

  const result: RegistrationConversionRecoveryResult = {
    scanned: users.results.length,
    created: 0,
    existing: 0,
    failed: 0,
  }

  let lastProcessedUserId = cursor
  for (const user of users.results.slice(0, RECOVERY_LIMIT)) {
    try {
      const recovered = await recordRegistrationFactOnly(db, {
        userId: user.id,
        occurredAt: user.created_at,
        visitorId: `registration_user_${user.id}`,
        sessionId: `registration_user_${user.id}`,
        sourceChannel: 'unknown',
        metadata: { method: 'email', recovery: true },
      }, ownership)
      if (recovered.created) result.created += 1
      else result.existing += 1
      lastProcessedUserId = user.id
    } catch (error) {
      if (
        error instanceof AttributionRuntimeOwnerError
        && error.code === 'ATTRIBUTION_RUNTIME_OWNER_CHANGED'
      ) {
        ownership = await readAttributionRuntimeOwner(db)
        if (ownership.owner === 'new') break
        try {
          const recovered = await recordRegistrationFactOnly(db, {
            userId: user.id,
            occurredAt: user.created_at,
            visitorId: `registration_user_${user.id}`,
            sessionId: `registration_user_${user.id}`,
            sourceChannel: 'unknown',
            metadata: { method: 'email', recovery: true },
          }, ownership)
          if (recovered.created) result.created += 1
          else result.existing += 1
          lastProcessedUserId = user.id
          continue
        } catch {
          // 交给统一失败分支，保留游标以便下次重试。
        }
      }
      result.failed += 1
      console.error('[cron.registration-recovery] 注册事实修复失败', {
        userId: user.id,
        code: 'REGISTRATION_CONVERSION_RECOVERY_FAILED',
      })
      break
    }
  }

  await writeRecoveryCursor(
    db,
    users.results.length === 0
      ? (cursor > 0 ? 0 : cursor)
      : lastProcessedUserId,
  )
  if (ownership.owner !== 'new') {
    await reconcileOldRegistrationBusinessOutbox(db, ownership, now)
  }

  return result
}

export async function reconcileOldRegistrationBusinessOutbox(
  db: D1Database,
  ownership: Pick<AttributionRuntimeOwnerState, 'owner' | 'epoch'>,
  now = new Date(),
): Promise<number> {
  if (ownership.owner !== 'old' && ownership.owner !== 'draining') {
    return 0
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error('ATTRIBUTION_REGISTRATION_RECONCILE_TIME_INVALID')
  }
  const completedAt = now.toISOString()
  const result = await db.prepare(`
    UPDATE attribution_business_outbox
    SET status = 'completed',
        claim_token = NULL,
        next_attempt_at = ?,
        updated_at = ?,
        completed_at = ?
    WHERE routing_owner = 'old'
      AND status IN ('pending', 'dispatching')
      AND EXISTS (
        SELECT 1
        FROM attribution_conversion_facts AS fact
        WHERE fact.canonical_event = 'CompleteRegistration'
          AND CAST(json_extract(
            fact.analytics_dimensions_json,
            '$.userId'
          ) AS INTEGER) = CAST(json_extract(
            attribution_business_outbox.payload_json,
            '$.payload.userId'
          ) AS INTEGER)
      )
      AND EXISTS (
        SELECT 1
        FROM attribution_runtime_cutover AS runtime
        WHERE runtime.id = 'global'
          AND runtime.owner = ?
          AND runtime.owner_epoch = ?
      )
  `).bind(
    completedAt,
    completedAt,
    completedAt,
    ownership.owner,
    ownership.epoch,
  ).run()
  return Number(result.meta.changes ?? 0)
}

async function readRecoveryCursor(db: D1Database) {
  const row = await db.prepare(`
    SELECT value FROM site_settings WHERE key = ? LIMIT 1
  `).bind(RECOVERY_CURSOR_SETTING).first<{ value: string }>()
  const value = Number(row?.value ?? 0)
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

async function writeRecoveryCursor(db: D1Database, cursor: number) {
  await db.prepare(`
    INSERT INTO site_settings (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).bind(RECOVERY_CURSOR_SETTING, String(cursor)).run()
}
