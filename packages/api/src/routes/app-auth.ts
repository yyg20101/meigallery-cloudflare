import { Hono, type Context } from 'hono'
import type { Bindings, Variables } from '../index'
import {
  AppAccountAccessError,
  APP_TURNSTILE_RESULT_PATH,
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

const APP_CHALLENGE_ACTIONS = {
  email_challenge: 'app_email_challenge',
  register: 'app_register',
  login: 'app_login',
} as const

type AppChallengePurpose = keyof typeof APP_CHALLENGE_ACTIONS

appAuthRoutes.get('/turnstile', (c) => {
  try {
    const config = getAppAuthRuntimeConfig(c.env)
    requireAppAuthEnabled(config)
    if (config.challenge.type !== 'turnstile') {
      throw new AppAccountAccessError(
        503,
        'CHALLENGE_UNAVAILABLE',
        '人机验证尚未完成配置',
        true,
      )
    }
    const purpose = parseChallengePurpose(c.req.query('purpose'))
    if (!purpose) return invalidChallengePage(c)
    const nonce = createCspNonce()
    applyChallengePageHeaders(c, nonce)
    return c.html(turnstileChallengePage({
      nonce,
      siteKey: config.challenge.siteKey,
      action: APP_CHALLENGE_ACTIONS[purpose],
      resultPath: config.challenge.resultPath,
    }))
  }
  catch (error) {
    return appAccountError(c, error)
  }
})

appAuthRoutes.get('/turnstile/result', (c) => {
  const nonce = createCspNonce()
  applyChallengePageHeaders(c, nonce, false)
  return c.html(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <title>验证结果</title>
  <style nonce="${nonce}">body{margin:0;background:#fff8f9;color:#2b1a20;font:16px system-ui,sans-serif;display:grid;min-height:100vh;place-items:center}.card{margin:24px;padding:24px;border:1px solid #f1dde4;border-radius:20px;background:#fff;text-align:center}.hint{margin-top:8px;color:#80656e;font-size:14px}</style>
</head>
<body><main class="card"><strong>验证结果已接收</strong><div class="hint">请返回 MeiGallery App 继续操作。</div></main></body>
</html>`)
})

appAuthRoutes.post('/email-challenges', async (c) => {
  try {
    const config = getAppAuthRuntimeConfig(c.env)
    requireAppAuthEnabled(config, true)
    const body = await safeJson(c)
    await validateAppChallenge(c, textValue(body.challengeToken), 'app_email_challenge')
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
    await validateAppChallenge(c, textValue(body.challengeToken), 'app_register')
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
    await validateAppChallenge(c, textValue(body.challengeToken), 'app_login')
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

async function validateAppChallenge(
  c: AppContext,
  token: string,
  expectedAction: (typeof APP_CHALLENGE_ACTIONS)[AppChallengePurpose],
): Promise<void> {
  const validation = await validateTurnstile(c.env, token || undefined, {
    remoteIp: c.req.header('CF-Connecting-IP'),
    expectedAction,
    expectedHostname: c.env.APP_ENV === 'production'
      ? new URL(c.req.url).hostname
      : undefined,
  })
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

function parseChallengePurpose(value: string | undefined): AppChallengePurpose | null {
  return value && Object.prototype.hasOwnProperty.call(APP_CHALLENGE_ACTIONS, value)
    ? value as AppChallengePurpose
    : null
}

function createCspNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18))
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/gu, '')
}

function applyChallengePageHeaders(c: AppContext, nonce: string, allowTurnstile = true): void {
  const turnstileOrigin = 'https://challenges.cloudflare.com'
  const policy = allowTurnstile
    ? [
        "default-src 'none'",
        `script-src 'nonce-${nonce}' ${turnstileOrigin}`,
        `style-src 'nonce-${nonce}'`,
        `frame-src ${turnstileOrigin}`,
        `connect-src ${turnstileOrigin}`,
        "img-src data:",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
      ]
    : [
        "default-src 'none'",
        `style-src 'nonce-${nonce}'`,
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
      ]
  c.header('Content-Security-Policy', policy.join('; '))
  c.header('Cache-Control', 'no-store, max-age=0')
  c.header('Pragma', 'no-cache')
  c.header('Referrer-Policy', 'no-referrer')
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()')
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('X-Frame-Options', 'DENY')
}

function invalidChallengePage(c: AppContext) {
  const nonce = createCspNonce()
  applyChallengePageHeaders(c, nonce, false)
  return c.html(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>验证请求无效</title><style nonce="${nonce}">body{font:16px system-ui,sans-serif;padding:24px;color:#2b1a20;background:#fff8f9}</style></head><body>验证用途无效，请返回 App 重试。</body></html>`, 400)
}

function turnstileChallengePage(input: {
  nonce: string
  siteKey: string
  action: string
  resultPath: typeof APP_TURNSTILE_RESULT_PATH
}): string {
  const siteKey = JSON.stringify(input.siteKey)
  const action = JSON.stringify(input.action)
  const resultPath = JSON.stringify(input.resultPath)
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover">
  <title>安全验证</title>
  <style nonce="${input.nonce}">:root{color-scheme:light}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#fff8f9;color:#2b1a20;font:16px system-ui,-apple-system,sans-serif;display:grid;place-items:center}.card{width:min(100% - 32px,420px);padding:24px;border:1px solid #f1dde4;border-radius:24px;background:#fff;box-shadow:0 12px 40px rgba(98,45,65,.08)}h1{margin:0;font-size:20px}.hint{margin:8px 0 20px;color:#80656e;font-size:14px;line-height:1.6}#turnstile-container{min-height:68px;display:grid;place-items:center}.privacy{margin:18px 0 0;color:#a5838e;font-size:12px;line-height:1.5;text-align:center}</style>
  <script nonce="${input.nonce}">
    window.__meigalleryTurnstileReady = function () {
      turnstile.render('#turnstile-container', {
        sitekey: ${siteKey},
        action: ${action},
        callback: function (token) {
          if (typeof token !== 'string' || token.length === 0 || token.length > 2048) {
            location.replace(${resultPath} + '?status=error');
            return;
          }
          location.replace(${resultPath} + '?status=success#' + encodeURIComponent(token));
        },
        'error-callback': function () { location.replace(${resultPath} + '?status=error'); },
        'timeout-callback': function () { location.replace(${resultPath} + '?status=timeout'); },
        'expired-callback': function () { location.replace(${resultPath} + '?status=expired'); }
      });
    };
  </script>
  <script nonce="${input.nonce}" src="https://challenges.cloudflare.com/turnstile/v0/api.js?onload=__meigalleryTurnstileReady&amp;render=explicit" async defer></script>
</head>
<body>
  <main class="card">
    <h1>完成安全验证</h1>
    <p class="hint">验证完成后会自动返回 App。请勿关闭当前页面。</p>
    <div id="turnstile-container" aria-live="polite"></div>
    <p class="privacy">验证凭证只用于当前一次账号操作，不会保存在设备中。</p>
  </main>
</body>
</html>`
}
