import { describe, expect, it } from 'vitest'
import type { Bindings } from '../index'
import { getAppAuthRuntimeConfig } from './app-account-access'

describe('App Auth 运行时配置门禁', () => {
  it('配置完整的 production 才启用并公开安全正文 URL', () => {
    const config = getAppAuthRuntimeConfig(completeEnv())

    expect(config.enabled).toBe(true)
    expect(config.registrationEnabled).toBe(true)
    expect(config.documentUrls).toEqual({
      terms: 'https://legal.example.com/terms',
      privacy: 'https://legal.example.com/privacy',
      platformOperation: 'https://legal.example.com/platform-operation',
      eligibility: 'https://legal.example.com/eligibility',
    })
    expect(config.challenge).toMatchObject({
      type: 'turnstile',
      pagePath: '/api/v2/auth/turnstile',
      resultPath: '/api/v2/auth/turnstile/result',
    })
  })

  it('production 的 HTTP 正文 URL 或单边 Turnstile 配置均 fail closed', () => {
    expect(getAppAuthRuntimeConfig(completeEnv({
      APP_AUTH_TERMS_URL: 'http://legal.example.com/terms',
    })).enabled).toBe(false)
    expect(getAppAuthRuntimeConfig(completeEnv({
      TURNSTILE_SECRET_KEY: '',
    })).enabled).toBe(false)
  })

  it('本地仅额外允许受控回环与 Android 模拟器 HTTP 地址', () => {
    const local = completeEnv({
      APP_ENV: 'local',
      TURNSTILE_SECRET_KEY: '',
      APP_AUTH_TURNSTILE_SITE_KEY: undefined,
      APP_AUTH_TERMS_URL: 'http://10.0.2.2:3000/terms',
      APP_AUTH_PRIVACY_URL: 'http://127.0.0.1:3000/privacy',
      APP_AUTH_PLATFORM_NOTICE_URL: 'http://localhost:3000/platform-operation',
      APP_AUTH_ELIGIBILITY_URL: 'https://legal.example.com/eligibility',
    })
    expect(getAppAuthRuntimeConfig(local).enabled).toBe(true)

    expect(getAppAuthRuntimeConfig({
      ...local,
      APP_AUTH_TERMS_URL: 'http://192.0.2.10/terms',
    }).enabled).toBe(false)
  })
})

function completeEnv(overrides: Partial<Bindings> = {}) {
  return {
    APP_ENV: 'production',
    APP_AUTH_ENABLED: 'true',
    APP_AUTH_REGISTRATION_ENABLED: 'true',
    APP_AUTH_TERMS_VERSION: 'terms-v1',
    APP_AUTH_PRIVACY_VERSION: 'privacy-v1',
    APP_AUTH_PLATFORM_NOTICE_VERSION: 'operation-v1',
    APP_AUTH_ELIGIBILITY_VERSION: 'eligibility-v1',
    APP_AUTH_TERMS_URL: 'https://legal.example.com/terms',
    APP_AUTH_PRIVACY_URL: 'https://legal.example.com/privacy',
    APP_AUTH_PLATFORM_NOTICE_URL: 'https://legal.example.com/platform-operation',
    APP_AUTH_ELIGIBILITY_URL: 'https://legal.example.com/eligibility',
    APP_AUTH_TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
    TURNSTILE_SECRET_KEY: 'test-secret',
    ...overrides,
  } as Pick<
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
  >
}
