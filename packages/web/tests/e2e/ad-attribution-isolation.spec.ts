import { expect, test, type APIRequestContext } from '@playwright/test'

type AdProvider = 'meta' | 'tiktok' | 'google'
type ConsentState = 'granted' | 'denied'

const apiURL = process.env.PLAYWRIGHT_API_URL || 'http://127.0.0.1:8788'
const isolatedProjects = new Set(['chromium', 'mobile-360'])
const platformHosts: Record<AdProvider, readonly string[]> = {
  meta: ['connect.facebook.net', 'www.facebook.com'],
  tiktok: ['analytics.tiktok.com', 'business-api.tiktok.com'],
  google: ['www.googletagmanager.com', 'www.googleadservices.com', 'googleads.g.doubleclick.net'],
}
const sourceCases: Array<{
  name: string
  query: Record<string, string>
  provider: AdProvider | null
}> = [
  { name: 'Meta 来源', query: { fbclid: 'fb-e2e-click' }, provider: 'meta' },
  { name: 'TikTok 来源', query: { ttclid: 'tt-e2e-click' }, provider: 'tiktok' },
  { name: 'Google 来源', query: { gclid: 'google-e2e-click' }, provider: 'google' },
  { name: '无广告来源', query: {}, provider: null },
  {
    name: '多平台冲突来源',
    query: { fbclid: 'fb-conflict-click', ttclid: 'tt-conflict-click' },
    provider: null,
  },
]
const consentCases: Array<{ name: string; state: ConsentState }> = [
  { name: '已授权', state: 'granted' },
  { name: '已拒绝', state: 'denied' },
]

test.describe('广告归因浏览器网络隔离', () => {
  test.beforeEach(async ({ request }, testInfo) => {
    test.skip(!isolatedProjects.has(testInfo.project.name), '归因网络隔离仅在标准桌面与移动端门禁执行')
    await request.post(`${apiURL}/api/test/reset`)
  })

  for (const [sourceIndex, source] of sourceCases.entries()) {
    for (const [consentIndex, consent] of consentCases.entries()) {
      test(`${source.name} / ${consent.name}仅投递所属平台`, async ({ context, page, request }) => {
        const seenProviders: AdProvider[] = []
        const expectedProvider = consent.state === 'granted' ? source.provider : null

        await context.route('**/*', async (route) => {
          const requestUrl = new URL(route.request().url())
          const provider = providerForHost(requestUrl.hostname)
          if (provider) {
            seenProviders.push(provider)
            await route.fulfill({
              status: 200,
              contentType: 'application/javascript',
              body: '/* Playwright 广告平台隔离测试脚本 */',
            })
            return
          }
          if (requestUrl.hostname === 't.me' || requestUrl.hostname === 'telegram.me') {
            await route.abort()
            return
          }
          await route.continue()
        })

        await request.patch(`${apiURL}/api/test/marketing-consent-state`, {
          data: { state: consent.state },
        })

        await page.goto(pathWithQuery('/search', source.query))
        await expect(page.getByRole('heading', { name: /搜索写真/ })).toBeVisible()
        await page.getByRole('button', { name: '打开联系方式' }).click()
        await page.getByRole('link', { name: /Telegram/ }).click({ noWaitAfter: true })

        await expect.poll(async () => {
          const state = await attributionState(request)
          return state.conversions.length
        }).toBe(1)

        await request.patch(`${apiURL}/api/test/auth`, { data: { authenticated: false } })
        await page.goto(pathWithQuery('/register', { invite: 'TESTCODE', ...source.query }))
        await expect(page.getByText('已识别邀请码：Playwright 邀请')).toBeVisible()
        const username = `attr${sourceIndex}${consentIndex}`
        await page.getByPlaceholder('英文字母和数字，3-20 位').fill(username)
        await page.getByPlaceholder('your@email.com').fill(`${username}@example.test`)
        await page.getByPlaceholder('至少 8 位').fill('Password123')
        await page.getByPlaceholder('再次输入密码').fill('Password123')
        await page.getByRole('button', { name: '注册' }).click()
        await expect(page).toHaveURL('/')

        const expectedAttemptCount = expectedProvider ? 2 : 0
        await expect.poll(async () => {
          const state = await attributionState(request)
          return {
            registrations: state.registrations.length,
            browserAttempts: state.browserAttempts.length,
          }
        }).toEqual({ registrations: 1, browserAttempts: expectedAttemptCount })

        const state = await attributionState(request)
        const expectedAttributionState = expectedProvider ? 'resolved' : 'suppress'
        expect(state.conversions[0]).toMatchObject({
          consentState: consent.state,
          adAttributionState: expectedAttributionState,
        })
        expect(state.registrations[0]?.attribution).toMatchObject({
          consentState: consent.state,
          adAttributionState: expectedAttributionState,
        })

        if (expectedProvider) {
          expect(state.browserAttempts).toEqual(expect.arrayContaining([
            expect.objectContaining({ provider: expectedProvider, deliveryId: `delivery_${expectedProvider}_contact` }),
            expect.objectContaining({ provider: expectedProvider, deliveryId: `delivery_${expectedProvider}_registration` }),
          ]))
        }
        expect([...new Set(seenProviders)].sort()).toEqual(expectedProvider ? [expectedProvider] : [])
      })
    }
  }
})

function providerForHost(hostname: string): AdProvider | null {
  for (const [provider, hosts] of Object.entries(platformHosts) as Array<[AdProvider, readonly string[]]>) {
    if (hosts.includes(hostname)) return provider
  }
  return null
}

function pathWithQuery(path: string, query: Record<string, string>) {
  const search = new URLSearchParams(query).toString()
  return search ? `${path}?${search}` : path
}

async function attributionState(request: APIRequestContext) {
  const response = await request.get(`${apiURL}/api/test/ad-attribution-events`)
  expect(response.ok()).toBe(true)
  return response.json() as Promise<{
    provider: AdProvider | null
    resolution: 'matched' | 'none' | 'conflict'
    conversions: Array<Record<string, unknown>>
    browserAttempts: Array<{ provider?: AdProvider; deliveryId?: string }>
    registrations: Array<{ attribution?: Record<string, unknown> }>
  }>
}
