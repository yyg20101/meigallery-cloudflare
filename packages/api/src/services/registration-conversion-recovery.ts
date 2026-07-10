import { recordRegistrationFactOnly } from './conversions'

const RECOVERY_LIMIT = 100

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
  const users = await db.prepare(`
    SELECT u.id, u.created_at
    FROM users u
    WHERE datetime(u.created_at) >= datetime(?, '-24 hours')
      AND NOT EXISTS (
        SELECT 1
        FROM analytics_conversion_actions a
        WHERE a.user_id = u.id
          AND a.action_type = 'complete_registration'
          AND a.duplicate_of = ''
      )
    ORDER BY datetime(u.created_at) ASC, u.id ASC
    LIMIT 100
  `).bind(now.toISOString()).all<MissingRegistrationFactUser>()

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

  return result
}
