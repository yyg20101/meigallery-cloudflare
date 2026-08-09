import type { AppAccountRestrictionSummary } from '@meigallery/shared'
import type { Bindings } from '../index'
import { verifyCode } from './email-verification'
import { generateId } from '../utils/db'
import { hashPassword, verifyPassword } from '../utils/password'
import { getAppMembershipSummary } from './app-membership'

const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u
const INSTALLATION_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u
const POLICY_VERSION_PATTERN = /^[A-Za-z0-9._:-]{1,80}$/u
const APP_VERSION_PATTERN = /^[A-Za-z0-9._+-]{1,40}$/u
const TURNSTILE_SITE_KEY_PATTERN = /^[A-Za-z0-9_-]{10,128}$/u
const LOCAL_DOCUMENT_HOSTS = new Set(['localhost', '127.0.0.1', '10.0.2.2'])

export const APP_TURNSTILE_PAGE_PATH = '/api/v2/auth/turnstile' as const
export const APP_TURNSTILE_RESULT_PATH = '/api/v2/auth/turnstile/result' as const

type AppAuthErrorStatus = 400 | 401 | 403 | 404 | 409 | 503

export class AppAccountAccessError extends Error {
  constructor(
    public readonly status: AppAuthErrorStatus,
    public readonly code: string,
    message: string,
    public readonly retryable = false,
  ) {
    super(message)
  }
}

export type AppAuthDocumentVersions = {
  terms: string
  privacy: string
  platformOperation: string
  eligibility: string
}

export type AppAuthDocumentUrls = {
  terms: string
  privacy: string
  platformOperation: string
  eligibility: string
}

export type AppAuthRuntimeConfig = {
  requested: boolean
  enabled: boolean
  registrationEnabled: boolean
  methods: Array<'email'>
  challenge: { type: 'none' } | {
    type: 'turnstile'
    siteKey: string
    pagePath: typeof APP_TURNSTILE_PAGE_PATH
    resultPath: typeof APP_TURNSTILE_RESULT_PATH
  }
  documentVersions: AppAuthDocumentVersions | null
  documentUrls: AppAuthDocumentUrls | null
  accessTokenTtlSeconds: number
}

export type AppDeviceInput = {
  installationId: string
  platform: 'android' | 'ios'
  displayName: string
  appVersion: string
}

export type AppRegistrationInput = {
  email: string
  password: string
  nickname?: string | null
  verificationCode: string
  consents: {
    termsVersion: string
    privacyVersion: string
    platformOperationVersion: string
    eligibilityVersion: string
    eligibilityConfirmed: boolean
  }
  device: AppDeviceInput
}

export type AppLoginInput = {
  email: string
  password: string
  device: AppDeviceInput
  consents?: AppRegistrationInput['consents']
}

export type AppTokenPair = {
  tokenType: 'Bearer'
  accessToken: string
  refreshToken: string
  accessExpiresAt: string
  refreshExpiresAt: string
}

export type AppAccountSummary = {
  accountId: string
  email: string
  nickname: string | null
  role: string
  status: 'active' | 'restricted'
}

export type AppDeviceSummary = {
  deviceId: string
  platform: 'android' | 'ios'
  displayName: string
  appVersion: string
  status: 'active' | 'revoked'
  signedIn: boolean
  current: boolean
  firstSeenAt: string
  lastSeenAt: string
  revokedAt: string | null
}

export type AppAuthSessionResult = {
  account: AppAccountSummary
  device: AppDeviceSummary
  tokens: AppTokenPair
}

export type AppSessionPrincipal = {
  accountInternalId: number
  accountId: string
  sessionId: string
  deviceId: string
  email: string
  nickname: string | null
  role: string
  accountStatus: 'active' | 'restricted'
}

type SecurityRow = {
  account_id: number
  account_public_id: string
  status: 'active' | 'restricted' | 'deletion_pending'
  session_version: number
  restriction_reason_code: string | null
  restricted_until: string | null
}

type UserRow = {
  id: number
  email: string
  nickname: string | null
  password_hash: string
  role: string
  status: string
  email_verified: number
}

type DeviceRow = {
  id: string
  account_id: number
  platform: 'android' | 'ios'
  display_name: string
  app_version: string
  status: 'active' | 'revoked'
  session_version: number
  first_seen_at: string
  last_seen_at: string
  revoked_at: string | null
}

type SessionLookupRow = {
  session_id: string
  account_id: number
  device_id: string
  access_expires_at: string
  refresh_expires_at: string
  refresh_token_hash: string
  account_session_version: number
  device_session_version: number
  session_status: 'active' | 'revoked'
  account_public_id: string
  account_security_status: 'active' | 'restricted' | 'deletion_pending'
  current_account_session_version: number
  restriction_reason_code: string | null
  restricted_until: string | null
  email: string
  nickname: string | null
  role: string
  user_status: string
  device_platform: 'android' | 'ios'
  device_display_name: string
  device_app_version: string
  device_status: 'active' | 'revoked'
  current_device_session_version: number
  device_first_seen_at: string
  device_last_seen_at: string
  device_revoked_at: string | null
}

export function getAppAuthRuntimeConfig(env: Pick<
  Bindings,
  | 'APP_ENV'
  | 'APP_AUTH_ENABLED'
  | 'APP_AUTH_REGISTRATION_ENABLED'
  | 'APP_AUTH_TERMS_VERSION'
  | 'APP_AUTH_PRIVACY_VERSION'
  | 'APP_AUTH_PLATFORM_NOTICE_VERSION'
  | 'APP_AUTH_ELIGIBILITY_VERSION'
  | 'APP_AUTH_TERMS_URL'
  | 'APP_AUTH_PRIVACY_URL'
  | 'APP_AUTH_PLATFORM_NOTICE_URL'
  | 'APP_AUTH_ELIGIBILITY_URL'
  | 'APP_AUTH_TURNSTILE_SITE_KEY'
  | 'TURNSTILE_SECRET_KEY'
>): AppAuthRuntimeConfig {
  const requested = env.APP_AUTH_ENABLED === 'true'
  const documentVersions = parseDocumentVersions(env)
  const documentUrls = parseDocumentUrls(env)
  const siteKey = parseTurnstileSiteKey(env.APP_AUTH_TURNSTILE_SITE_KEY)
  const secretConfigured = Boolean(env.TURNSTILE_SECRET_KEY?.trim())
  const challengePairReady = secretConfigured === Boolean(siteKey)
  const productionChallengeReady = env.APP_ENV !== 'production'
    || Boolean(secretConfigured && siteKey)
  const enabled = requested
    && Boolean(documentVersions)
    && Boolean(documentUrls)
    && challengePairReady
    && productionChallengeReady
  const registrationEnabled = enabled && env.APP_AUTH_REGISTRATION_ENABLED === 'true'
  const challenge = secretConfigured && siteKey
    ? {
        type: 'turnstile' as const,
        siteKey,
        pagePath: APP_TURNSTILE_PAGE_PATH,
        resultPath: APP_TURNSTILE_RESULT_PATH,
      }
    : { type: 'none' as const }

  return {
    requested,
    enabled,
    registrationEnabled,
    methods: enabled ? ['email'] : [],
    challenge,
    documentVersions,
    documentUrls,
    accessTokenTtlSeconds: ACCESS_TOKEN_TTL_MS / 1000,
  }
}

export function requireAppAuthEnabled(config: AppAuthRuntimeConfig, registration = false): void {
  if (!config.enabled) {
    if (config.requested) {
      throw new AppAccountAccessError(
        503,
        'APP_AUTH_NOT_CONFIGURED',
        '账号服务尚未完成安全配置',
        true,
      )
    }
    throw new AppAccountAccessError(403, 'FEATURE_DISABLED', '账号功能当前未开放')
  }
  if (registration && !config.registrationEnabled) {
    throw new AppAccountAccessError(403, 'REGISTRATION_DISABLED', '新账号注册当前未开放')
  }
}

export async function registerAppAccount(
  env: Bindings,
  input: AppRegistrationInput,
  requestId: string,
  now = new Date(),
): Promise<AppAuthSessionResult> {
  const config = getAppAuthRuntimeConfig(env)
  requireAppAuthEnabled(config, true)
  const email = normalizeEmail(input.email)
  const password = validatePassword(input.password)
  const nickname = normalizeNickname(input.nickname)
  const deviceInput = validateDeviceInput(input.device)
  validateRegistrationConsents(input.consents, config.documentVersions!)

  const verification = await verifyCode(
    env.DB,
    email,
    normalizeVerificationCode(input.verificationCode),
    'register',
    now,
  )
  if (!verification.success) {
    throw new AppAccountAccessError(400, 'EMAIL_VERIFICATION_FAILED', '邮箱验证码无效或已过期')
  }

  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?')
    .bind(email)
    .first<{ id: number }>()
  if (existing) {
    throw new AppAccountAccessError(
      409,
      'ACCOUNT_CREATION_UNAVAILABLE',
      '暂时无法创建账号，请检查信息或使用登录/恢复流程',
    )
  }

  const passwordHash = await hashPassword(password)
  let accountId: number | null = null
  try {
    const inserted = await env.DB.prepare(`
      INSERT INTO users (
        email, username, nickname, password_hash, role, status, email_verified
      ) VALUES (?, NULL, ?, ?, 'user', 'active', 1)
    `).bind(email, nickname, passwordHash).run()
    accountId = Number(inserted.meta.last_row_id)
    if (!Number.isSafeInteger(accountId) || accountId <= 0) {
      throw new Error('APP_ACCOUNT_ID_NOT_CREATED')
    }

    const security = await createAccountFoundation(
      env.DB,
      accountId,
      email,
      true,
      input.consents,
      requestId,
      now,
    )
    const session = await establishDeviceSession(
      env.DB,
      userSummary({
        id: accountId,
        email,
        nickname,
        password_hash: passwordHash,
        role: 'user',
        status: 'active',
        email_verified: 1,
      }, security),
      security,
      deviceInput,
      requestId,
      'registration',
      now,
    )
    return session
  }
  catch (error) {
    if (accountId) {
      await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(accountId).run().catch(() => undefined)
    }
    if (error instanceof AppAccountAccessError) throw error
    throw new AppAccountAccessError(
      409,
      'ACCOUNT_CREATION_UNAVAILABLE',
      '暂时无法创建账号，请检查信息或使用登录/恢复流程',
    )
  }
}

export async function loginAppAccount(
  env: Bindings,
  input: AppLoginInput,
  requestId: string,
  now = new Date(),
): Promise<AppAuthSessionResult> {
  const config = getAppAuthRuntimeConfig(env)
  requireAppAuthEnabled(config)
  const email = normalizeEmail(input.email)
  const password = validatePassword(input.password)
  const deviceInput = validateDeviceInput(input.device)

  const user = await env.DB.prepare(`
    SELECT id, email, nickname, password_hash, role, status, email_verified
    FROM users
    WHERE email = ?
  `).bind(email).first<UserRow>()

  if (!user) {
    await hashPassword(password)
    throw invalidCredentials()
  }
  const passwordValid = await verifyPassword(password, user.password_hash)
  if (!passwordValid) throw invalidCredentials()
  if (user.status !== 'active') {
    throw new AppAccountAccessError(403, 'ACCOUNT_RESTRICTED', '账号当前不可用，请查看帮助或申诉入口')
  }

  const security = await ensureAccountFoundation(env.DB, user, requestId, now)
  assertSecurityCanLogin(security, now)
  await ensureCurrentConsents(
    env.DB,
    user.id,
    input.consents,
    config.documentVersions!,
    requestId,
    now,
  )
  return establishDeviceSession(
    env.DB,
    userSummary(user, security),
    security,
    deviceInput,
    requestId,
    'login',
    now,
  )
}

export async function refreshAppSession(
  db: D1Database,
  refreshToken: string,
  requestId: string,
  now = new Date(),
  requiredDocuments?: AppAuthDocumentVersions | null,
): Promise<AppAuthSessionResult> {
  const normalizedToken = normalizeToken(refreshToken, 'mgr_')
  const tokenHash = await hashOpaqueValue(normalizedToken)
  const row = await findSessionByRefreshHash(db, tokenHash)

  if (!row) {
    await revokeRefreshReplayIfKnown(db, tokenHash, requestId, now)
    throw new AppAccountAccessError(401, 'SESSION_INVALID', '会话已失效，请重新登录')
  }
  assertSessionUsable(row, now, 'refresh', { allowRestricted: true })
  if (requiredDocuments) {
    await assertCurrentConsents(db, row.account_id, requiredDocuments)
  }

  const tokens = await generateTokenPair(now)
  const newAccessHash = await hashOpaqueValue(tokens.accessToken)
  const newRefreshHash = await hashOpaqueValue(tokens.refreshToken)
  try {
    const results = await db.batch([
      db.prepare(`
        INSERT INTO app_refresh_token_history (token_hash, session_id, replaced_at)
        VALUES (?, ?, ?)
      `).bind(tokenHash, row.session_id, now.toISOString()),
      db.prepare(`
        UPDATE app_sessions
        SET access_token_hash = ?, refresh_token_hash = ?,
            access_expires_at = ?, refresh_expires_at = ?,
            last_seen_at = ?, refreshed_at = ?, updated_at = ?
        WHERE id = ? AND refresh_token_hash = ? AND status = 'active'
      `).bind(
        newAccessHash,
        newRefreshHash,
        tokens.accessExpiresAt,
        tokens.refreshExpiresAt,
        now.toISOString(),
        now.toISOString(),
        now.toISOString(),
        row.session_id,
        tokenHash,
      ),
    ])
    if ((results[1]?.meta.changes ?? 0) !== 1) {
      await revokeRefreshReplayIfKnown(db, tokenHash, requestId, now)
      throw new AppAccountAccessError(401, 'SESSION_INVALID', '会话已失效，请重新登录')
    }
  }
  catch (error) {
    if (error instanceof AppAccountAccessError) throw error
    await revokeRefreshReplayIfKnown(db, tokenHash, requestId, now)
    throw new AppAccountAccessError(401, 'SESSION_INVALID', '会话已失效，请重新登录')
  }

  await recordSecurityEvent(db, {
    accountId: row.account_id,
    deviceId: row.device_id,
    sessionId: row.session_id,
    eventType: 'session_refreshed',
    requestId,
    now,
  })

  return {
    account: accountSummaryFromSession(row),
    device: deviceSummaryFromSession(row, true, true, now),
    tokens,
  }
}

export async function authenticateAppAccessToken(
  db: D1Database,
  accessToken: string,
  now = new Date(),
  requiredDocuments?: AppAuthDocumentVersions | null,
  options: { allowRestricted?: boolean } = {},
): Promise<AppSessionPrincipal> {
  const normalizedToken = normalizeToken(accessToken, 'mga_')
  const tokenHash = await hashOpaqueValue(normalizedToken)
  const row = await findSessionByAccessHash(db, tokenHash)
  if (!row) {
    throw new AppAccountAccessError(401, 'AUTH_REQUIRED', '请重新登录')
  }
  assertSessionUsable(row, now, 'access', options)
  if (requiredDocuments) {
    await assertCurrentConsents(db, row.account_id, requiredDocuments)
  }

  await db.batch([
    db.prepare(`
      UPDATE app_sessions
      SET last_seen_at = ?, updated_at = ?
      WHERE id = ? AND last_seen_at < ?
    `).bind(now.toISOString(), now.toISOString(), row.session_id, new Date(now.getTime() - 5 * 60 * 1000).toISOString()),
    db.prepare(`
      UPDATE app_devices
      SET last_seen_at = ?, updated_at = ?
      WHERE id = ? AND last_seen_at < ?
    `).bind(now.toISOString(), now.toISOString(), row.device_id, new Date(now.getTime() - 5 * 60 * 1000).toISOString()),
  ])

  return {
    accountInternalId: row.account_id,
    accountId: row.account_public_id,
    sessionId: row.session_id,
    deviceId: row.device_id,
    email: row.email,
    nickname: row.nickname,
    role: row.role,
    accountStatus: row.account_security_status === 'restricted' ? 'restricted' : 'active',
  }
}

export async function revokeCurrentAppSession(
  db: D1Database,
  accessToken: string,
  requestId: string,
  now = new Date(),
): Promise<void> {
  const normalizedToken = normalizeToken(accessToken, 'mga_')
  const tokenHash = await hashOpaqueValue(normalizedToken)
  const row = await findSessionByAccessHash(db, tokenHash)
  if (!row) return

  await db.prepare(`
    UPDATE app_sessions
    SET status = 'revoked', revoked_at = ?, revoke_reason = 'current_logout', updated_at = ?
    WHERE id = ? AND status = 'active'
  `).bind(now.toISOString(), now.toISOString(), row.session_id).run()
  await recordSecurityEvent(db, {
    accountId: row.account_id,
    deviceId: row.device_id,
    sessionId: row.session_id,
    eventType: 'session_logged_out',
    requestId,
    now,
  })
}

export async function getAppAccount(
  db: D1Database,
  principal: AppSessionPrincipal,
  appMembership: {
    catalogVersionId: string
    requireProductionReady: boolean
  } | null = null,
  now = new Date(),
): Promise<{
  account: AppAccountSummary
  membership: { code: string; name: string; rank: number; expiresAt: string | null }
  currentDeviceId: string
  restriction: AppAccountRestrictionSummary | null
}> {
  const [membership, security] = await Promise.all([
    getAppMembershipSummary(
      db,
      principal.accountInternalId,
      appMembership?.catalogVersionId ?? null,
      now,
      { requireProductionReady: appMembership?.requireProductionReady },
    ),
    principal.accountStatus === 'restricted'
      ? getSecurityRow(db, principal.accountInternalId)
      : Promise.resolve(null),
  ])

  return {
    account: {
      accountId: principal.accountId,
      email: principal.email,
      nickname: principal.nickname,
      role: principal.role,
      status: principal.accountStatus,
    },
    membership,
    currentDeviceId: principal.deviceId,
    restriction: principal.accountStatus === 'restricted'
      ? restrictionSummary(security)
      : null,
  }
}

function restrictionSummary(security: SecurityRow | null): AppAccountRestrictionSummary {
  const reasonCode = security?.restriction_reason_code?.toLowerCase() ?? ''
  const reasonCategory = reasonCode.includes('deletion')
    ? 'account_deletion'
    : reasonCode.includes('policy') || reasonCode.includes('terms') || reasonCode.includes('consent')
      ? 'policy'
      : reasonCode.includes('admin') || reasonCode.includes('manual')
        ? 'administrative'
        : 'security_review'
  const fullRestriction = reasonCategory === 'account_deletion'

  return {
    mode: fullRestriction ? 'full' : 'partial',
    reasonCategory,
    title: fullRestriction ? '账号正在处理注销' : '账号部分功能受限',
    message: fullRestriction
      ? '账号已进入数据权利处理流程，普通业务入口保持关闭。请通过数据任务入口查看权威状态。'
      : '平台正在复核账号状态。受限期间仅保留帮助、必要数据权利和退出登录等安全入口。',
    restrictedUntil: security?.restricted_until ?? null,
    actions: ['help', 'data_rights', 'logout'],
  }
}

export async function listAppDevices(
  db: D1Database,
  principal: AppSessionPrincipal,
  now = new Date(),
): Promise<AppDeviceSummary[]> {
  const rows = await db.prepare(`
    SELECT d.id, d.account_id, d.platform, d.display_name, d.app_version, d.status,
           d.session_version, d.first_seen_at, d.last_seen_at, d.revoked_at,
           CASE WHEN EXISTS (
             SELECT 1 FROM app_sessions s
             WHERE s.device_id = d.id
               AND s.status = 'active'
               AND julianday(s.refresh_expires_at) > julianday(?)
           ) THEN 1 ELSE 0 END AS signed_in
    FROM app_devices d
    WHERE d.account_id = ?
    ORDER BY datetime(d.last_seen_at) DESC, d.id DESC
    LIMIT 50
  `).bind(now.toISOString(), principal.accountInternalId).all<DeviceRow & { signed_in: number }>()

  return rows.results.map(row => deviceSummary(row, row.signed_in === 1, row.id === principal.deviceId))
}

export async function revokeAppDevice(
  db: D1Database,
  principal: AppSessionPrincipal,
  deviceId: string,
  requestId: string,
  now = new Date(),
): Promise<AppDeviceSummary> {
  const device = await db.prepare(`
    SELECT id, account_id, platform, display_name, app_version, status,
           session_version, first_seen_at, last_seen_at, revoked_at
    FROM app_devices
    WHERE id = ? AND account_id = ?
  `).bind(deviceId, principal.accountInternalId).first<DeviceRow>()
  if (!device) {
    throw new AppAccountAccessError(404, 'DEVICE_NOT_FOUND', '设备不存在')
  }
  if (deviceId === principal.deviceId) {
    throw new AppAccountAccessError(
      409,
      'CURRENT_DEVICE_LOGOUT_REQUIRED',
      '当前设备请使用退出登录操作',
    )
  }
  if (device.status === 'revoked') return deviceSummary(device, false, false)

  await db.batch([
    db.prepare(`
      UPDATE app_devices
      SET status = 'revoked', session_version = session_version + 1,
          revoked_at = ?, updated_at = ?
      WHERE id = ? AND account_id = ? AND status = 'active'
    `).bind(now.toISOString(), now.toISOString(), deviceId, principal.accountInternalId),
    db.prepare(`
      UPDATE app_sessions
      SET status = 'revoked', revoked_at = ?, revoke_reason = 'remote_device_logout', updated_at = ?
      WHERE device_id = ? AND account_id = ? AND status = 'active'
    `).bind(now.toISOString(), now.toISOString(), deviceId, principal.accountInternalId),
  ])
  await recordSecurityEvent(db, {
    accountId: principal.accountInternalId,
    deviceId,
    sessionId: principal.sessionId,
    eventType: 'device_revoked',
    reasonCode: 'remote_device_logout',
    requestId,
    now,
  })
  return {
    ...deviceSummary(device, false, false),
    status: 'revoked',
    revokedAt: now.toISOString(),
  }
}

export function readBearerToken(authorization: string | undefined): string {
  const match = authorization?.match(/^Bearer\s+([^\s]+)$/iu)
  if (!match?.[1]) {
    throw new AppAccountAccessError(401, 'AUTH_REQUIRED', '请先登录')
  }
  return match[1]
}

export function normalizeRegistrationEmail(value: unknown): string {
  return normalizeEmail(String(value ?? ''))
}

function parseDocumentVersions(env: Pick<
  Bindings,
  | 'APP_AUTH_TERMS_VERSION'
  | 'APP_AUTH_PRIVACY_VERSION'
  | 'APP_AUTH_PLATFORM_NOTICE_VERSION'
  | 'APP_AUTH_ELIGIBILITY_VERSION'
>): AppAuthDocumentVersions | null {
  const versions = {
    terms: env.APP_AUTH_TERMS_VERSION?.trim() ?? '',
    privacy: env.APP_AUTH_PRIVACY_VERSION?.trim() ?? '',
    platformOperation: env.APP_AUTH_PLATFORM_NOTICE_VERSION?.trim() ?? '',
    eligibility: env.APP_AUTH_ELIGIBILITY_VERSION?.trim() ?? '',
  }
  return Object.values(versions).every(value => POLICY_VERSION_PATTERN.test(value)) ? versions : null
}

function parseDocumentUrls(env: Pick<
  Bindings,
  | 'APP_ENV'
  | 'APP_AUTH_TERMS_URL'
  | 'APP_AUTH_PRIVACY_URL'
  | 'APP_AUTH_PLATFORM_NOTICE_URL'
  | 'APP_AUTH_ELIGIBILITY_URL'
>): AppAuthDocumentUrls | null {
  const urls = {
    terms: normalizeDocumentUrl(env.APP_AUTH_TERMS_URL, env.APP_ENV),
    privacy: normalizeDocumentUrl(env.APP_AUTH_PRIVACY_URL, env.APP_ENV),
    platformOperation: normalizeDocumentUrl(env.APP_AUTH_PLATFORM_NOTICE_URL, env.APP_ENV),
    eligibility: normalizeDocumentUrl(env.APP_AUTH_ELIGIBILITY_URL, env.APP_ENV),
  }
  return Object.values(urls).every((value): value is string => value !== null)
    ? urls as AppAuthDocumentUrls
    : null
}

function normalizeDocumentUrl(value: string | undefined, environment: string): string | null {
  const raw = value?.trim() ?? ''
  if (!raw || raw.length > 2048) return null
  try {
    const url = new URL(raw)
    const isProduction = environment === 'production'
    const safeProtocol = url.protocol === 'https:'
      || (!isProduction && url.protocol === 'http:' && LOCAL_DOCUMENT_HOSTS.has(url.hostname))
    if (!safeProtocol || url.username || url.password || url.hash) return null
    return url.href
  }
  catch {
    return null
  }
}

function parseTurnstileSiteKey(value: string | undefined): string | null {
  const siteKey = value?.trim() ?? ''
  return TURNSTILE_SITE_KEY_PATTERN.test(siteKey) ? siteKey : null
}

function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase()
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
    throw new AppAccountAccessError(400, 'INVALID_EMAIL', '邮箱格式无效')
  }
  return email
}

function validatePassword(value: string): string {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128) {
    throw new AppAccountAccessError(400, 'INVALID_PASSWORD', '密码长度需为 8–128 位')
  }
  return value
}

function normalizeNickname(value: string | null | undefined): string | null {
  const nickname = value?.replace(/\s+/gu, ' ').trim() ?? ''
  if (!nickname) return null
  if (nickname.length > 40) {
    throw new AppAccountAccessError(400, 'INVALID_NICKNAME', '昵称不能超过 40 个字符')
  }
  return nickname
}

function normalizeVerificationCode(value: string): string {
  const code = value.trim()
  if (!/^\d{6}$/u.test(code)) {
    throw new AppAccountAccessError(400, 'EMAIL_VERIFICATION_FAILED', '邮箱验证码无效或已过期')
  }
  return code
}

function validateDeviceInput(input: AppDeviceInput): AppDeviceInput {
  if (!INSTALLATION_ID_PATTERN.test(input.installationId)) {
    throw new AppAccountAccessError(400, 'INVALID_DEVICE', '设备安装标识无效')
  }
  if (input.platform !== 'android' && input.platform !== 'ios') {
    throw new AppAccountAccessError(400, 'INVALID_DEVICE', '设备平台无效')
  }
  const displayName = input.displayName.replace(/\s+/gu, ' ').trim()
  if (displayName.length < 2 || displayName.length > 80) {
    throw new AppAccountAccessError(400, 'INVALID_DEVICE', '设备名称长度需为 2–80 个字符')
  }
  const appVersion = input.appVersion.trim()
  if (!APP_VERSION_PATTERN.test(appVersion)) {
    throw new AppAccountAccessError(400, 'INVALID_DEVICE', '客户端版本格式无效')
  }
  return { ...input, displayName, appVersion }
}

function validateRegistrationConsents(
  input: AppRegistrationInput['consents'],
  expected: AppAuthDocumentVersions,
): void {
  const matches = input.termsVersion === expected.terms
    && input.privacyVersion === expected.privacy
    && input.platformOperationVersion === expected.platformOperation
    && input.eligibilityVersion === expected.eligibility
  if (!matches || input.eligibilityConfirmed !== true) {
    throw new AppAccountAccessError(
      409,
      'CONSENT_REQUIRED',
      '条款、隐私或必要资格说明已更新，请重新确认',
    )
  }
}

async function createAccountFoundation(
  db: D1Database,
  accountId: number,
  email: string,
  emailVerified: boolean,
  consents: AppRegistrationInput['consents'],
  requestId: string,
  now: Date,
): Promise<SecurityRow> {
  const security: SecurityRow = {
    account_id: accountId,
    account_public_id: generateId('acc'),
    status: 'active',
    session_version: 1,
    restriction_reason_code: null,
    restricted_until: null,
  }
  const subjectHash = await hashOpaqueValue(email)
  const acceptedAt = now.toISOString()
  await db.batch([
    db.prepare(`
      INSERT INTO app_account_security (
        account_id, account_public_id, status, session_version, created_at, updated_at
      ) VALUES (?, ?, 'active', 1, ?, ?)
    `).bind(accountId, security.account_public_id, acceptedAt, acceptedAt),
    db.prepare(`
      INSERT INTO app_account_identities (
        id, account_id, provider, provider_subject_hash, status, verified_at, created_at, updated_at
      ) VALUES (?, ?, 'email', ?, 'active', ?, ?, ?)
    `).bind(
      generateId('aid'),
      accountId,
      subjectHash,
      emailVerified ? acceptedAt : null,
      acceptedAt,
      acceptedAt,
    ),
    ...consentStatements(db, accountId, consents, requestId, acceptedAt),
  ])
  return security
}

async function ensureAccountFoundation(
  db: D1Database,
  user: UserRow,
  requestId: string,
  now: Date,
): Promise<SecurityRow> {
  let security = await getSecurityRow(db, user.id)
  if (!security) {
    const publicId = generateId('acc')
    await db.prepare(`
      INSERT OR IGNORE INTO app_account_security (
        account_id, account_public_id, status, session_version, created_at, updated_at
      ) VALUES (?, ?, 'active', 1, ?, ?)
    `).bind(user.id, publicId, now.toISOString(), now.toISOString()).run()
    security = await getSecurityRow(db, user.id)
  }
  if (!security) {
    throw new AppAccountAccessError(503, 'ACCOUNT_STATE_UNAVAILABLE', '账号状态暂时不可用', true)
  }

  const subjectHash = await hashOpaqueValue(user.email)
  const existingIdentity = await db.prepare(`
    SELECT account_id, status FROM app_account_identities
    WHERE provider = 'email' AND provider_subject_hash = ?
  `).bind(subjectHash).first<{ account_id: number; status: 'active' | 'revoked' }>()
  if (existingIdentity && existingIdentity.account_id !== user.id) {
    throw new AppAccountAccessError(409, 'IDENTITY_CONFLICT', '登录身份需要人工核验，请联系平台')
  }
  if (existingIdentity?.status === 'revoked') {
    throw new AppAccountAccessError(403, 'IDENTITY_REVOKED', '该登录身份当前不可用，请联系平台')
  }
  if (!existingIdentity) {
    await db.prepare(`
      INSERT INTO app_account_identities (
        id, account_id, provider, provider_subject_hash, status, verified_at, created_at, updated_at
      ) VALUES (?, ?, 'email', ?, 'active', ?, ?, ?)
    `).bind(
      generateId('aid'),
      user.id,
      subjectHash,
      user.email_verified === 1 ? now.toISOString() : null,
      now.toISOString(),
      now.toISOString(),
    ).run()
    await recordSecurityEvent(db, {
      accountId: user.id,
      eventType: 'legacy_account_linked',
      reasonCode: 'verified_password',
      requestId,
      now,
    })
  }
  return security
}

async function ensureCurrentConsents(
  db: D1Database,
  accountId: number,
  supplied: AppRegistrationInput['consents'] | undefined,
  expected: AppAuthDocumentVersions,
  requestId: string,
  now: Date,
): Promise<void> {
  if (await hasCurrentConsents(db, accountId, expected)) return
  if (!supplied) {
    throw new AppAccountAccessError(
      409,
      'CONSENT_REQUIRED',
      '条款、隐私或必要资格说明已更新，请重新确认',
    )
  }
  validateRegistrationConsents(supplied, expected)
  await db.batch(consentStatements(db, accountId, supplied, requestId, now.toISOString(), true))
}

async function assertCurrentConsents(
  db: D1Database,
  accountId: number,
  expected: AppAuthDocumentVersions,
): Promise<void> {
  if (await hasCurrentConsents(db, accountId, expected)) return
  throw new AppAccountAccessError(
    409,
    'CONSENT_REQUIRED',
    '条款、隐私或必要资格说明已更新，请重新确认',
  )
}

async function hasCurrentConsents(
  db: D1Database,
  accountId: number,
  expected: AppAuthDocumentVersions,
): Promise<boolean> {
  const row = await db.prepare(`
    SELECT COUNT(DISTINCT document_type) AS accepted_count
    FROM app_account_consents
    WHERE account_id = ?
      AND (
        (document_type = 'terms' AND document_version = ?)
        OR (document_type = 'privacy' AND document_version = ?)
        OR (document_type = 'platform_operation' AND document_version = ?)
        OR (document_type = 'eligibility' AND document_version = ?)
      )
  `).bind(
    accountId,
    expected.terms,
    expected.privacy,
    expected.platformOperation,
    expected.eligibility,
  ).first<{ accepted_count: number }>()
  return row?.accepted_count === 4
}

function consentStatements(
  db: D1Database,
  accountId: number,
  consents: AppRegistrationInput['consents'],
  requestId: string,
  acceptedAt: string,
  ignoreExisting = false,
): D1PreparedStatement[] {
  const rows = [
    ['terms', consents.termsVersion, 'accepted'],
    ['privacy', consents.privacyVersion, 'accepted'],
    ['platform_operation', consents.platformOperationVersion, 'accepted'],
    ['eligibility', consents.eligibilityVersion, 'confirmed'],
  ] as const
  return rows.map(([type, version, decision]) => db.prepare(`
    INSERT ${ignoreExisting ? 'OR IGNORE ' : ''}INTO app_account_consents (
      id, account_id, document_type, document_version, decision,
      source, request_id, accepted_at, created_at
    ) VALUES (?, ?, ?, ?, ?, 'app', ?, ?, ?)
  `).bind(generateId('con'), accountId, type, version, decision, requestId, acceptedAt, acceptedAt))
}

async function establishDeviceSession(
  db: D1Database,
  account: AppAccountSummary,
  security: SecurityRow,
  input: AppDeviceInput,
  requestId: string,
  eventType: 'registration' | 'login',
  now: Date,
): Promise<AppAuthSessionResult> {
  const installationHash = await hashOpaqueValue(input.installationId)
  let device = await db.prepare(`
    SELECT id, account_id, platform, display_name, app_version, status,
           session_version, first_seen_at, last_seen_at, revoked_at
    FROM app_devices
    WHERE account_id = ? AND installation_hash = ?
  `).bind(security.account_id, installationHash).first<DeviceRow>()

  if (!device) {
    const deviceId = generateId('dev')
    await db.prepare(`
      INSERT INTO app_devices (
        id, account_id, installation_hash, platform, display_name, app_version,
        status, session_version, first_seen_at, last_seen_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?, ?)
    `).bind(
      deviceId,
      security.account_id,
      installationHash,
      input.platform,
      input.displayName,
      input.appVersion,
      now.toISOString(),
      now.toISOString(),
      now.toISOString(),
      now.toISOString(),
    ).run()
  }
  else {
    await db.batch([
      db.prepare(`
        UPDATE app_sessions
        SET status = 'revoked', revoked_at = ?, revoke_reason = 'new_login', updated_at = ?
        WHERE device_id = ? AND status = 'active'
      `).bind(now.toISOString(), now.toISOString(), device.id),
      db.prepare(`
        UPDATE app_devices
        SET platform = ?, display_name = ?, app_version = ?, status = 'active',
            session_version = session_version + 1, last_seen_at = ?, revoked_at = NULL, updated_at = ?
        WHERE id = ?
      `).bind(
        input.platform,
        input.displayName,
        input.appVersion,
        now.toISOString(),
        now.toISOString(),
        device.id,
      ),
    ])
  }

  device = await db.prepare(`
    SELECT id, account_id, platform, display_name, app_version, status,
           session_version, first_seen_at, last_seen_at, revoked_at
    FROM app_devices
    WHERE account_id = ? AND installation_hash = ?
  `).bind(security.account_id, installationHash).first<DeviceRow>()
  if (!device) {
    throw new AppAccountAccessError(503, 'DEVICE_STATE_UNAVAILABLE', '设备状态暂时不可用', true)
  }

  const tokens = await generateTokenPair(now)
  const sessionId = generateId('aps')
  await db.prepare(`
    INSERT INTO app_sessions (
      id, account_id, device_id, access_token_hash, refresh_token_hash,
      account_session_version, device_session_version, status,
      access_expires_at, refresh_expires_at, last_seen_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
  `).bind(
    sessionId,
    security.account_id,
    device.id,
    await hashOpaqueValue(tokens.accessToken),
    await hashOpaqueValue(tokens.refreshToken),
    security.session_version,
    device.session_version,
    tokens.accessExpiresAt,
    tokens.refreshExpiresAt,
    now.toISOString(),
    now.toISOString(),
    now.toISOString(),
  ).run()
  await recordSecurityEvent(db, {
    accountId: security.account_id,
    deviceId: device.id,
    sessionId,
    eventType: eventType === 'registration' ? 'account_registered' : 'session_logged_in',
    requestId,
    now,
  })

  return {
    account,
    device: deviceSummary(device, true, true),
    tokens,
  }
}

async function getSecurityRow(db: D1Database, accountId: number): Promise<SecurityRow | null> {
  return db.prepare(`
    SELECT account_id, account_public_id, status, session_version,
           restriction_reason_code, restricted_until
    FROM app_account_security
    WHERE account_id = ?
  `).bind(accountId).first<SecurityRow>()
}

function assertSecurityCanLogin(security: SecurityRow, now: Date): void {
  if (security.status === 'active') return
  if (security.status === 'restricted') return
  if (security.restricted_until && Date.parse(security.restricted_until) <= now.getTime()) {
    throw new AppAccountAccessError(403, 'ACCOUNT_REVIEW_REQUIRED', '账号限制已到期，状态仍需平台复核')
  }
  throw new AppAccountAccessError(403, 'ACCOUNT_RESTRICTED', '账号当前不可用，请查看帮助或申诉入口')
}

function userSummary(user: UserRow, security: SecurityRow): AppAccountSummary {
  return {
    accountId: security.account_public_id,
    email: user.email,
    nickname: user.nickname,
    role: user.role,
    status: security.status === 'restricted' ? 'restricted' : 'active',
  }
}

async function generateTokenPair(now: Date): Promise<AppTokenPair> {
  return {
    tokenType: 'Bearer',
    accessToken: generateOpaqueToken('mga'),
    refreshToken: generateOpaqueToken('mgr'),
    accessExpiresAt: new Date(now.getTime() + ACCESS_TOKEN_TTL_MS).toISOString(),
    refreshExpiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS).toISOString(),
  }
}

function generateOpaqueToken(prefix: 'mga' | 'mgr'): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const encoded = btoa(String.fromCharCode(...bytes))
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/gu, '')
  return `${prefix}_${encoded}`
}

async function hashOpaqueValue(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

function normalizeToken(value: string, prefix: 'mga_' | 'mgr_'): string {
  const token = value.trim()
  if (!token.startsWith(prefix) || token.length < 40 || token.length > 100) {
    throw new AppAccountAccessError(401, 'SESSION_INVALID', '会话已失效，请重新登录')
  }
  return token
}

async function findSessionByAccessHash(db: D1Database, hash: string): Promise<SessionLookupRow | null> {
  return findSession(db, 'access_token_hash', hash)
}

async function findSessionByRefreshHash(db: D1Database, hash: string): Promise<SessionLookupRow | null> {
  return findSession(db, 'refresh_token_hash', hash)
}

async function findSession(
  db: D1Database,
  tokenColumn: 'access_token_hash' | 'refresh_token_hash',
  hash: string,
): Promise<SessionLookupRow | null> {
  return db.prepare(`
    SELECT s.id AS session_id, s.account_id, s.device_id,
           s.access_expires_at, s.refresh_expires_at, s.refresh_token_hash,
           s.account_session_version, s.device_session_version, s.status AS session_status,
           sec.account_public_id, sec.status AS account_security_status,
           sec.session_version AS current_account_session_version,
           sec.restriction_reason_code, sec.restricted_until,
           u.email, u.nickname, u.role, u.status AS user_status,
           d.platform AS device_platform, d.display_name AS device_display_name,
           d.app_version AS device_app_version, d.status AS device_status,
           d.session_version AS current_device_session_version,
           d.first_seen_at AS device_first_seen_at, d.last_seen_at AS device_last_seen_at,
           d.revoked_at AS device_revoked_at
    FROM app_sessions s
    JOIN users u ON u.id = s.account_id
    JOIN app_account_security sec ON sec.account_id = s.account_id
    JOIN app_devices d ON d.id = s.device_id
    WHERE s.${tokenColumn} = ?
  `).bind(hash).first<SessionLookupRow>()
}

function assertSessionUsable(
  row: SessionLookupRow,
  now: Date,
  credential: 'access' | 'refresh',
  options: { allowRestricted?: boolean } = {},
): void {
  const expiresAt = credential === 'access' ? row.access_expires_at : row.refresh_expires_at
  const versionValid = row.account_session_version === row.current_account_session_version
    && row.device_session_version === row.current_device_session_version
  const accountSecurityUsable = row.account_security_status === 'active'
    || (options.allowRestricted === true && row.account_security_status === 'restricted')
  if (
    row.session_status !== 'active'
    || row.device_status !== 'active'
    || row.user_status !== 'active'
    || !accountSecurityUsable
    || !versionValid
    || Date.parse(expiresAt) <= now.getTime()
  ) {
    throw new AppAccountAccessError(401, 'SESSION_EXPIRED', '会话已失效，请重新登录')
  }
}

async function revokeRefreshReplayIfKnown(
  db: D1Database,
  tokenHash: string,
  requestId: string,
  now: Date,
): Promise<void> {
  const replay = await db.prepare(`
    SELECT h.session_id, s.account_id, s.device_id
    FROM app_refresh_token_history h
    JOIN app_sessions s ON s.id = h.session_id
    WHERE h.token_hash = ?
  `).bind(tokenHash).first<{ session_id: string; account_id: number; device_id: string }>()
  if (!replay) return
  await db.prepare(`
    UPDATE app_sessions
    SET status = 'revoked', revoked_at = ?, revoke_reason = 'refresh_token_reuse', updated_at = ?
    WHERE id = ?
  `).bind(now.toISOString(), now.toISOString(), replay.session_id).run()
  await recordSecurityEvent(db, {
    accountId: replay.account_id,
    deviceId: replay.device_id,
    sessionId: replay.session_id,
    eventType: 'refresh_token_reuse_detected',
    reasonCode: 'credential_replay',
    requestId,
    now,
  })
}

function accountSummaryFromSession(row: SessionLookupRow): AppAccountSummary {
  return {
    accountId: row.account_public_id,
    email: row.email,
    nickname: row.nickname,
    role: row.role,
    status: row.account_security_status === 'restricted' ? 'restricted' : 'active',
  }
}

function deviceSummaryFromSession(
  row: SessionLookupRow,
  signedIn: boolean,
  current: boolean,
  now: Date,
): AppDeviceSummary {
  return {
    deviceId: row.device_id,
    platform: row.device_platform,
    displayName: row.device_display_name,
    appVersion: row.device_app_version,
    status: row.device_status,
    signedIn,
    current,
    firstSeenAt: row.device_first_seen_at,
    lastSeenAt: now.toISOString(),
    revokedAt: row.device_revoked_at,
  }
}

function deviceSummary(row: DeviceRow, signedIn: boolean, current: boolean): AppDeviceSummary {
  return {
    deviceId: row.id,
    platform: row.platform,
    displayName: row.display_name,
    appVersion: row.app_version,
    status: row.status,
    signedIn,
    current,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
  }
}

async function recordSecurityEvent(
  db: D1Database,
  input: {
    accountId?: number
    deviceId?: string
    sessionId?: string
    eventType: string
    reasonCode?: string
    requestId: string
    now: Date
  },
): Promise<void> {
  await db.prepare(`
    INSERT INTO app_account_security_events (
      id, account_id, device_id, session_id, event_type, reason_code, request_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    generateId('ase'),
    input.accountId ?? null,
    input.deviceId ?? null,
    input.sessionId ?? null,
    input.eventType,
    input.reasonCode ?? null,
    input.requestId,
    input.now.toISOString(),
  ).run()
}

function invalidCredentials(): AppAccountAccessError {
  return new AppAccountAccessError(401, 'INVALID_CREDENTIALS', '邮箱或密码错误')
}
