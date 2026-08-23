import type {
  AppAccountAvatarStyle,
  AppAccountProfile,
} from '@meigallery/shared'
import { generateId } from '../utils/db'
import { verifyPassword } from '../utils/password'
import { containsAsciiControlCharacter } from '../utils/text-safety'
import {
  AppAccountAccessError,
  type AppSessionPrincipal,
} from './app-account-access'

export const APP_ACCOUNT_AVATAR_STYLES: AppAccountAvatarStyle[] = [
  'rose',
  'coral',
  'lilac',
  'sky',
  'mint',
  'sand',
]

export interface UpdateAppAccountProfileInput {
  expectedVersion?: unknown
  nickname?: unknown
  avatarStyle?: unknown
  currentPassword?: unknown
}

type AccountProfileRow = {
  email: string
  nickname: string | null
  password_hash: string
  email_verified: number
  avatar_style: string | null
  version: number | null
  updated_at: string | null
}

export async function getAppAccountProfile(
  db: D1Database,
  principal: AppSessionPrincipal,
): Promise<AppAccountProfile> {
  const row = await readAccountProfile(db, principal.accountInternalId)
  if (!row) {
    throw new AppAccountAccessError(404, 'ACCOUNT_NOT_FOUND', '账号不存在或已不可用')
  }
  return toAccountProfile(principal.accountId, row)
}

export async function updateAppAccountProfile(
  db: D1Database,
  principal: AppSessionPrincipal,
  input: UpdateAppAccountProfileInput,
  requestId: string,
  now = new Date(),
): Promise<AppAccountProfile> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AppAccountAccessError(400, 'ACCOUNT_PROFILE_INVALID', '账号资料格式无效')
  }
  const row = await readAccountProfile(db, principal.accountInternalId)
  if (!row) {
    throw new AppAccountAccessError(404, 'ACCOUNT_NOT_FOUND', '账号不存在或已不可用')
  }
  const expectedVersion = normalizeExpectedVersion(input.expectedVersion)
  const currentVersion = Number(row.version ?? 0)
  if (expectedVersion !== currentVersion) {
    throw new AppAccountAccessError(
      409,
      'ACCOUNT_PROFILE_VERSION_CONFLICT',
      '账号资料已在其他位置更新，请刷新后重试',
    )
  }

  const nickname = normalizeNickname(input.nickname)
  const avatarStyle = normalizeAvatarStyle(input.avatarStyle)
  const currentAvatarStyle = normalizeStoredAvatarStyle(row.avatar_style)
  if (nickname === row.nickname && avatarStyle === currentAvatarStyle) {
    return toAccountProfile(principal.accountId, row)
  }

  const currentPassword = normalizeCurrentPassword(input.currentPassword)
  if (!currentPassword) {
    throw new AppAccountAccessError(
      428,
      'ACCOUNT_PROFILE_REAUTH_REQUIRED',
      '修改账号识别信息前需要验证当前登录身份',
    )
  }
  if (!await verifyPassword(currentPassword, row.password_hash)) {
    throw new AppAccountAccessError(
      403,
      'ACCOUNT_PROFILE_REAUTH_FAILED',
      '当前密码不正确，请重新验证',
    )
  }

  const nowIso = now.toISOString()
  const securityEventId = generateId('ase')
  if (currentVersion === 0) {
    try {
      await db.batch([
        db.prepare(`
          UPDATE users
          SET nickname = ?, updated_at = ?
          WHERE id = ?
        `).bind(nickname, nowIso, principal.accountInternalId),
        db.prepare(`
          INSERT INTO app_account_profile_preferences (
            account_id, avatar_style, version, created_at, updated_at
          ) VALUES (?, ?, 1, ?, ?)
        `).bind(principal.accountInternalId, avatarStyle, nowIso, nowIso),
        db.prepare(`
          INSERT INTO app_account_security_events (
            id, account_id, device_id, session_id, event_type, reason_code,
            request_id, created_at
          ) VALUES (?, ?, ?, ?, 'account_profile_updated', 'password_reverified', ?, ?)
        `).bind(
          securityEventId,
          principal.accountInternalId,
          principal.deviceId,
          principal.sessionId,
          requestId,
          nowIso,
        ),
      ])
    }
    catch {
      throw new AppAccountAccessError(
        409,
        'ACCOUNT_PROFILE_VERSION_CONFLICT',
        '账号资料已在其他位置更新，请刷新后重试',
      )
    }
  }
  else {
    const results = await db.batch([
      db.prepare(`
        UPDATE users
        SET nickname = ?, updated_at = ?
        WHERE id = ?
          AND EXISTS (
            SELECT 1
            FROM app_account_profile_preferences profile
            WHERE profile.account_id = users.id AND profile.version = ?
          )
      `).bind(nickname, nowIso, principal.accountInternalId, expectedVersion),
      db.prepare(`
        UPDATE app_account_profile_preferences
        SET avatar_style = ?, version = version + 1, updated_at = ?
        WHERE account_id = ? AND version = ?
      `).bind(avatarStyle, nowIso, principal.accountInternalId, expectedVersion),
      db.prepare(`
        INSERT INTO app_account_security_events (
          id, account_id, device_id, session_id, event_type, reason_code,
          request_id, created_at
        )
        SELECT ?, ?, ?, ?, 'account_profile_updated', 'password_reverified', ?, ?
        WHERE EXISTS (
          SELECT 1
          FROM app_account_profile_preferences
          WHERE account_id = ? AND version = ? AND updated_at = ?
        )
      `).bind(
        securityEventId,
        principal.accountInternalId,
        principal.deviceId,
        principal.sessionId,
        requestId,
        nowIso,
        principal.accountInternalId,
        expectedVersion + 1,
        nowIso,
      ),
    ])
    if (
      Number(results[0]?.meta?.changes ?? 0) !== 1
      || Number(results[1]?.meta?.changes ?? 0) !== 1
      || Number(results[2]?.meta?.changes ?? 0) !== 1
    ) {
      throw new AppAccountAccessError(
        409,
        'ACCOUNT_PROFILE_VERSION_CONFLICT',
        '账号资料已在其他位置更新，请刷新后重试',
      )
    }
  }

  const updated = await readAccountProfile(db, principal.accountInternalId)
  if (!updated || Number(updated.version ?? 0) !== currentVersion + 1) {
    throw new AppAccountAccessError(
      503,
      'ACCOUNT_PROFILE_UPDATE_UNAVAILABLE',
      '账号资料暂时无法确认，请稍后重试',
      true,
    )
  }
  return toAccountProfile(principal.accountId, updated)
}

function readAccountProfile(db: D1Database, accountId: number) {
  return db.prepare(`
    SELECT users.email, users.nickname, users.password_hash, users.email_verified,
           profile.avatar_style, profile.version, profile.updated_at
    FROM users
    LEFT JOIN app_account_profile_preferences profile
      ON profile.account_id = users.id
    WHERE users.id = ?
    LIMIT 1
  `).bind(accountId).first<AccountProfileRow>()
}

function toAccountProfile(accountId: string, row: AccountProfileRow): AppAccountProfile {
  const nickname = row.nickname?.trim() || null
  return {
    accountId,
    nickname,
    avatarStyle: normalizeStoredAvatarStyle(row.avatar_style),
    avatarLabel: firstAvatarCharacter(nickname),
    loginIdentity: {
      provider: 'email',
      maskedValue: maskEmail(row.email),
      verified: row.email_verified === 1,
    },
    visibility: 'private',
    publicPersonProfileCreated: false,
    requiresReauthenticationForUpdate: true,
    version: Number(row.version ?? 0),
    updatedAt: row.updated_at,
  }
}

function normalizeExpectedVersion(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new AppAccountAccessError(400, 'EXPECTED_VERSION_INVALID', '账号资料版本无效')
  }
  return Number(value)
}

function normalizeNickname(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string') {
    throw new AppAccountAccessError(400, 'ACCOUNT_PROFILE_INVALID', '私有昵称格式无效')
  }
  const nickname = value.replace(/\s+/gu, ' ').trim()
  if (!nickname) return null
  if (nickname.length > 40 || containsAsciiControlCharacter(nickname)) {
    throw new AppAccountAccessError(400, 'ACCOUNT_PROFILE_INVALID', '私有昵称不能超过 40 个字符')
  }
  return nickname
}

function normalizeAvatarStyle(value: unknown): AppAccountAvatarStyle {
  if (typeof value !== 'string' || !APP_ACCOUNT_AVATAR_STYLES.includes(value as AppAccountAvatarStyle)) {
    throw new AppAccountAccessError(400, 'ACCOUNT_PROFILE_INVALID', '头像样式无效')
  }
  return value as AppAccountAvatarStyle
}

function normalizeStoredAvatarStyle(value: string | null): AppAccountAvatarStyle {
  return APP_ACCOUNT_AVATAR_STYLES.includes(value as AppAccountAvatarStyle)
    ? value as AppAccountAvatarStyle
    : 'rose'
}

function normalizeCurrentPassword(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || value.length < 8 || value.length > 128) {
    throw new AppAccountAccessError(400, 'ACCOUNT_PROFILE_REAUTH_INVALID', '当前密码格式无效')
  }
  return value
}

function maskEmail(value: string): string {
  const [local = '', domain = ''] = value.trim().toLowerCase().split('@')
  const visible = local.slice(0, Math.min(2, local.length))
  return `${visible}${'*'.repeat(Math.max(3, Math.min(6, local.length - visible.length)))}@${domain}`
}

function firstAvatarCharacter(nickname: string | null): string {
  const first = Array.from(nickname || '我')[0] || '我'
  return /^[a-z]$/u.test(first) ? first.toUpperCase() : first
}
