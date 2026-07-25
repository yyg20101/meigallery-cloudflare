import {
  expect,
  test,
  type BrowserContext,
  type Route,
} from '@playwright/test'

type Provider = 'meta' | 'tiktok' | 'google'

const platformHosts: Record<Provider, readonly string[]> = {
  meta: ['connect.facebook.net', 'www.facebook.com'],
  tiktok: ['analytics.tiktok.com', 'business-api.tiktok.com'],
  google: [
    'www.googletagmanager.com',
    'www.googleadservices.com',
    'googleads.g.doubleclick.net',
  ],
}
const cases: Array<{
  name: string
  query: string
  provider: Provider | null
  granted: boolean
}> = [
  {
    name: 'Meta 来源',
    query: 'fbclid=meta-click',
    provider: 'meta',
    granted: true,
  },
  {
    name: 'TikTok 来源',
    query: 'ttclid=tiktok-click',
    provider: 'tiktok',
    granted: true,
  },
  {
    name: 'Google 来源',
    query: 'gclid=google-click',
    provider: 'google',
    granted: true,
  },
  {
    name: '无广告来源',
    query: '',
    provider: null,
    granted: true,
  },
  {
    name: '拒绝可选分析',
    query: 'fbclid=denied-meta-click',
    provider: 'meta',
    granted: false,
  },
]

test.describe('统一归因 Browser runtime 隔离', () => {
  test.beforeEach(({ browserName }, testInfo) => {
    const isStandardChromium = browserName === 'chromium'
      && testInfo.project.name === 'chromium'
    test.skip(
      !isStandardChromium,
      '归因平台网络隔离只执行一次标准浏览器门禁',
    )
  })

  for (const testCase of cases) {
    test(`${testCase.name}只加载所属平台并完成 Contact 回执`, async ({
      context,
      page,
    }) => {
      const seenProviders: Provider[] = []
      const contactBodies: unknown[] = []
      const receiptBodies: unknown[] = []
      await mockAttributionRuntime(context, testCase, {
        seenProviders,
        contactBodies,
        receiptBodies,
      })

      await page.goto(`/search${testCase.query ? `?${testCase.query}` : ''}`)
      await expect(
        page.getByRole('heading', { name: /搜索写真/ }),
      ).toBeVisible()
      await page.getByRole('button', { name: '打开联系方式' }).click()
      await page.getByRole('link', { name: /Telegram/ }).click({
        noWaitAfter: true,
      })

      await expect.poll(() => contactBodies.length).toBe(1)
      const expectedProvider = testCase.granted
        ? testCase.provider
        : null
      if (expectedProvider) {
        await expect.poll(() => receiptBodies.length).toBe(1)
      }
      else {
        expect(receiptBodies).toHaveLength(0)
      }
      expect([...new Set(seenProviders)].sort()).toEqual(
        expectedProvider ? [expectedProvider] : [],
      )
      expect(contactBodies[0]).toMatchObject({
        event: {
          eventName: 'Contact',
          sourceContextToken: null,
          payload: {
            contactPlatform: 'telegram',
            contactAction: 'open_link',
          },
        },
        destination: {
          value: 'meigallery_admin',
          linkUrl: null,
        },
      })
    })
  }
})

async function mockAttributionRuntime(
  context: BrowserContext,
  testCase: {
    provider: Provider | null
    granted: boolean
  },
  captures: {
    seenProviders: Provider[]
    contactBodies: unknown[]
    receiptBodies: unknown[]
  },
) {
  await context.route('**/*', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const provider = providerForHost(url.hostname)
    if (provider) {
      captures.seenProviders.push(provider)
      await route.fulfill({
        status: 200,
        contentType: 'application/javascript',
        body: '/* 平台 SDK 隔离测试 */',
      })
      return
    }
    if (url.hostname === 't.me' || url.hostname === 'telegram.me') {
      await route.abort()
      return
    }
    if (!url.pathname.startsWith('/v1/')) {
      await route.continue()
      return
    }

    if (url.pathname === '/v1/privacy-decision') {
      await json(route, {
        data: testCase.granted
          ? {
              state: 'granted',
              reason: 'regional_default',
              policyMode: 'notice_opt_out',
              policyVersion: 1,
              requiresChoice: false,
            }
          : {
              state: 'denied',
              reason: 'explicit',
              policyMode: 'notice_opt_out',
              policyVersion: 1,
              requiresChoice: false,
            },
      })
      return
    }
    if (url.pathname === '/v1/context') {
      await json(route, { data: { issued: Boolean(testCase.provider) } })
      return
    }
    if (url.pathname === '/v1/runtime-config') {
      await json(route, {
        data: testCase.granted && testCase.provider
          ? runtimeConfig(testCase.provider)
          : null,
      })
      return
    }
    if (url.pathname === '/v1/events/contact') {
      captures.contactBodies.push(request.postDataJSON())
      await json(route, {
        accepted: true,
        eventId: 'evt_contact_e2e',
        instruction: testCase.granted && testCase.provider
          ? instruction(testCase.provider)
          : null,
      }, 202)
      return
    }
    if (url.pathname === '/v1/browser-receipts') {
      captures.receiptBodies.push(request.postDataJSON())
      await json(route, { accepted: true }, 202)
      return
    }
    await route.fulfill({ status: 404 })
  })
}

function runtimeConfig(provider: Provider) {
  return {
    provider,
    connectionId: `connection_${provider}`,
    versionId: `version_${provider}`,
    publicConfig: provider === 'meta'
      ? { provider, pixelId: '1615446443914929' }
      : provider === 'tiktok'
        ? { provider, pixelCode: 'D9AF43RC77U133LMNMM0' }
        : { provider, tagId: 'AW-123456789' },
    runtimeLeaseToken: `runtime_lease_${provider}_0123456789`,
    expiresAt: 1_900_000_000,
  }
}

function instruction(provider: Provider) {
  return {
    schemaVersion: 1,
    deliveryId: `delivery_${provider}_contact`,
    provider,
    canonicalEvent: 'Contact',
    eventName: provider === 'google' ? 'conversion' : 'Contact',
    destination: provider === 'meta'
      ? 'meta_pixel'
      : provider === 'tiktok'
        ? 'tiktok_pixel'
        : 'AW-123456789/Contact_Label',
    externalEventId: `external_${provider}_contact`,
    receiptToken: `receipt_${provider}_0123456789`,
    payload: {},
  }
}

function providerForHost(hostname: string): Provider | null {
  for (
    const [provider, hosts]
    of Object.entries(platformHosts) as Array<
      [Provider, readonly string[]]
    >
  ) {
    if (hosts.includes(hostname)) return provider
  }
  return null
}

async function json(
  route: Route,
  body: unknown,
  status = 200,
) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
    headers: {
      'Access-Control-Allow-Origin': 'http://127.0.0.1:3100',
      'Access-Control-Allow-Credentials': 'true',
    },
  })
}
