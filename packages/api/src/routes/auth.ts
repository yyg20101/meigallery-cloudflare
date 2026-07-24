import { Hono } from 'hono'
import type { Bindings, Variables } from '../index'
import { hashPassword, verifyPassword } from '../utils/password'
import { createSession, destroyAllUserSessions } from '../utils/session'
import { sendRegistrationCode, sendPasswordResetCode } from '../services/email'
import {
  VERIFICATION_CODE_COOLDOWN_MS,
  createVerificationCode,
  hasRecentVerificationCode,
  isEmailVerificationEnabled,
  verifyCode,
  type VerificationCodePurpose,
} from '../services/email-verification'
import { validateUsername } from '@meigallery/shared/utils'
import { getTurnstileConfigError, validateTurnstile } from '../utils/turnstile'
import { consumeInviteCodeForRegistration } from '../services/invite-codes'
import type { AnalyticsConsentState } from '@meigallery/shared'
import { getCookie } from 'hono/cookie'
import { hashAdPlatformEmail } from '../utils/ad-platform-identifiers'
import { resolveRequestMarketingConsent } from '../utils/marketing-consent-request'
import { createAdConsentSnapshot } from '../utils/marketing-consent-receipt'
import {
  buildCompleteRegistrationOutboxStatement,
  dispatchAttributionBusinessOutboxImmediately,
} from '../services/attribution-business-outbox'
import { createAttributionServiceClient } from '../services/attribution-service-client'

type RegistrationAttributionContext = {
  visitorId?: string
  sessionId?: string
  path?: string
  sourceChannel?: string
  consentState?: AnalyticsConsentState
}

const CONVERSION_ID_RE = /^[A-Za-z0-9_-]{8,120}$/
const ATTRIBUTION_CONTEXT_COOKIE = '__Secure-mg_attribution_context'

export const authRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// ============================================================
// GET /api/auth/check-username/:username - 检查用户名可用性
// ============================================================

authRoutes.get('/check-username/:username', async (c) => {
  const username = c.req.param('username').toLowerCase()

  const result = validateUsername(username)
  if (!result.valid) {
    return c.json({ available: false, error: result.error })
  }

  const db = c.env.DB
  const existing = await db
    .prepare('SELECT id FROM users WHERE username = ?')
    .bind(username)
    .first()

  return c.json({ available: !existing })
})

// ============================================================
// POST /api/auth/send-code - 发送验证码
// ============================================================

authRoutes.post('/send-code', async (c) => {
  const db = c.env.DB
  const turnstileConfigError = getTurnstileConfigError(c.env)
  if (turnstileConfigError) return c.json(turnstileConfigError.body, turnstileConfigError.status)

  // 检查邮箱验证是否开启
  const verificationEnabled = await isEmailVerificationEnabled(db)
  if (!verificationEnabled) {
    return c.json({ statusCode: 400, message: '邮箱验证未开启' }, 400)
  }

  const body = await c.req.json<{
    email?: string
    purpose?: string
    turnstileToken?: string
  }>()

  if (!body.email || !body.purpose) {
    return c.json({ statusCode: 400, message: '邮箱和用途为必填' }, 400)
  }

  const email = body.email.trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ statusCode: 400, message: '邮箱格式无效' }, 400)
  }

  const purpose = body.purpose as VerificationCodePurpose
  if (purpose !== 'register' && purpose !== 'password_reset') {
    return c.json({ statusCode: 400, message: 'purpose 必须为 register 或 password_reset' }, 400)
  }

  const turnstileError = await validateTurnstile(c.env, body.turnstileToken)
  if (turnstileError) return c.json(turnstileError.body, turnstileError.status)

  // 注册场景：检查邮箱是否已注册
  if (purpose === 'register') {
    const existing = await db
      .prepare('SELECT id FROM users WHERE email = ?')
      .bind(email)
      .first()
    if (existing) {
      return c.json({ statusCode: 409, message: '该邮箱已注册' }, 409)
    }
  }

  // 密码重置场景：不暴露用户是否存在
  if (purpose === 'password_reset') {
    const existing = await db
      .prepare('SELECT id FROM users WHERE email = ?')
      .bind(email)
      .first()
    if (!existing) {
      return c.json({ message: '验证码已发送', cooldown: VERIFICATION_CODE_COOLDOWN_MS / 1000 })
    }
  }

  // 冷却检查
  if (await hasRecentVerificationCode(db, email, purpose)) {
    return c.json({ statusCode: 429, message: '请等待 60 秒后重试' }, 429)
  }

  // 生成验证码
  const code = await createVerificationCode(db, email, purpose)

  // 发送邮件
  try {
    if (purpose === 'register') {
      await sendRegistrationCode(c.env, email, code)
    } else {
      await sendPasswordResetCode(c.env, email, code)
    }
  } catch {
    console.error('[auth.send-code] 邮件发送失败', {
      purpose,
      code: 'AUTH_EMAIL_SEND_FAILED',
    })
    return c.json({ statusCode: 500, message: '邮件发送失败，请稍后重试' }, 500)
  }

  return c.json({ message: '验证码已发送', cooldown: VERIFICATION_CODE_COOLDOWN_MS / 1000 })
})

// ============================================================
// POST /api/auth/register - 用户注册
// ============================================================

authRoutes.post('/register', async (c) => {
  const turnstileConfigError = getTurnstileConfigError(c.env)
  if (turnstileConfigError) return c.json(turnstileConfigError.body, turnstileConfigError.status)

  const body = await c.req.json<{
    email?: string
    password?: string
    username?: string
    nickname?: string
    code?: string
    inviteCode?: string
    analyticsVisitorId?: string
    analyticsSessionId?: string
    sourceChannel?: string
    landingPath?: string
    turnstileToken?: string
    attribution?: RegistrationAttributionContext
  }>()

  // 参数校验
  if (!body.email || !body.password || !body.username) {
    return c.json({ statusCode: 400, message: '邮箱、密码和用户名为必填' }, 400)
  }

  const email = body.email.trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ statusCode: 400, message: '邮箱格式无效' }, 400)
  }

  if (body.password.length < 8) {
    return c.json({ statusCode: 400, message: '密码长度至少 8 位' }, 400)
  }

  // 用户名校验
  const username = body.username.toLowerCase()
  const usernameResult = validateUsername(username)
  if (!usernameResult.valid) {
    return c.json({ statusCode: 400, message: usernameResult.error }, 400)
  }

  const db = c.env.DB

  // 检查邮箱验证开关
  const verificationEnabled = await isEmailVerificationEnabled(db)

  // 邮箱验证码流程已在 send-code 完成人机验证；直接注册仍必须验证。
  if (!verificationEnabled) {
    const turnstileError = await validateTurnstile(c.env, body.turnstileToken)
    if (turnstileError) return c.json(turnstileError.body, turnstileError.status)
  }

  // 邮箱验证开启时需要验证码
  let emailVerified = 0
  if (verificationEnabled) {
    if (!body.code) {
      return c.json({ statusCode: 400, message: '验证码为必填' }, 400)
    }
    const codeValid = await verifyCode(db, email, body.code, 'register')
    if (!codeValid.success) {
      return c.json({ statusCode: 400, message: codeValid.error }, 400)
    }
    emailVerified = 1
  }

  // 检查邮箱唯一性
  const existingEmail = await db
    .prepare('SELECT id FROM users WHERE email = ?')
    .bind(email)
    .first()
  if (existingEmail) {
    return c.json({ statusCode: 409, message: '该邮箱已注册' }, 409)
  }

  // 检查用户名唯一性
  const existingUsername = await db
    .prepare('SELECT id FROM users WHERE username = ?')
    .bind(username)
    .first()
  if (existingUsername) {
    return c.json({ statusCode: 409, message: '该用户名已被使用' }, 409)
  }

  // 创建用户（自增 ID）
  const passwordHash = await hashPassword(body.password)
  const requestedConsentState = normalizeConsentState(
    isPlainRecord(body.attribution)
      ? body.attribution.consentState
      : undefined,
  )
  let consentSnapshot = createAdConsentSnapshot('denied')
  try {
    consentSnapshot = (
      await resolveRequestMarketingConsent(c, requestedConsentState)
    ).consent
  } catch {
    console.warn('[auth.register] 营销授权解析失败，按拒绝状态继续注册', {
      code: 'REGISTRATION_MARKETING_CONSENT_RESOLUTION_FAILED',
    })
  }
  const occurredAt = new Date().toISOString()
  const pagePath = normalizeRegistrationPagePath(
    isPlainRecord(body.attribution)
      ? body.attribution.path
      : body.landingPath,
  )
  const sourceContextToken = readOpaqueAttributionContextToken(c)
  const attributionConsent = {
    marketingAllowed: consentSnapshot.marketingAllowed,
    adUserDataAllowed: consentSnapshot.adUserDataAllowed,
    adPersonalizationAllowed:
      consentSnapshot.adPersonalizationAllowed,
  }
  const hashedEmail = attributionConsent.adUserDataAllowed
    ? await hashAdPlatformEmail(email)
    : undefined
  const transaction = await db.batch([
    db.prepare(
      `INSERT INTO users (email, username, nickname, password_hash, role, status, email_verified)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(email, username, body.nickname?.trim() || null, passwordHash, 'user', 'active', emailVerified),
    buildCompleteRegistrationOutboxStatement(db, {
      occurredAt,
      pagePath,
      sourceContextToken,
      consent: attributionConsent,
      hashedEmail,
    }),
  ])
  const userId = Number(transaction[0]?.meta.last_row_id)
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new Error('REGISTRATION_TRANSACTION_RESULT_INVALID')
  }
  const outboxId = `registration_user_${userId}`
  const attribution = normalizeRegistrationAttribution(body.attribution, userId)
  const hasAttribution = isPlainRecord(body.attribution)

  if (body.inviteCode) {
    try {
      await consumeInviteCodeForRegistration(db, {
        code: body.inviteCode,
        invitedUserId: userId,
        visitorId: hasAttribution ? attribution.visitorId : body.analyticsVisitorId,
        sessionId: hasAttribution ? attribution.sessionId : body.analyticsSessionId,
        sourceChannel: hasAttribution ? attribution.sourceChannel : body.sourceChannel,
        landingPath: hasAttribution ? attribution.path : body.landingPath,
      })
    } catch {
      console.warn('[auth.register] 邀请码注册绑定失败', {
        userId,
        code: 'INVITE_REGISTRATION_BIND_FAILED',
      })
    }
  }

  // 创建会话
  await createSession(c, userId)

  let attributionInstructionToken: string | null = null
  try {
    const dispatch = await dispatchAttributionBusinessOutboxImmediately(
      db,
      createAttributionServiceClient(c.env.ATTRIBUTION),
      outboxId,
    )
    attributionInstructionToken = dispatch.instructionToken
    if (!dispatch.accepted) {
      console.warn('[auth.register] 注册归因等待 outbox 重试', {
        userId,
        code: 'REGISTRATION_ATTRIBUTION_PENDING',
      })
    }
  } catch {
    console.warn('[auth.register] 注册归因即时投递失败，保留 outbox 重试', {
      userId,
      code: 'REGISTRATION_ATTRIBUTION_DISPATCH_FAILED',
    })
  }

  return c.json({
    id: userId,
    email,
    username,
    nickname: body.nickname?.trim() || null,
    role: 'user',
    status: 'active',
    membershipRank: 0,
    membershipExpiry: null,
    attributionInstructionToken,
  }, 201)
})

function normalizeRegistrationAttribution(value: unknown, userId: number) {
  const input = isPlainRecord(value) ? value : {}
  const fallbackId = `registration_user_${userId}`
  return {
    visitorId: normalizeConversionId(input.visitorId) || fallbackId,
    sessionId: normalizeConversionId(input.sessionId) || fallbackId,
    path: normalizeText(input.path, 240),
    sourceChannel: normalizeText(input.sourceChannel, 40) || 'unknown',
  }
}

function readOpaqueAttributionContextToken(
  c: Parameters<typeof getCookie>[0],
): string | null {
  const value = getCookie(c, ATTRIBUTION_CONTEXT_COOKIE)
  return typeof value === 'string'
    && value.length >= 4
    && value.length <= 4_096
    && !/\p{Cc}/u.test(value)
    ? value
    : null
}

function normalizeRegistrationPagePath(value: unknown) {
  const candidate = typeof value === 'string' ? value.trim() : ''
  if (
    candidate.length === 0
    || candidate.length > 2_048
    || !candidate.startsWith('/')
    || candidate.startsWith('//')
    || candidate.includes('\\')
    || candidate.includes('#')
    || /\p{Cc}/u.test(candidate)
  ) return '/register'
  try {
    const base = new URL('https://registration.invalid/')
    const resolved = new URL(candidate, base)
    return resolved.origin === base.origin
      && `${resolved.pathname}${resolved.search}` === candidate
      ? candidate
      : '/register'
  } catch {
    return '/register'
  }
}

function normalizeConversionId(value: unknown) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  return CONVERSION_ID_RE.test(normalized) ? normalized : ''
}

function normalizeConsentState(value: unknown): AnalyticsConsentState {
  return value === 'granted' || value === 'denied' ? value : 'limited'
}

function normalizeText(value: unknown, maxLength: number) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

// ============================================================
// POST /api/auth/reset-password - 密码重置
// ============================================================

authRoutes.post('/reset-password', async (c) => {
  const body = await c.req.json<{
    email?: string
    code?: string
    newPassword?: string
  }>()

  if (!body.email || !body.code || !body.newPassword) {
    return c.json({ statusCode: 400, message: '邮箱、验证码和新密码为必填' }, 400)
  }

  const email = body.email.trim().toLowerCase()

  if (body.newPassword.length < 8) {
    return c.json({ statusCode: 400, message: '密码长度至少 8 位' }, 400)
  }

  const db = c.env.DB

  const codeValid = await verifyCode(db, email, body.code, 'password_reset')
  if (!codeValid.success) {
    return c.json({ statusCode: 400, message: codeValid.error }, 400)
  }

  const user = await db
    .prepare('SELECT id FROM users WHERE email = ?')
    .bind(email)
    .first<{ id: number }>()

  if (!user) {
    return c.json({ statusCode: 404, message: '用户不存在' }, 404)
  }

  const passwordHash = await hashPassword(body.newPassword)
  await db
    .prepare('UPDATE users SET password_hash = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .bind(passwordHash, user.id)
    .run()

  await destroyAllUserSessions(db, user.id)

  return c.json({ message: '密码重置成功，请重新登录' })
})

// ============================================================
// POST /api/auth/login - 用户登录（支持用户名或邮箱）
// ============================================================

authRoutes.post('/login', async (c) => {
  const turnstileConfigError = getTurnstileConfigError(c.env)
  if (turnstileConfigError) return c.json(turnstileConfigError.body, turnstileConfigError.status)

  const body = await c.req.json<{
    identifier?: string  // 用户名或邮箱
    email?: string       // 兼容旧字段
    password?: string
    turnstileToken?: string
  }>()

  // 兼容：优先使用 identifier，回退到 email
  const rawIdentifier = (body.identifier || body.email || '').trim()
  if (!rawIdentifier || !body.password) {
    return c.json({ statusCode: 400, message: '用户名/邮箱和密码为必填' }, 400)
  }

  const turnstileError = await validateTurnstile(c.env, body.turnstileToken)
  if (turnstileError) return c.json(turnstileError.body, turnstileError.status)

  const db = c.env.DB

  // 判断输入是邮箱还是用户名
  const isEmail = rawIdentifier.includes('@')
  const identifier = rawIdentifier.toLowerCase()

  const user = isEmail
    ? await db
        .prepare('SELECT id, email, username, nickname, password_hash, role, status FROM users WHERE email = ?')
        .bind(identifier)
        .first<{ id: number; email: string; username: string | null; nickname: string | null; password_hash: string; role: string; status: string }>()
    : await db
        .prepare('SELECT id, email, username, nickname, password_hash, role, status FROM users WHERE username = ?')
        .bind(identifier)
        .first<{ id: number; email: string; username: string | null; nickname: string | null; password_hash: string; role: string; status: string }>()

  if (!user) {
    return c.json({ statusCode: 401, message: '用户名/邮箱或密码错误' }, 401)
  }

  if (user.status !== 'active') {
    return c.json({ statusCode: 403, message: '账号已被禁用' }, 403)
  }

  const valid = await verifyPassword(body.password, user.password_hash)
  if (!valid) {
    return c.json({ statusCode: 401, message: '用户名/邮箱或密码错误' }, 401)
  }

  await createSession(c, user.id)

  const membership = await db
    .prepare(`
      SELECT MAX(ml.rank) as max_rank, MAX(um.expires_at) as max_expiry
      FROM user_memberships um
      JOIN membership_levels ml ON um.level_id = ml.id
      WHERE um.user_id = ? AND datetime('now') BETWEEN datetime(um.starts_at) AND datetime(um.expires_at)
    `)
    .bind(user.id)
    .first<{ max_rank: number | null; max_expiry: string | null }>()

  return c.json({
    id: user.id,
    email: user.email,
    username: user.username,
    nickname: user.nickname,
    role: user.role,
    status: user.status,
    membershipRank: membership?.max_rank ?? 0,
    membershipExpiry: membership?.max_expiry ?? null,
  })
})

// ============================================================
// POST /api/auth/logout - 登出
// ============================================================

authRoutes.post('/logout', async (c) => {
  const { destroySession } = await import('../utils/session')
  await destroySession(c)
  return c.json({ message: '已登出' })
})
