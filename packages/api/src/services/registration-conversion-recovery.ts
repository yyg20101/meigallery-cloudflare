import { recordRegistrationFactOnly } from './conversions'

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
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error('REGISTRATION_CONVERSION_RECOVERY_TIME_INVALID')
  }
  const cursor = await readRecoveryCursor(db)
  const matureBefore = new Date(now.getTime() - RECOVERY_GRACE_MS).toISOString()
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
    ORDER BY u.id ASC
    LIMIT 100
  `).bind(cursor, matureBefore).all<MissingRegistrationFactUser>()

  const result: RegistrationConversionRecoveryResult = {
    scanned: users.results.length,
    created: 0,
    existing: 0,
    failed: 0,
  }

  for (const user of users.results.slice(0, RECOVERY_LIMIT)) {
    try {
      const recovered = await recordRegistrationFactOnly(db, {
        userId: user.id,
        occurredAt: user.created_at,
        visitorId: `registration_user_${user.id}`,
        sessionId: `registration_user_${user.id}`,
        sourceChannel: 'unknown',
        metadata: { method: 'email', recovery: true },
      })
      if (recovered.created) result.created += 1
      else result.existing += 1
    } catch {
      result.failed += 1
      console.error('[cron.registration-recovery] 注册事实修复失败', {
        userId: user.id,
        code: 'REGISTRATION_CONVERSION_RECOVERY_FAILED',
      })
    }
  }

  const lastUser = users.results.at(-1)
  await writeRecoveryCursor(db, lastUser?.id ?? (cursor > 0 ? 0 : cursor))

  return result
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
