import type { Bindings } from '../index'

export type TurnstileValidationError = {
  status: 400 | 503
  body: {
    statusCode: number
    message: string
  }
}

type TurnstileEnv = Pick<Bindings, 'APP_ENV' | 'TURNSTILE_SECRET_KEY'>

export function getTurnstileConfigError(env: TurnstileEnv): TurnstileValidationError | null {
  if (env.APP_ENV === 'production' && !env.TURNSTILE_SECRET_KEY) {
    return {
      status: 503,
      body: { statusCode: 503, message: '人机验证配置缺失，请联系站点管理员' },
    }
  }
  return null
}

export async function validateTurnstile(env: TurnstileEnv, token?: string): Promise<TurnstileValidationError | null> {
  const configError = getTurnstileConfigError(env)
  if (configError) return configError
  if (!env.TURNSTILE_SECRET_KEY) return null

  if (!token) {
    return {
      status: 400,
      body: { statusCode: 400, message: '请完成人机验证' },
    }
  }

  const verified = await verifyTurnstileToken(env.TURNSTILE_SECRET_KEY, token)
  if (!verified) {
    return {
      status: 400,
      body: { statusCode: 400, message: '人机验证失败，请重试' },
    }
  }

  return null
}

export async function verifyTurnstileToken(secretKey: string, token: string): Promise<boolean> {
  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: secretKey, response: token }),
  })
  const result = await response.json() as { success: boolean; 'error-codes'?: string[] }
  if (!result.success) {
    console.warn('Turnstile 验证失败:', result['error-codes'] ?? [])
  }
  return result.success
}
