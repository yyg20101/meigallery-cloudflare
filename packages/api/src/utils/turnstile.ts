import type { Bindings } from '../index'

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
// Cloudflare 官方公开的 always-pass 测试密钥；仅用于 APP_ENV=local 的端到端联调。
const CLOUDFLARE_ALWAYS_PASS_TEST_SECRET = '1x0000000000000000000000000000000AA'
const CLOUDFLARE_TEST_ACTION = 'test'
const TURNSTILE_TOKEN_MAX_LENGTH = 2048
const SITEVERIFY_RESPONSE_MAX_LENGTH = 32 * 1024
const REMOTE_IP_PATTERN = /^[0-9A-Fa-f:.]{3,45}$/u

export type TurnstileValidationError = {
  status: 400 | 503
  body: {
    statusCode: number
    message: string
  }
}

export type TurnstileValidationOptions = {
  remoteIp?: string
  expectedAction?: string
  expectedHostname?: string
}

type TurnstileEnv = Pick<Bindings, 'APP_ENV' | 'TURNSTILE_SECRET_KEY'>

type SiteverifyResponse = {
  success?: boolean
  action?: string | null
  hostname?: string
  'error-codes'?: string[]
}

export type TurnstileVerificationResult =
  | { status: 'verified' }
  | { status: 'rejected'; reason: 'provider' | 'action' | 'hostname' }
  | { status: 'unavailable' }

export function getTurnstileConfigError(env: TurnstileEnv): TurnstileValidationError | null {
  if (env.APP_ENV === 'production' && !env.TURNSTILE_SECRET_KEY?.trim()) {
    return unavailableError('人机验证配置缺失，请联系站点管理员')
  }
  return null
}

export async function validateTurnstile(
  env: TurnstileEnv,
  token?: string,
  options: TurnstileValidationOptions = {},
): Promise<TurnstileValidationError | null> {
  const configError = getTurnstileConfigError(env)
  if (configError) return configError
  const secretKey = env.TURNSTILE_SECRET_KEY?.trim()
  if (!secretKey) return null

  const normalizedToken = token?.trim() ?? ''
  if (!normalizedToken || normalizedToken.length > TURNSTILE_TOKEN_MAX_LENGTH) {
    return rejectedError('请完成人机验证')
  }

  const allowCloudflareTestAction = env.APP_ENV === 'local'
    && secretKey === CLOUDFLARE_ALWAYS_PASS_TEST_SECRET
  const result = await verifyTurnstileTokenInternal(
    secretKey,
    normalizedToken,
    options,
    allowCloudflareTestAction,
  )
  if (result.status === 'verified') return null
  if (result.status === 'unavailable') {
    return unavailableError('人机验证暂时不可用，请稍后重试')
  }
  return rejectedError('人机验证失败，请重试')
}

export async function verifyTurnstileToken(
  secretKey: string,
  token: string,
  options: TurnstileValidationOptions = {},
): Promise<TurnstileVerificationResult> {
  return verifyTurnstileTokenInternal(secretKey, token, options, false)
}

async function verifyTurnstileTokenInternal(
  secretKey: string,
  token: string,
  options: TurnstileValidationOptions,
  allowCloudflareTestAction: boolean,
): Promise<TurnstileVerificationResult> {
  const remoteIp = options.remoteIp?.trim()
  const payload: Record<string, string> = {
    secret: secretKey,
    response: token,
    idempotency_key: crypto.randomUUID(),
  }
  if (remoteIp && REMOTE_IP_PATTERN.test(remoteIp)) payload.remoteip = remoteIp

  let response: Response
  try {
    response = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  }
  catch {
    console.warn('[turnstile.verify] Siteverify 网络不可用', {
      code: 'TURNSTILE_SITEVERIFY_NETWORK_ERROR',
    })
    return { status: 'unavailable' }
  }

  if (!response.ok) {
    console.warn('[turnstile.verify] Siteverify 返回非成功状态', {
      code: 'TURNSTILE_SITEVERIFY_HTTP_ERROR',
      status: response.status,
    })
    return { status: 'unavailable' }
  }

  let result: SiteverifyResponse
  try {
    const raw = await response.text()
    if (!raw || raw.length > SITEVERIFY_RESPONSE_MAX_LENGTH) throw new Error('INVALID_RESPONSE_SIZE')
    result = JSON.parse(raw) as SiteverifyResponse
  }
  catch {
    console.warn('[turnstile.verify] Siteverify 响应无法解析', {
      code: 'TURNSTILE_SITEVERIFY_INVALID_RESPONSE',
    })
    return { status: 'unavailable' }
  }

  if (result.success !== true) {
    console.warn('[turnstile.verify] 人机验证被服务商拒绝', {
      code: 'TURNSTILE_PROVIDER_REJECTED',
      providerCodes: normalizeProviderCodes(result['error-codes']),
    })
    return { status: 'rejected', reason: 'provider' }
  }

  const officialLocalTestActionMatches = allowCloudflareTestAction
    && (result.action == null || result.action === CLOUDFLARE_TEST_ACTION)
  const actionMatches = !options.expectedAction
    || result.action === options.expectedAction
    || officialLocalTestActionMatches
  if (!actionMatches) {
    console.warn('[turnstile.verify] action 不匹配', {
      code: 'TURNSTILE_ACTION_MISMATCH',
      expectedAction: options.expectedAction,
      actualAction: typeof result.action === 'string' ? result.action.slice(0, 40) : null,
      localTestActionAllowed: allowCloudflareTestAction,
    })
    return { status: 'rejected', reason: 'action' }
  }

  if (
    options.expectedHostname
    && result.hostname?.toLowerCase() !== options.expectedHostname.trim().toLowerCase()
  ) {
    console.warn('[turnstile.verify] hostname 不匹配', {
      code: 'TURNSTILE_HOSTNAME_MISMATCH',
    })
    return { status: 'rejected', reason: 'hostname' }
  }

  return { status: 'verified' }
}

function normalizeProviderCodes(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.slice(0, 80))
    .slice(0, 8)
}

function rejectedError(message: string): TurnstileValidationError {
  return {
    status: 400,
    body: { statusCode: 400, message },
  }
}

function unavailableError(message: string): TurnstileValidationError {
  return {
    status: 503,
    body: { statusCode: 503, message },
  }
}
