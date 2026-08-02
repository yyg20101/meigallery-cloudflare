import { Hono, type Context } from 'hono'
import type { Bindings, Variables } from '../index'
import {
  AppAccountAccessError,
  getAppAuthRuntimeConfig,
  loginAppAccount,
  normalizeRegistrationEmail,
  readBearerToken,
  refreshAppSession,
  registerAppAccount,
  requireAppAuthEnabled,
  revokeCurrentAppSession,
  type AppDeviceInput,
  type AppLoginInput,
  type AppRegistrationInput,
} from '../services/app-account-access'
import { sendRegistrationCode } from '../services/email'
import {
  VERIFICATION_CODE_COOLDOWN_MS,
  createVerificationCode,
  hasRecentVerificationCode,
} from '../services/email-verification'
import { appApiError, appApiSuccess } from '../utils/app-api-v2'
import { validateTurnstile } from '../utils/turnstile'

export const appAuthRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()
type AppContext = Context<{ Bindings: Bindings; Variables: Variables }>

appAuthRoutes.post('/email-challenges', async (c) => {
  try {
    const config = getAppAuthRuntimeConfig(c.env)
    requireAppAuthEnabled(config, true)
    const body = await safeJson(c)
    await validateAppChallenge(c.env, textValue(body.challengeToken))
    const email = normalizeRegistrationEmail(body.email)
    const cooldown = VERIFICATION_CODE_COOLDOWN_MS / 1000

    const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?')
      .bind(email)
      .first<{ id: number }>()
    if (existing || await hasRecentVerificationCode(c.env.DB, email, 'register')) {
      return appApiSuccess(c, { accepted: true, cooldownSeconds: cooldown })
    }

    const code = await createVerificationCode(c.env.DB, email, 'register')
    try {
      await sendRegistrationCode(c.env, email, code)
    }
    catch {
      console.error('[app-auth.email-challenge] 注册验证码发送失败', {
        code: 'APP_AUTH_EMAIL_SEND_FAILED',
      })
      throw new AppAccountAccessError(503, 'EMAIL_CHALLENGE_UNAVAILABLE', '邮箱验证暂时不可用', true)
    }
    return appApiSuccess(c, { accepted: true, cooldownSeconds: cooldown })
  }
  catch (error) {
    return appAccountError(c, error)
  }
})

appAuthRoutes.post('/register', async (c) => {
  try {
    const config = getAppAuthRuntimeConfig(c.env)
    requireAppAuthEnabled(config, true)
    const body = await safeJson(c)
    await validateAppChallenge(c.env, textValue(body.challengeToken))
    const result = await registerAppAccount(
      c.env,
      registrationInput(body),
      requestId(c),
    )
    return appApiSuccess(c, result, 201)
  }
  catch (error) {
    return appAccountError(c, error)
  }
})

appAuthRoutes.post('/login', async (c) => {
  try {
    const config = getAppAuthRuntimeConfig(c.env)
    requireAppAuthEnabled(config)
    const body = await safeJson(c)
    await validateAppChallenge(c.env, textValue(body.challengeToken))
    const result = await loginAppAccount(c.env, loginInput(body), requestId(c))
    return appApiSuccess(c, result)
  }
  catch (error) {
    return appAccountError(c, error)
  }
})

appAuthRoutes.post('/refresh', async (c) => {
  try {
    const config = getAppAuthRuntimeConfig(c.env)
    requireAppAuthEnabled(config)
    const body = await safeJson(c)
    const refreshToken = textValue(body.refreshToken)
    if (!refreshToken) {
      throw new AppAccountAccessError(400, 'REFRESH_TOKEN_REQUIRED', '续期凭证为必填')
    }
    return appApiSuccess(
      c,
      await refreshAppSession(
        c.env.DB,
        refreshToken,
        requestId(c),
        new Date(),
        config.documentVersions,
      ),
    )
  }
  catch (error) {
    return appAccountError(c, error)
  }
})

appAuthRoutes.post('/logout', async (c) => {
  try {
    const config = getAppAuthRuntimeConfig(c.env)
    requireAppAuthEnabled(config)
    const accessToken = readBearerToken(c.req.header('Authorization'))
    await revokeCurrentAppSession(c.env.DB, accessToken, requestId(c))
    return appApiSuccess(c, { loggedOut: true })
  }
  catch (error) {
    return appAccountError(c, error)
  }
})

export function appAccountError(c: AppContext, error: unknown) {
  if (error instanceof AppAccountAccessError) {
    return appApiError(c, error.status, error.code, error.message, error.retryable)
  }
  throw error
}

async function validateAppChallenge(env: Bindings, token: string): Promise<void> {
  const validation = await validateTurnstile(env, token || undefined)
  if (!validation) return
  if (validation.status === 503) {
    throw new AppAccountAccessError(503, 'CHALLENGE_UNAVAILABLE', '人机验证暂时不可用', true)
  }
  throw new AppAccountAccessError(400, 'CHALLENGE_FAILED', '请完成人机验证后重试')
}

async function safeJson(c: AppContext): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json<unknown>()
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('INVALID_JSON_OBJECT')
    return body as Record<string, unknown>
  }
  catch {
    throw new AppAccountAccessError(400, 'INVALID_REQUEST', '请求内容格式无效')
  }
}

function registrationInput(body: Record<string, unknown>): AppRegistrationInput {
  const consents = recordValue(body.consents)
  return {
    email: textValue(body.email),
    password: textValue(body.password),
    nickname: nullableTextValue(body.nickname),
    verificationCode: textValue(body.verificationCode),
    consents: {
      termsVersion: textValue(consents.termsVersion),
      privacyVersion: textValue(consents.privacyVersion),
      platformOperationVersion: textValue(consents.platformOperationVersion),
      eligibilityVersion: textValue(consents.eligibilityVersion),
      eligibilityConfirmed: consents.eligibilityConfirmed === true,
    },
    device: deviceInput(recordValue(body.device)),
  }
}

function loginInput(body: Record<string, unknown>): AppLoginInput {
  const rawConsents = recordValue(body.consents)
  const consents = Object.keys(rawConsents).length > 0
    ? {
        termsVersion: textValue(rawConsents.termsVersion),
        privacyVersion: textValue(rawConsents.privacyVersion),
        platformOperationVersion: textValue(rawConsents.platformOperationVersion),
        eligibilityVersion: textValue(rawConsents.eligibilityVersion),
        eligibilityConfirmed: rawConsents.eligibilityConfirmed === true,
      }
    : undefined
  return {
    email: textValue(body.email),
    password: textValue(body.password),
    device: deviceInput(recordValue(body.device)),
    consents,
  }
}

function deviceInput(value: Record<string, unknown>): AppDeviceInput {
  return {
    installationId: textValue(value.installationId),
    platform: textValue(value.platform) as AppDeviceInput['platform'],
    displayName: textValue(value.displayName),
    appVersion: textValue(value.appVersion),
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function nullableTextValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function requestId(c: AppContext): string {
  return c.get('appRequestId') || crypto.randomUUID()
}
