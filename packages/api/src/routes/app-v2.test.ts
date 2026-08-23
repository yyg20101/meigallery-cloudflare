import type { AppBootstrapConfig } from '@meigallery/shared'
import { readFileSync } from 'node:fs'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { Bindings, Variables } from '../index'
import { appV2Routes } from './app-v2'

function createApp(db: unknown = {}, overrides: Partial<Bindings> = {}) {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()
  app.use('*', async (c, next) => {
    c.set('appRequestId', 'req_app_test')
    await next()
  })
  app.route('/api/v2', appV2Routes)
  return {
    app,
    env: {
      DB: db,
      APP_ENV: 'development',
      ...overrides,
    } as unknown as Bindings,
  }
}

describe('App API v2 路由契约', () => {
  it('bootstrap 默认关闭未配置的登录、消息、支付和系统推送能力', async () => {
    const { app, env } = createApp()
    const response = await app.fetch(
      new Request('https://api.test/api/v2/app/bootstrap'),
      env,
      {} as ExecutionContext,
    )
    const body = await response.json<{
      data: AppBootstrapConfig
      meta: { requestId: string; apiVersion: string; contractVersion: string }
    }>()

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-contract-version')).toBe('1.26.0')
    expect(body.data.capabilities).toMatchObject({
      discovery: true,
      auth: false,
      messaging: false,
      notifications: false,
      realtime: false,
      wallet: false,
      payments: false,
      systemPush: false,
    })
    expect(body.meta).toMatchObject({
      requestId: 'req_app_test',
      apiVersion: '2',
      contractVersion: '1.26.0',
    })
  })

  it('Wallet-1 使用独立开关且明确关闭全部交易能力', async () => {
    const configured = createApp({}, {
      APP_AUTH_ENABLED: 'true',
      APP_AUTH_TERMS_VERSION: 'terms-1',
      APP_AUTH_PRIVACY_VERSION: 'privacy-1',
      APP_AUTH_PLATFORM_NOTICE_VERSION: 'platform-1',
      APP_AUTH_ELIGIBILITY_VERSION: 'eligibility-1',
      APP_AUTH_TERMS_URL: 'https://legal.test/terms',
      APP_AUTH_PRIVACY_URL: 'https://legal.test/privacy',
      APP_AUTH_PLATFORM_NOTICE_URL: 'https://legal.test/platform',
      APP_AUTH_ELIGIBILITY_URL: 'https://legal.test/eligibility',
      APP_WALLET_ENABLED: 'true',
      APP_WALLET_POLICY_VERSION: 'wlp_app_1_0_wallet_1_dev_1',
    })
    const response = await configured.app.fetch(
      new Request('https://api.test/api/v2/app/bootstrap'),
      configured.env,
      {} as ExecutionContext,
    )
    expect(await response.json()).toMatchObject({
      data: {
        capabilities: { wallet: true, payments: false },
        wallet: {
          policyVersion: 'wlp_app_1_0_wallet_1_dev_1',
          currencyCode: 'mei_coin',
          displayName: '金币',
          minorUnit: 0,
          maxPageSize: 40,
          directions: ['credit', 'debit'],
          payments: false,
          recharge: false,
          spending: false,
          transfer: false,
          withdrawal: false,
        },
      },
    })

    const production = createApp({}, {
      ...configured.env,
      APP_ENV: 'production',
      APP_WALLET_PRODUCTION_READY: 'false',
    })
    const productionResponse = await production.app.fetch(
      new Request('https://api.test/api/v2/app/bootstrap'),
      production.env,
      {} as ExecutionContext,
    )
    expect(await productionResponse.json()).toMatchObject({
      data: { capabilities: { wallet: false } },
    })
  })

  it('站内通知使用独立开关、HTTP pull 与生产门禁', async () => {
    const auth = {
      APP_AUTH_ENABLED: 'true',
      APP_AUTH_TERMS_VERSION: 'terms-1',
      APP_AUTH_PRIVACY_VERSION: 'privacy-1',
      APP_AUTH_PLATFORM_NOTICE_VERSION: 'platform-1',
      APP_AUTH_ELIGIBILITY_VERSION: 'eligibility-1',
      APP_AUTH_TERMS_URL: 'https://legal.test/terms',
      APP_AUTH_PRIVACY_URL: 'https://legal.test/privacy',
      APP_AUTH_PLATFORM_NOTICE_URL: 'https://legal.test/platform',
      APP_AUTH_ELIGIBILITY_URL: 'https://legal.test/eligibility',
      APP_NOTIFICATIONS_ENABLED: 'true',
      APP_NOTIFICATIONS_POLICY_VERSION: 'ntp_app_1_0_message_3_dev_1',
    } satisfies Partial<Bindings>
    const development = createApp({}, auth)
    const response = await development.app.fetch(
      new Request('https://api.test/api/v2/app/bootstrap'),
      development.env,
      {} as ExecutionContext,
    )
    expect(await response.json()).toMatchObject({
      data: {
        capabilities: { notifications: true, systemPush: false },
        notifications: {
          policyVersion: 'ntp_app_1_0_message_3_dev_1',
          transport: 'http_pull',
          maxPageSize: 40,
          categories: [
            { code: 'message', preference: 'optional' },
            { code: 'interaction', preference: 'optional' },
            { code: 'membership_coin', preference: 'required' },
            { code: 'system_security', preference: 'required' },
            { code: 'marketing', preference: 'optional' },
          ],
        },
      },
    })

    const production = createApp({}, {
      ...auth,
      APP_ENV: 'production',
      APP_NOTIFICATIONS_PRODUCTION_READY: 'false',
    })
    const productionResponse = await production.app.fetch(
      new Request('https://api.test/api/v2/app/bootstrap'),
      production.env,
      {} as ExecutionContext,
    )
    expect(await productionResponse.json()).toMatchObject({
      data: { capabilities: { notifications: false } },
    })
  })

  it('消息能力只有在账号、会员、用户消息和生产门禁同时满足时才开放', async () => {
    const development = createApp({}, {
      APP_AUTH_ENABLED: 'true',
      APP_AUTH_TERMS_VERSION: 'terms-1',
      APP_AUTH_PRIVACY_VERSION: 'privacy-1',
      APP_AUTH_PLATFORM_NOTICE_VERSION: 'platform-1',
      APP_AUTH_ELIGIBILITY_VERSION: 'eligibility-1',
      APP_AUTH_TERMS_URL: 'https://legal.test/terms',
      APP_AUTH_PRIVACY_URL: 'https://legal.test/privacy',
      APP_AUTH_PLATFORM_NOTICE_URL: 'https://legal.test/platform',
      APP_AUTH_ELIGIBILITY_URL: 'https://legal.test/eligibility',
      APP_MEMBERSHIP_ENABLED: 'true',
      APP_MEMBERSHIP_CATALOG_VERSION: 'amc_app_1_0_message_1_dev_1',
      APP_MESSAGING_ENABLED: 'true',
      APP_MESSAGING_DISCLOSURE_VERSION: 'managed_message_1',
      APP_SAFETY_ENABLED: 'true',
      APP_SAFETY_REASON_CATALOG_VERSION: 'src_app_1_0_message_2_dev_1',
    })
    const developmentResponse = await development.app.fetch(
      new Request('https://api.test/api/v2/app/bootstrap'),
      development.env,
      {} as ExecutionContext,
    )
    expect(await developmentResponse.json()).toMatchObject({
      data: {
        capabilities: {
          messaging: true,
          safety: { reports: true, blocks: true, conversationClose: true, appeals: false },
        },
      },
    })

    const production = createApp({}, {
      APP_ENV: 'production',
      APP_AUTH_ENABLED: 'true',
      APP_AUTH_TERMS_VERSION: 'terms-1',
      APP_AUTH_PRIVACY_VERSION: 'privacy-1',
      APP_AUTH_PLATFORM_NOTICE_VERSION: 'platform-1',
      APP_AUTH_ELIGIBILITY_VERSION: 'eligibility-1',
      APP_AUTH_TERMS_URL: 'https://legal.test/terms',
      APP_AUTH_PRIVACY_URL: 'https://legal.test/privacy',
      APP_AUTH_PLATFORM_NOTICE_URL: 'https://legal.test/platform',
      APP_AUTH_ELIGIBILITY_URL: 'https://legal.test/eligibility',
      APP_MEMBERSHIP_ENABLED: 'true',
      APP_MEMBERSHIP_CATALOG_VERSION: 'amc_app_1_0_message_1_dev_1',
      APP_MEMBERSHIP_PRODUCTION_READY: 'true',
      APP_MESSAGING_ENABLED: 'true',
      APP_MESSAGING_DISCLOSURE_VERSION: 'managed_message_1',
      APP_MESSAGING_PRODUCTION_READY: 'false',
      APP_SAFETY_ENABLED: 'true',
      APP_SAFETY_REASON_CATALOG_VERSION: 'src_app_1_0_message_2_dev_1',
      APP_SAFETY_PRODUCTION_READY: 'false',
    })
    const productionResponse = await production.app.fetch(
      new Request('https://api.test/api/v2/app/bootstrap'),
      production.env,
      {} as ExecutionContext,
    )
    expect(await productionResponse.json()).toMatchObject({
      data: { capabilities: { messaging: false } },
    })
  })

  it('Safety-2 申诉能力使用独立开关且生产要求单独发布门禁', async () => {
    const base = {
      APP_AUTH_ENABLED: 'true',
      APP_AUTH_TERMS_VERSION: 'terms-1',
      APP_AUTH_PRIVACY_VERSION: 'privacy-1',
      APP_AUTH_PLATFORM_NOTICE_VERSION: 'platform-1',
      APP_AUTH_ELIGIBILITY_VERSION: 'eligibility-1',
      APP_AUTH_TERMS_URL: 'https://legal.test/terms',
      APP_AUTH_PRIVACY_URL: 'https://legal.test/privacy',
      APP_AUTH_PLATFORM_NOTICE_URL: 'https://legal.test/platform',
      APP_AUTH_ELIGIBILITY_URL: 'https://legal.test/eligibility',
      APP_SAFETY_ENABLED: 'true',
      APP_SAFETY_REASON_CATALOG_VERSION: 'src_app_1_0_message_2_dev_1',
      APP_SAFETY_APPEALS_ENABLED: 'true',
      APP_SAFETY_APPEAL_POLICY_VERSION: 'sap_app_1_0_safety_2_dev_1',
    } satisfies Partial<Bindings>
    const development = createApp({}, base)
    const developmentResponse = await development.app.fetch(
      new Request('https://api.test/api/v2/app/bootstrap'),
      development.env,
      {} as ExecutionContext,
    )
    expect(await developmentResponse.json()).toMatchObject({
      data: {
        capabilities: { safety: { appeals: true } },
        safety: {
          appealPolicyVersion: 'sap_app_1_0_safety_2_dev_1',
          maxAppealStatementLength: 500,
        },
      },
    })

    const production = createApp({}, {
      ...base,
      APP_ENV: 'production',
      APP_SAFETY_PRODUCTION_READY: 'true',
      APP_SAFETY_APPEALS_PRODUCTION_READY: 'false',
    })
    const productionResponse = await production.app.fetch(
      new Request('https://api.test/api/v2/app/bootstrap'),
      production.env,
      {} as ExecutionContext,
    )
    expect(await productionResponse.json()).toMatchObject({
      data: { capabilities: { safety: { appeals: false } } },
    })
  })

  it('会员目录和本人权益使用独立开关，生产环境还要求显式通过发布门禁', async () => {
    const development = createApp({}, {
      APP_MEMBERSHIP_ENABLED: 'true',
      APP_MEMBERSHIP_CATALOG_VERSION: 'amc_app_1_0_draft_1',
    })
    const developmentResponse = await development.app.fetch(
      new Request('https://api.test/api/v2/app/bootstrap'),
      development.env,
      {} as ExecutionContext,
    )
    expect(await developmentResponse.json()).toMatchObject({
      data: {
        capabilities: {
          membership: {
            catalog: true,
            entitlements: false,
            applications: false,
          },
        },
      },
    })

    const disabledCatalog = createApp()
    const disabledResponse = await disabledCatalog.app.fetch(
      new Request('https://api.test/api/v2/membership/catalog'),
      disabledCatalog.env,
      {} as ExecutionContext,
    )
    expect(disabledResponse.status).toBe(403)
    expect(await disabledResponse.json()).toMatchObject({
      error: { code: 'FEATURE_DISABLED', retryable: false },
    })

    const production = createApp({}, {
      APP_ENV: 'production',
      APP_MEMBERSHIP_ENABLED: 'true',
      APP_MEMBERSHIP_CATALOG_VERSION: 'amc_app_1_0_draft_1',
      APP_MEMBERSHIP_PRODUCTION_READY: 'false',
    })
    const productionResponse = await production.app.fetch(
      new Request('https://api.test/api/v2/app/bootstrap'),
      production.env,
      {} as ExecutionContext,
    )
    expect(await productionResponse.json()).toMatchObject({
      data: { capabilities: { membership: { catalog: false, entitlements: false } } },
    })
  })

  it('站内会员申请还要求登录与独立开关，并下发不承诺时效的服务说明', async () => {
    const configured = createApp({}, {
      APP_AUTH_ENABLED: 'true',
      APP_AUTH_TERMS_VERSION: 'terms-1',
      APP_AUTH_PRIVACY_VERSION: 'privacy-1',
      APP_AUTH_PLATFORM_NOTICE_VERSION: 'platform-1',
      APP_AUTH_ELIGIBILITY_VERSION: 'eligibility-1',
      APP_AUTH_TERMS_URL: 'https://legal.test/terms',
      APP_AUTH_PRIVACY_URL: 'https://legal.test/privacy',
      APP_AUTH_PLATFORM_NOTICE_URL: 'https://legal.test/platform',
      APP_AUTH_ELIGIBILITY_URL: 'https://legal.test/eligibility',
      APP_MEMBERSHIP_ENABLED: 'true',
      APP_MEMBERSHIP_APPLICATIONS_ENABLED: 'true',
      APP_MEMBERSHIP_CATALOG_VERSION: 'amc_app_1_0_draft_1',
    })
    const response = await configured.app.fetch(
      new Request('https://api.test/api/v2/app/bootstrap'),
      configured.env,
      {} as ExecutionContext,
    )
    expect(await response.json()).toMatchObject({
      data: {
        capabilities: {
          membership: { catalog: true, entitlements: true, applications: true },
        },
        membershipApplications: {
          disclosureVersion: 'membership-application-development-1',
          contactMethod: 'verified_email',
          maxStatementLength: 300,
          contactWindows: [
            { code: 'anytime', label: '时间不限' },
            { code: 'morning', label: '上午' },
            { code: 'afternoon', label: '下午' },
            { code: 'evening', label: '晚间' },
          ],
        },
      },
    })

    const withoutAuth = createApp({}, {
      APP_MEMBERSHIP_ENABLED: 'true',
      APP_MEMBERSHIP_APPLICATIONS_ENABLED: 'true',
      APP_MEMBERSHIP_CATALOG_VERSION: 'amc_app_1_0_draft_1',
    })
    const disabledResponse = await withoutAuth.app.fetch(
      new Request('https://api.test/api/v2/app/bootstrap'),
      withoutAuth.env,
      {} as ExecutionContext,
    )
    expect(await disabledResponse.json()).toMatchObject({
      data: { capabilities: { membership: { applications: false } } },
    })
  })

  it('只在账号配置完整时开放喜欢与关注，未开放时路由拒绝访问', async () => {
    const configured = createApp({}, {
      APP_AUTH_ENABLED: 'true',
      APP_AUTH_TERMS_VERSION: 'terms-1',
      APP_AUTH_PRIVACY_VERSION: 'privacy-1',
      APP_AUTH_PLATFORM_NOTICE_VERSION: 'platform-1',
      APP_AUTH_ELIGIBILITY_VERSION: 'eligibility-1',
      APP_AUTH_TERMS_URL: 'https://legal.test/terms',
      APP_AUTH_PRIVACY_URL: 'https://legal.test/privacy',
      APP_AUTH_PLATFORM_NOTICE_URL: 'https://legal.test/platform',
      APP_AUTH_ELIGIBILITY_URL: 'https://legal.test/eligibility',
    })
    const configuredResponse = await configured.app.fetch(
      new Request('https://api.test/api/v2/app/bootstrap'),
      configured.env,
      {} as ExecutionContext,
    )
    const configuredBody = await configuredResponse.json<{ data: AppBootstrapConfig }>()
    expect(configuredBody.data.capabilities).toMatchObject({
      auth: true,
      interactions: {
        like: true,
        follow: true,
        favorite: false,
        history: false,
      },
    })

    const disabled = createApp()
    const disabledResponse = await disabled.app.fetch(
      new Request('https://api.test/api/v2/me/likes'),
      disabled.env,
      {} as ExecutionContext,
    )
    expect(disabledResponse.status).toBe(403)
    expect(await disabledResponse.json()).toMatchObject({
      error: { code: 'FEATURE_DISABLED', retryable: false },
    })
  })

  it('非法排序和与筛选不匹配的游标以稳定错误码拒绝', async () => {
    const { app, env } = createApp()
    const invalidSort = await app.fetch(
      new Request('https://api.test/api/v2/discovery/feed?sort=random'),
      env,
      {} as ExecutionContext,
    )
    expect(await invalidSort.json()).toMatchObject({
      error: { code: 'INVALID_DISCOVERY_SORT', retryable: false },
    })

    const invalidCursor = await app.fetch(
      new Request('https://api.test/api/v2/discovery/feed?cursor=not-a-valid-cursor'),
      env,
      {} as ExecutionContext,
    )
    expect(await invalidCursor.json()).toMatchObject({
      error: { code: 'INVALID_CURSOR', retryable: false },
    })
  })

  it('非法或不可见人物统一返回安全的不存在响应', async () => {
    const { app, env } = createApp()
    const response = await app.fetch(
      new Request('https://api.test/api/v2/person-profiles/legacy-1'),
      env,
      {} as ExecutionContext,
    )

    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({
      error: { code: 'PROFILE_NOT_AVAILABLE', retryable: false },
    })
  })

  it('OpenAPI 同步公共发现与默认关闭的账号访问路径', () => {
    const contract = readFileSync(
      new URL('../../../../contracts/app-api-v2.openapi.yaml', import.meta.url),
      'utf8',
    )
    expect(contract).toContain('/api/v2/app/bootstrap:')
    expect(contract).toContain('/api/v2/discovery/feed:')
    expect(contract).toContain('/api/v2/discovery/regions:')
    expect(contract).toContain('/api/v2/person-profiles/{profileId}:')
    expect(contract).toContain('/api/v2/auth/email-challenges:')
    expect(contract).toContain('/api/v2/auth/turnstile:')
    expect(contract).toContain('/api/v2/auth/turnstile/result:')
    expect(contract).toContain('/api/v2/auth/register:')
    expect(contract).toContain('/api/v2/auth/login:')
    expect(contract).toContain('/api/v2/auth/refresh:')
    expect(contract).toContain('/api/v2/auth/logout:')
    expect(contract).toContain('/api/v2/me:')
    expect(contract).toContain('/api/v2/me/devices:')
    expect(contract).toContain('/api/v2/person-profiles/{profileId}/interactions:')
    expect(contract).toContain('/api/v2/person-profiles/{profileId}/like:')
    expect(contract).toContain('/api/v2/person-profiles/{profileId}/follow:')
    expect(contract).toContain('/api/v2/me/likes:')
    expect(contract).toContain('/api/v2/me/follows:')
    expect(contract).toContain('/api/v2/membership/catalog:')
    expect(contract).toContain('/api/v2/me/entitlements:')
    expect(contract).toContain('/api/v2/conversations:')
    expect(contract).toContain('/api/v2/conversations/{conversationId}:')
    expect(contract).toContain('/api/v2/conversations/{conversationId}/messages:')
    expect(contract).toContain('/api/v2/conversations/{conversationId}/read:')
    expect(contract).toContain('/api/v2/notifications:')
    expect(contract).toContain('/api/v2/notifications/unread-counts:')
    expect(contract).toContain('/api/v2/notifications/read-all:')
    expect(contract).toContain('/api/v2/notifications/{notificationId}:')
    expect(contract).toContain('/api/v2/notifications/{notificationId}/read:')
    expect(contract).toContain('/api/v2/me/notification-preferences:')
    expect(contract).toContain('/api/v2/realtime/tickets:')
    expect(contract).toContain('/api/v2/realtime/connect:')
    expect(contract).toContain('/api/v2/me/wallet:')
    expect(contract).toContain('/api/v2/me/wallet/entries:')
    expect(contract).toContain('/api/v2/me/wallet/entries/{entryId}:')
    expect(contract).toContain('version: 1.26.0')
  })
})
