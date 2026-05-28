import { generateId } from '../utils/db'

export const VERIFICATION_CODE_TTL_MS = 10 * 60 * 1000
export const VERIFICATION_CODE_COOLDOWN_MS = 60 * 1000
export const MAX_VERIFICATION_CODE_ATTEMPTS = 3

const CODE_LENGTH = 6

export type VerificationCodePurpose = 'register' | 'password_reset'

export type VerifyCodeResult = { success: true } | { success: false; error: string }

export function generateVerificationCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4))
  const num = (bytes[0]! << 24 | bytes[1]! << 16 | bytes[2]! << 8 | bytes[3]!) >>> 0
  return String(num % 1_000_000).padStart(CODE_LENGTH, '0')
}

export async function isEmailVerificationEnabled(db: D1Database): Promise<boolean> {
  const row = await db
    .prepare("SELECT value FROM site_settings WHERE key = 'email_verification_enabled'")
    .first<{ value: string }>()
  if (!row) return false
  try {
    const value = JSON.parse(row.value)
    return value === true || value === 'true'
  } catch {
    return false
  }
}

export async function hasRecentVerificationCode(
  db: D1Database,
  email: string,
  purpose: VerificationCodePurpose,
): Promise<boolean> {
  const recentCode = await db
    .prepare(
      `SELECT id FROM email_verification_codes
       WHERE email = ? AND purpose = ? AND created_at > datetime('now', '-60 seconds')
       LIMIT 1`,
    )
    .bind(email, purpose)
    .first()

  return Boolean(recentCode)
}

export async function createVerificationCode(
  db: D1Database,
  email: string,
  purpose: VerificationCodePurpose,
  now: Date = new Date(),
): Promise<string> {
  const code = generateVerificationCode()
  const id = generateId('evc')
  const expiresAt = new Date(now.getTime() + VERIFICATION_CODE_TTL_MS).toISOString()

  await db
    .prepare(
      `UPDATE email_verification_codes SET used = 1
       WHERE email = ? AND purpose = ? AND used = 0`,
    )
    .bind(email, purpose)
    .run()

  await db
    .prepare(
      `INSERT INTO email_verification_codes (id, email, code, purpose, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(id, email, code, purpose, expiresAt)
    .run()

  return code
}

export async function verifyCode(
  db: D1Database,
  email: string,
  code: string,
  purpose: VerificationCodePurpose,
  now: Date = new Date(),
): Promise<VerifyCodeResult> {
  const record = await db
    .prepare(
      `SELECT id, code, attempts, expires_at FROM email_verification_codes
       WHERE email = ? AND purpose = ? AND used = 0
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(email, purpose)
    .first<{ id: string; code: string; attempts: number; expires_at: string }>()

  if (!record) {
    return { success: false, error: '验证码不存在或已失效，请重新发送' }
  }

  if (new Date(record.expires_at) < now) {
    await db.prepare('UPDATE email_verification_codes SET used = 1 WHERE id = ?').bind(record.id).run()
    return { success: false, error: '验证码已过期，请重新发送' }
  }

  if (record.attempts >= MAX_VERIFICATION_CODE_ATTEMPTS) {
    await db.prepare('UPDATE email_verification_codes SET used = 1 WHERE id = ?').bind(record.id).run()
    return { success: false, error: '验证码错误次数过多，请重新发送' }
  }

  if (record.code !== code) {
    await db
      .prepare('UPDATE email_verification_codes SET attempts = attempts + 1 WHERE id = ?')
      .bind(record.id)
      .run()
    const remaining = MAX_VERIFICATION_CODE_ATTEMPTS - record.attempts - 1
    return { success: false, error: `验证码错误，还可尝试 ${remaining} 次` }
  }

  await db.prepare('UPDATE email_verification_codes SET used = 1 WHERE id = ?').bind(record.id).run()
  return { success: true }
}
