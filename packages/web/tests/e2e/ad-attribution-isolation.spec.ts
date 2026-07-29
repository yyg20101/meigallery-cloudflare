import { expect, test, type APIRequestContext, type BrowserContext } from '@playwright/test'

type AdProvider = 'meta' | 'tiktok' | 'google'

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
  { name: '普通 UTM 来源', query: { utm_source: 'facebook', utm_medium: 'paid_social' }, provider: null },
  { name: '无广告来源', query: {}, provider: null },
  {
    name: '多平台冲突来源',
    query: { fbclid: 'fb-conflict-click', ttclid: 'tt-conflict-click' },
    provider: null,
  },
]
test.describe('广告归因浏览器网络隔离', () => {
  test.beforeEach(async ({ request }, testInfo) => {
    test.skip(!isolatedProjects.has(testInfo.project.name), '归因网络隔离仅在标准桌面与移动端门禁执行')
    await request.post(`${apiURL}/api/test/reset`)
  })

  for (const [sourceIndex, source] of sourceCases.entries()) {
    test(`${source.name}仅投递所属平台`, async ({ context, page, request }) => {
      const seenProviders: AdProvider[] = []
      await routeAdPlatforms(context, seenProviders)

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
      const username = `attr${sourceIndex}`
      await page.getByPlaceholder('英文字母和数字，3-20 位').fill(username)
      await page.getByPlaceholder('your@email.com').fill(`${username}@example.test`)
      await page.getByPlaceholder('至少 8 位').fill('Password123')
      await page.getByPlaceholder('再次输入密码').fill('Password123')
      await page.getByRole('button', { name: '注册' }).click()
      await expect(page).toHaveURL('/')

      await expect.poll(async () => (await attributionState(request)).registrations.length).toBe(1)
      const state = await attributionState(request)
      expect(state.provider).toBe(source.provider)
      expect(state.conversions[0]).not.toHaveProperty('provider')
      expect(state.registrations[0]?.attribution).not.toHaveProperty('provider')
      expect([...new Set(seenProviders)].sort()).toEqual(source.provider ? [source.provider] : [])
    })
  }

  test('无新来源时继承最近一次有效广告来源', async ({ context, page, request }) => {
    const seenProviders: AdProvider[] = []
    await routeAdPlatforms(context, seenProviders)

    await page.goto('/search?fbclid=fb-last-paid-source')
    await expect(page.getByRole('heading', { name: /搜索写真/ })).toBeVisible()
    await expect.poll(async () => {
      const state = await attributionState(request)
      return { provider: state.provider, resolution: state.resolution }
    }).toEqual({ provider: 'meta', resolution: 'matched' })
    await expect.poll(() => [...new Set(seenProviders)]).toEqual(['meta'])
    seenProviders.length = 0

    await page.goto('/search')
    await expect(page.getByRole('heading', { name: /搜索写真/ })).toBeVisible()

    await expect.poll(async () => {
      const state = await attributionState(request)
      return { provider: state.provider, resolution: state.resolution }
    }).toEqual({ provider: 'meta', resolution: 'inherited' })
    await expect.poll(() => [...new Set(seenProviders)]).toEqual(['meta'])
  })
})

async function routeAdPlatforms(context: BrowserContext, seenProviders: AdProvider[]) {
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
}

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
    resolution: 'matched' | 'inherited' | 'none' | 'conflict'
    conversions: Array<Record<string, unknown>>
    registrations: Array<{ attribution?: Record<string, unknown> }>
  }>
}
