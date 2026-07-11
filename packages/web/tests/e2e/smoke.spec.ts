import { expect, test } from '@playwright/test'

const apiURL = process.env.PLAYWRIGHT_API_URL || 'http://127.0.0.1:8788'
const longAdHostname = 'verylongsponsoredcampaignlandingdestination.example.com'
const longAdUrl = `https://${longAdHostname}/sponsor-campaign`

async function expectAdminContainersWithinViewport(page: import('@playwright/test').Page) {
  const result = await page.evaluate(() => {
    const requirements: Array<{ selector: string; minCount?: number; exactCount?: number; allowHorizontalOverflow?: boolean }> = [
      { selector: '[data-admin-layout]' },
      { selector: '[data-admin-content]' },
      { selector: '[data-admin-header]' },
      { selector: '[data-admin-dev-warning]' },
      { selector: '[data-admin-header-row]' },
      { selector: '[data-admin-header-title]' },
      { selector: '[data-admin-main]' },
    ]
    if (location.pathname === '/admin/settings') {
      requirements.push(
        { selector: '[data-settings-page]' },
        { selector: '[data-settings-form]' },
      )
    }
    if (location.pathname.startsWith('/admin/attribution')) {
      requirements.push(
        { selector: '[data-attribution-page]' },
        { selector: '[data-attribution-header]' },
        { selector: '[data-attribution-header-title]' },
        { selector: '[data-attribution-header-description]' },
        { selector: '[data-attribution-controls]' },
        { selector: '[data-attribution-range-group]' },
        { selector: '[data-attribution-range-control]', minCount: 4 },
        { selector: '[data-attribution-control]', minCount: 5 },
        { selector: '[data-attribution-refresh]' },
        { selector: '[data-attribution-tabs]', allowHorizontalOverflow: true },
        { selector: '[data-attribution-tab-list]', allowHorizontalOverflow: true },
        { selector: '[data-attribution-tab]', exactCount: 5, allowHorizontalOverflow: true },
      )
    }
    if (location.pathname === '/admin/attribution') {
      requirements.push(
        { selector: '[data-evidence-rail]', allowHorizontalOverflow: true },
        { selector: '[data-attribution-section]', exactCount: 5 },
        { selector: '[data-meta-connection-status]' },
        { selector: '[data-meta-rollout-control]' },
        { selector: '[data-meta-incident-list]' },
        { selector: '[data-attribution-trend]', minCount: 3 },
      )
    }
    if (location.pathname === '/admin/attribution/meta') {
      requirements.push(
        { selector: '[data-meta-connection-status]' },
        { selector: '[data-meta-rollout-control]' },
        { selector: '[data-meta-incident-list]' },
        { selector: '[data-attribution-trend]' },
      )
    }
    if (location.pathname === '/admin/attribution/readiness') {
      requirements.push(
        { selector: '[data-readiness-status]' },
        { selector: '[data-readiness-section]', minCount: 2 },
        { selector: '[data-readiness-section-intro]', minCount: 2 },
        { selector: '[data-readiness-check-grid]', minCount: 2 },
        { selector: '[data-readiness-check]' },
        { selector: '[data-readiness-check-title]' },
        { selector: '[data-readiness-check-detail]' },
        { selector: '[data-readiness-check-key]' },
        { selector: '[data-readiness-check-state]' },
        { selector: '[data-readiness-settings]' },
        { selector: '[data-readiness-setting-item]' },
        { selector: '[data-readiness-verifications]' },
        { selector: '[data-readiness-verification-item]' },
      )
    }

    const containerSelectors = new Set([
      '[data-admin-layout]',
      '[data-admin-content]',
      '[data-admin-header]',
      '[data-admin-dev-warning]',
      '[data-admin-header-row]',
      '[data-admin-main]',
      '[data-settings-page]',
      '[data-settings-form]',
      '[data-attribution-page]',
      '[data-attribution-header]',
      '[data-attribution-controls]',
      '[data-attribution-range-group]',
      '[data-attribution-tabs]',
      '[data-attribution-tab-list]',
      '[data-evidence-rail]',
      '[data-attribution-section]',
      '[data-meta-connection-status]',
      '[data-meta-rollout-control]',
      '[data-meta-incident-list]',
      '[data-attribution-trend]',
      '[data-readiness-status]',
      '[data-readiness-section]',
      '[data-readiness-check-grid]',
      '[data-readiness-check]',
      '[data-readiness-settings]',
      '[data-readiness-verifications]',
    ])
    const documentClientWidth = document.documentElement.clientWidth
    const visualViewportWidth = window.visualViewport?.width ?? documentClientWidth
    const visibleWidth = Math.min(documentClientWidth, visualViewportWidth)
    const missing: Array<{ selector: string; expected: number; actual: number }> = []
    const violations: Array<{
      selector: string
      index: number
      left: number
      right: number
      width: number
      visibleWidth: number
      clientWidth: number
      scrollWidth: number
      overflow?: boolean
    }> = []
    for (const requirement of requirements) {
      const elements = [...document.querySelectorAll<HTMLElement>(requirement.selector)]
      const expected = requirement.exactCount ?? requirement.minCount ?? 1
      const countMatches = requirement.exactCount === undefined
        ? elements.length >= expected
        : elements.length === expected
      if (!countMatches) {
        missing.push({ selector: requirement.selector, expected, actual: elements.length })
        continue
      }
      for (const [index, element] of elements.entries()) {
        const rect = element.getBoundingClientRect()
        const overflow = !requirement.allowHorizontalOverflow
          && containerSelectors.has(requirement.selector)
          && element.scrollWidth > element.clientWidth + 1
        const outsideViewport = rect.left < 0 || (!requirement.allowHorizontalOverflow && rect.right > visibleWidth)
        if (outsideViewport || overflow) {
          violations.push({
            selector: requirement.selector,
            index,
            left: Number(rect.left.toFixed(2)),
            right: Number(rect.right.toFixed(2)),
            width: Number(rect.width.toFixed(2)),
            visibleWidth,
            clientWidth: element.clientWidth,
            scrollWidth: element.scrollWidth,
            overflow,
          })
        }
      }
    }
    return {
      missing,
      violations,
      diagnostics: {
        innerWidth: window.innerWidth,
        documentClientWidth,
        visualViewportWidth,
        visibleWidth,
      },
    }
  })

  const screenshot = await page.screenshot({ fullPage: true })
  const screenshotWidth = screenshot.readUInt32BE(16)
  const screenshotHeight = screenshot.readUInt32BE(20)

  expect(result.missing, JSON.stringify({ ...result.diagnostics, screenshotWidth, missing: result.missing }, null, 2)).toEqual([])
  expect(result.violations, JSON.stringify({ ...result.diagnostics, screenshotWidth, violations: result.violations }, null, 2)).toEqual([])
  expect({ ...result.diagnostics, screenshotWidth, screenshotHeight }).toEqual({
    ...result.diagnostics,
    screenshotWidth: result.diagnostics.documentClientWidth,
    screenshotHeight: expect.any(Number),
  })
}

async function submitAdminSettings(page: import('@playwright/test').Page) {
  await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/api/admin/settings') && response.request().method() === 'PATCH' && response.ok()),
    page.getByRole('button', { name: '保存设置' }).press('Enter'),
  ])
}

const smokePages = [
  { path: '/', heading: /精选写真/ },
  { path: '/search?q=夏日', heading: /搜索写真/, title: '搜索: 夏日 - 测试图库站' },
  { path: '/gallery/summer-portrait', heading: /夏日授权写真/, title: '夏日授权写真 - 测试图库站' },
  { path: '/login', heading: /登录 测试图库站/, title: '登录 - 测试图库站' },
  { path: '/user', heading: /会员权益/, title: '个人中心 - 测试图库站' },
  { path: '/admin', heading: /数据概览/ },
]

test.describe('核心页面 smoke', () => {
  test.beforeEach(async ({ request }) => {
    await request.post(`${apiURL}/api/test/reset`)
  })

  test('首页 SSR 原始 HTML 的 SEO 读取公开站点设置', async ({ request }) => {
    const response = await request.get('/')
    const html = await response.text()

    expect(response.ok()).toBe(true)
    expect(html).toContain('<title>测试站点标题 - 首页 SEO</title>')
    expect(html).toContain('<meta name="description" content="Playwright smoke 测试站点">')
    expect(html).toContain('<meta property="og:title" content="测试站点 OG 标题">')
    expect(html).toContain('<meta property="og:description" content="测试站点 OG 描述">')
    expect(html).toContain('<link rel="canonical" href="http://127.0.0.1:3100/">')
    expect(html).toContain('<script type="application/ld+json"')
    expect(html).toContain('"@type":"WebSite"')
    expect(html).toContain('"@type":"Organization"')
    expect(html).not.toContain('<title>MeiGallery - 精选写真图库</title>')
  })

  for (const smokePage of smokePages) {
    test(`${smokePage.path} 可渲染且无横向溢出`, async ({ page }) => {
      await page.goto(smokePage.path)

      await expect(page.getByRole('heading', { name: smokePage.heading }).first()).toBeVisible()
      if (smokePage.title) {
        await expect(page).toHaveTitle(smokePage.title)
      }
      if (smokePage.path === '/admin') {
        await expect(page.getByText('DEV 测试环境：')).toBeVisible()
        await expect(page.getByText('当前后台连接独立 dev D1/R2/Queue 资源')).toBeVisible()
        if ((page.viewportSize()?.width ?? 0) >= 1024) {
          await expect(page.getByText('测试图库站 管理')).toBeVisible()
        }
      }
      if (smokePage.path === '/') {
        await expect(page).toHaveTitle('测试站点标题 - 首页 SEO')
        await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', 'Playwright smoke 测试站点')
        await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', '测试站点 OG 标题')
        await expect(page.locator('meta[property="og:description"]')).toHaveAttribute('content', '测试站点 OG 描述')
        const homeAd = page.getByRole('region', { name: '首页广告推荐' })
        await expect(homeAd.getByText('推广')).toBeVisible()
        await expect(homeAd.getByText('会员季精选内容精选内容精选内容')).toBeVisible()
        const internalCta = homeAd.getByRole('link', { name: '查看推荐，站内推荐，目标页面 探索页，路径 /discover?sort=hot' })
        await expect(internalCta).toHaveAttribute('href', '/discover?sort=hot')
        await expect(internalCta).toHaveAttribute('aria-describedby', /home-ad-internal-note$/)
        await expect(homeAd.getByText('站内推荐')).toBeVisible()
        await expect(homeAd.getByText('目标页面 探索页')).toBeVisible()
        await expect(homeAd.locator('h2')).toBeVisible()
        await expect(homeAd.locator('h2')).toHaveCSS('overflow-wrap', 'break-word')
        await expect(homeAd.locator('p').first()).toHaveCSS('overflow-wrap', 'break-word')
      }
      await expect(page.locator('body')).not.toContainText('originals/')
      await expect(page.locator('body')).not.toContainText('imports/')

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement
        return doc.scrollWidth > doc.clientWidth + 1
      })
      expect(hasHorizontalOverflow).toBe(false)
    })
  }

  test('首页广告位在当前断点下不溢出', async ({ page }) => {
    await page.goto('/')
    const homeAd = page.getByRole('region', { name: '首页广告推荐' })

    await expect(homeAd).toBeVisible()
    await expect(homeAd.locator('h2')).toBeVisible()
    await expect(homeAd.locator('a')).toBeVisible()

    const overflow = await homeAd.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return rect.right > window.innerWidth + 1 || rect.left < -1
    })
    expect(overflow).toBe(false)
  })

  test('首页广告默认站内链接可以真实跳转', async ({ page }) => {
    await page.goto('/')
    const homeAd = page.getByRole('region', { name: '首页广告推荐' })
    const internalCta = homeAd.getByRole('link', { name: '查看推荐，站内推荐，目标页面 探索页，路径 /discover?sort=hot' })

    await expect(internalCta).toHaveAttribute('href', '/discover?sort=hot')
    await internalCta.click()
    await expect(page).toHaveURL(/\/discover\?sort=hot$/)
  })

  test('首页广告外链输出安全属性和离站提示', async ({ request, page }) => {
    await request.patch(`${apiURL}/api/admin/settings`, {
      data: {
        home_ad_url: longAdUrl,
        home_ad_cta_label: '查看赞助',
        home_ad_sponsor: '外部赞助推荐',
      },
    })

    await page.goto('/')

    const homeAd = page.getByRole('region', { name: '首页广告推荐' })
    const externalCta = homeAd.getByRole('link', { name: `查看赞助，外部链接，目标域名 ${longAdHostname}` })

    await expect(homeAd).toBeVisible()
    await expect(externalCta).toBeVisible()
    await expect(externalCta).toHaveAttribute('href', longAdUrl)
    await expect(externalCta).toHaveAttribute('target', '_blank')
    await expect(externalCta).toHaveAttribute('rel', /(^| )noopener( |$)/)
    await expect(externalCta).toHaveAttribute('rel', /(^| )noreferrer( |$)/)
    await expect(externalCta).toHaveAttribute('rel', /(^| )nofollow( |$)/)
    await expect(externalCta).toHaveAttribute('rel', /(^| )sponsored( |$)/)
    await expect(externalCta).toHaveAttribute('referrerpolicy', 'no-referrer')
    await expect(externalCta).toHaveAttribute('aria-describedby', /home-ad-external-note$/)
    await expect(homeAd.getByText('外部链接')).toBeVisible()
    await expect(homeAd.getByText(`目标域名 ${longAdHostname}`)).toBeVisible()
    await expect(homeAd.getByText('不发送来源页信息')).toBeVisible()
    const describedBy = await externalCta.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    await expect(homeAd.locator(`[id="${describedBy}"]`)).toContainText(`目标域名 ${longAdHostname}`)
    await expect(homeAd.locator(`[id="${describedBy}"]`)).toContainText('不发送来源页信息')
    await expect(homeAd.locator(`[id="${describedBy}"]`)).toHaveCSS('overflow-wrap', 'break-word')

    const hasHorizontalOverflow = await page.evaluate(() => {
      const doc = document.documentElement
      return doc.scrollWidth > doc.clientWidth + 1
    })
    expect(hasHorizontalOverflow).toBe(false)
  })

  test('后台广告预览不渲染可跳转链接', async ({ page }) => {
    await page.goto('/admin/ads')

    await page.getByRole('button', { name: '新增广告位' }).click()
    const targetInput = page.locator('input[placeholder="/discover?sort=hot"]')
    await expect(targetInput).toHaveValue('/discover?sort=hot')

    const preview = page.getByRole('region', { name: '首页广告推荐' })
    const previewCta = preview.locator('[aria-disabled="true"]')

    await expect(preview).toBeVisible()
    await expect(previewCta).toHaveAttribute('aria-describedby', /home-ad-internal-note$/)
    await expect(preview.getByText('站内推荐')).toBeVisible()
    await expect(preview.getByText('目标页面 探索页')).toBeVisible()
    await expect(preview.locator('a[href="/discover?sort=hot"]')).toHaveCount(0)

    await targetInput.fill(longAdUrl)
    await page.locator('input[placeholder="查看详情"]').fill('查看赞助')

    await expect(previewCta).toContainText('查看赞助')
    await expect(previewCta).toHaveAttribute('aria-describedby', /home-ad-external-note$/)
    await expect(preview.getByText('外部链接')).toBeVisible()
    await expect(preview.getByText(`目标域名 ${longAdHostname}`)).toBeVisible()
    await expect(preview.getByText('不发送来源页信息')).toBeVisible()
    await expect(preview.locator(`a[href="${longAdUrl}"]`)).toHaveCount(0)

    await expectAdminContainersWithinViewport(page)
  })

  test('后台更新站点 SEO 后首页立即读取新标题', async ({ page }) => {
    await page.goto('/admin/settings')

    const publicSeoSync = page.getByRole('region', { name: '前台同步状态' })
    await expect(publicSeoSync.getByRole('heading', { name: '前台同步状态' })).toBeVisible()
    await expect(publicSeoSync.getByText('公开 SEO 标题')).toBeVisible()
    await expect(publicSeoSync.getByText('公开 SEO 关键词')).toBeVisible()
    await expect(publicSeoSync.getByText('测试站点标题 - 首页 SEO')).toBeVisible()
    await expect(publicSeoSync.getByText('授权图库、写真、时尚写真')).toBeVisible()

    await page.getByLabel('站点名称').fill('运营新站名')
    await page.getByLabel('站点描述').fill('后台保存后的新站点描述')
    await page.getByLabel('SEO 标题').fill('运营新标题 - 首页')
    await page.getByLabel('SEO 关键词池').fill('授权图库, 户外写真\n真实案例')
    await page.getByLabel('OG 标题').fill('运营新 OG 标题')
    await page.getByLabel('OG 描述').fill('运营新 OG 描述')

    await expect(publicSeoSync.getByText('待同步', { exact: true })).toBeVisible()
    await expect(publicSeoSync.getByText('前台公开读取值与当前表单不一致，保存后会重新校验公开设置。')).toBeVisible()

    await submitAdminSettings(page)

    await expect(page.getByText('设置已保存，前台公开 SEO 已同步')).toBeVisible()
    await expect(publicSeoSync.getByText('已同步', { exact: true })).toBeVisible()
    await expect(publicSeoSync.getByText('运营新标题 - 首页')).toBeVisible()
    await expect(publicSeoSync.getByText('授权图库、户外写真、真实案例')).toBeVisible()
    await expect(publicSeoSync.getByText('后台保存后的新站点描述')).toBeVisible()
    await page.goto('/')

    await expect(page).toHaveTitle('运营新标题 - 首页')
    await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', '后台保存后的新站点描述')
    await expect(page.locator('meta[name="keywords"]')).toHaveAttribute('content', '授权图库, 户外写真, 真实案例')
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', '运营新 OG 标题')
    await expect(page.locator('meta[property="og:description"]')).toHaveAttribute('content', '运营新 OG 描述')
    await expect(page).not.toHaveTitle('MeiGallery - 精选写真图库')
  })

  test('后台数据分析空数据时保持大盘布局和健康详情', async ({ request, page }) => {
    await request.patch(`${apiURL}/api/test/admin-analytics-empty`, { data: { enabled: true } })

    await page.goto('/admin/analytics')
    await expect(page.locator('main h1', { hasText: '数据分析' })).toBeVisible()
    await expect(page.getByText('有效联系').first()).toBeVisible()
    await expect(page.getByText('暂无分析数据')).toBeVisible()
    await expect(page.getByText('暂无趋势数据')).toBeVisible()
    await expect(page.getByText('暂无排行').first()).toBeVisible()

    await page.getByRole('button', { name: '单日' }).click()
    await expect(page.getByLabel('选择分析日期')).toBeVisible()
    await page.getByLabel('选择分析日期').fill('2026-06-07')

    let hasHorizontalOverflow = await page.evaluate(() => {
      const doc = document.documentElement
      return doc.scrollWidth > doc.clientWidth + 1
    })
    expect(hasHorizontalOverflow).toBe(false)

    await page.getByRole('link', { name: '查看采集健康' }).click()
    await expect(page).toHaveURL(/\/admin\/analytics\/health/)
    await expect(page.locator('main h1', { hasText: '采集健康' })).toBeVisible()
    await expect(page.getByText('暂无采集健康记录')).toBeVisible()

    hasHorizontalOverflow = await page.evaluate(() => {
      const doc = document.documentElement
      return doc.scrollWidth > doc.clientWidth + 1
    })
    expect(hasHorizontalOverflow).toBe(false)
  })

  test('后台 Meta 归因质量总览可查看五区、单日归因和投放链接', async ({ page }, testInfo) => {
    await page.goto('/admin/attribution')
    await expect(page.locator('main h1')).toHaveText('Meta 归因质量')
    await expect(page.getByText('按时间比较站内事实、Pixel 尝试、CAPI 接收与 Meta 质量，定位投放和投递问题。')).toBeVisible()

    const sections = page.locator('[data-attribution-section]')
    await expect(sections).toHaveCount(5)
    expect(await sections.evaluateAll(elements => elements.map(element => element.getAttribute('data-attribution-section')))).toEqual([
      'connection', 'business', 'delivery', 'quality', 'rollout',
    ])
    for (const label of ['站内事实', 'Pixel 尝试', 'CAPI 接收', 'Meta 质量']) {
      await expect(page.locator('[data-evidence-rail]')).toContainText(label)
    }

    const connectionSection = page.locator('[data-attribution-section="connection"]')
    await expect(connectionSection.getByRole('heading', { name: 'Meta 连接与当前活动' })).toBeVisible()
    await expect(connectionSection.getByText('已验证', { exact: true })).toBeVisible()
    await expect(connectionSection.getByText('已配置', { exact: true })).toHaveCount(2)

    const deliverySection = page.locator('[data-attribution-section="delivery"]')
    await expect(deliverySection.getByRole('heading', { name: 'Pixel 与 CAPI delivery' })).toBeVisible()
    await expect(deliverySection.getByText('CAPI 接收只表示 API 接收，不表示 Meta 已归因。')).toBeVisible()
    const deliveryItems = deliverySection.locator('dl').first().locator(':scope > div')
    await expect(deliveryItems.filter({ hasText: /^Pixel 尝试\s*12$/ })).toHaveCount(1)
    await expect(deliveryItems.filter({ hasText: /^CAPI 接收\s*9$/ })).toHaveCount(1)
    await expect(page.locator('[data-attribution-section="quality"]').getByRole('heading', { name: '匹配覆盖与 Meta 质量' })).toBeVisible()
    await expect(page.locator('[data-attribution-section="rollout"]').getByRole('heading', { name: 'CAPI rollout 与 incident' })).toBeVisible()
    await expect(page.getByText('已同步', { exact: true })).toHaveCount(0)
    await expectAdminContainersWithinViewport(page)
    if (process.env.TASK8_SCREENSHOT_DIR) {
      await page.screenshot({
        path: `${process.env.TASK8_SCREENSHOT_DIR}/attribution-${page.viewportSize()?.width ?? testInfo.project.name}.png`,
        fullPage: true,
      })
    }

    await page.getByRole('button', { name: '单日' }).click()
    await page.getByLabel('选择归因日期').fill('2026-07-09')
    await page.getByRole('link', { name: '投放链接', exact: true }).click()

    await expect(page).toHaveURL(/\/admin\/attribution\/links\?range=day&date=2026-07-09/)
    await expect(page.getByText('投放追踪链接')).toBeVisible()
    await expect(page.getByText('不是 Pixel 地址')).toBeVisible()
    await expectAdminContainersWithinViewport(page)
  })

  test('后台归因 Meta 控制面按生产检查保守启用并验证连接与投递口径', async ({ page }) => {
    await page.goto('/admin/settings')

    await expect(page.getByLabel('Meta 运行模式')).toHaveValue('test')
    await expect(page.getByLabel('启用 Meta CAPI')).toBeDisabled()
    await expect(page.getByRole('link', { name: '查看发布检查' })).toHaveAttribute('href', '/admin/attribution/readiness')
    await expectAdminContainersWithinViewport(page)

    await page.goto('/admin/attribution/meta')
    await expect(page.locator('main h1')).toHaveText('Meta 运维')
    const connection = page.locator('[data-meta-connection-status]')
    await expect(connection.getByText('连接验证', { exact: true })).toBeVisible()
    await expect(connection.getByText('已验证', { exact: true })).toBeVisible()
    await expect(connection.getByText('Pixel ID', { exact: true })).toBeVisible()
    await expect(connection.getByText('CAPI token', { exact: true })).toBeVisible()
    await expect(connection.getByText('已配置', { exact: true })).toHaveCount(2)
    await expect(connection.getByText('v25.0', { exact: true })).toBeVisible()
    await expect(connection.getByText('连接配置与验证记录一致 · dev', { exact: true })).toBeVisible()

    const rollout = page.locator('[data-meta-rollout-control]')
    await expect(rollout.getByText('critical incident 已打开，effective 强制为 0%；target 10% 保留。')).toBeVisible()
    await expect(rollout.getByText('critical incident 尚未关闭', { exact: true })).toBeVisible()
    await expect(page.getByText('尚未取得 Meta 质量数据')).toBeVisible()
    await expect(page.locator('[data-meta-incident-list]')).toContainText('CAPI 重试耗尽')

    const [connectionResponse] = await Promise.all([
      page.waitForResponse(response => response.url().endsWith('/api/admin/attribution/meta/test-event') && response.request().method() === 'POST'),
      page.getByRole('button', { name: '验证连接' }).click(),
    ])
    expect(connectionResponse.status()).toBe(200)
    await expect(connectionResponse.json()).resolves.toMatchObject({
      data: { status: 'verified', eventsReceived: 1 },
    })

    const [verificationResponse] = await Promise.all([
      page.waitForResponse(response => response.url().endsWith('/api/admin/attribution/meta/live-challenge/consume') && response.request().method() === 'POST'),
      page.getByRole('button', { name: 'Live Evidence' }).click(),
    ])
    expect(verificationResponse.status()).toBe(200)
    await expect(verificationResponse.json()).resolves.toMatchObject({
      data: {
        status: 'server_sent',
        eventsReceived: 2,
      },
    })
    const queuedMetaEvents = await page.evaluate(() => {
      const queue = (window as unknown as { fbq?: { queue?: unknown[][] } }).fbq?.queue || []
      return queue.filter(call => call[0] === 'track' && ['Contact', 'CompleteRegistration'].includes(String(call[1])))
    })
    expect(queuedMetaEvents).toHaveLength(2)
    expect(queuedMetaEvents.map(call => call[1]).sort()).toEqual(['CompleteRegistration', 'Contact'])
    await expect(page.locator('[data-meta-connection-status]').getByText('已验证', { exact: true })).toBeVisible()
    await expectAdminContainersWithinViewport(page)

    await page.getByRole('link', { name: '总览', exact: true }).click()
    const deliverySection = page.locator('[data-attribution-section="delivery"]')
    await expect(deliverySection.getByText('CAPI 接收只表示 API 接收，不表示 Meta 已归因。')).toBeVisible()
    await expect(deliverySection.locator('dl').first().locator(':scope > div').filter({ hasText: /^CAPI 接收\s*9$/ })).toHaveCount(1)
  })

  test('production Owner 可触发 Test Event，并直接看到后端 blocker', async ({ request, page }) => {
    await request.patch(`${apiURL}/api/test/admin-attribution-environment`, { data: { environment: 'production' } })
    await request.patch(`${apiURL}/api/test/admin-attribution-action-mode`, { data: { mode: 'conflict' } })
    await page.goto('/admin/attribution/meta')

    const connection = page.locator('[data-meta-connection-status]')
    await expect(connection).toContainText('· production')
    const [response] = await Promise.all([
      page.waitForResponse(candidate => candidate.url().endsWith('/api/admin/attribution/meta/test-event')),
      connection.getByRole('button', { name: '验证连接' }).click(),
    ])
    expect(response.status()).toBe(409)
    await expect(connection.getByRole('status')).toHaveText('production 资源验证尚未通过')
  })

  test('后台归因设置始终允许关闭已开启的 CAPI', async ({ request, page }) => {
    await request.patch(`${apiURL}/api/test/admin-attribution-readiness`, { data: { blocked: false } })
    await request.patch(`${apiURL}/api/admin/settings`, { data: { meta_tracking_mode: 'test', meta_capi_enabled: true } })

    await page.goto('/admin/settings')
    const capi = page.getByLabel('启用 Meta CAPI')
    await expect(capi).toBeChecked()
    await expect(capi).toBeEnabled()
    await capi.uncheck()
    await submitAdminSettings(page)

    const settings = await (await request.get(`${apiURL}/api/settings/public`)).json()
    expect(settings.meta_capi_enabled).toBe(false)
  })

  test('后台归因设置在 blocker 失败时清除旧 CAPI true 并保存 false', async ({ request, page }) => {
    await request.patch(`${apiURL}/api/admin/settings`, { data: { meta_tracking_mode: 'test', meta_capi_enabled: true } })

    await page.goto('/admin/settings')
    const capi = page.getByLabel('启用 Meta CAPI')
    await expect(capi).not.toBeChecked()
    await expect(capi).toBeDisabled()
    await submitAdminSettings(page)

    const settings = await (await request.get(`${apiURL}/api/settings/public`)).json()
    expect(settings.meta_capi_enabled).toBe(false)
  })

  test('后台归因设置不会把 test 的 CAPI true 带入 production', async ({ request, page }) => {
    await request.patch(`${apiURL}/api/test/admin-attribution-readiness`, { data: { blocked: false } })
    await request.patch(`${apiURL}/api/admin/settings`, { data: { meta_tracking_mode: 'test', meta_capi_enabled: true } })

    await page.goto('/admin/settings')
    const capi = page.getByLabel('启用 Meta CAPI')
    await expect(capi).toBeChecked()
    await page.getByLabel('Meta 运行模式').selectOption('production')
    await expect(capi).not.toBeChecked()
    await expect(capi).toBeDisabled()
    await submitAdminSettings(page)

    const settings = await (await request.get(`${apiURL}/api/settings/public`)).json()
    expect(settings.meta_tracking_mode).toBe('production')
    expect(settings.meta_capi_enabled).toBe(false)
  })

  test('后台归因发布检查区分阻断项和警告项且警告不改变阻断口径', async ({ page }) => {
    await page.goto('/admin/attribution/readiness')

    await expect(page.getByText('生产阻断项仍需处理')).toBeVisible()
    await expect(page.getByRole('region', { name: '阻断项' }).getByText('最近 24 小时无重试耗尽')).toBeVisible()
    await expect(page.getByRole('region', { name: '警告项' }).getByText('无超过 10 分钟的 CAPI pending')).toBeVisible()
    await expect(page.getByText('Meta 资源验证')).toBeVisible()
    await expect(page.getByText('验证时间：2026-07-10 08:05')).toBeVisible()
    await expect(page.getByText('正式投放就绪')).toHaveCount(0)

    await expectAdminContainersWithinViewport(page)
  })

  test('一方数据分析事件覆盖搜索、详情、联系和邀请注册链路', async ({ request, page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: /精选写真/ }).first()).toBeVisible()

    await page.goto('/search')
    await expect(page.getByRole('heading', { name: /搜索写真/ })).toBeVisible()
    await page.getByRole('link', { name: /夏日授权写真/ }).first().click()
    await expect(page.getByRole('heading', { name: '夏日授权写真' })).toBeVisible()

    await page.getByRole('button', { name: '打开联系方式' }).click()
    await expect(page.getByRole('heading', { name: '站长在线回复' })).toBeVisible()
    await page.route('https://t.me/**', route => route.abort())
    await page.getByRole('link', { name: /Telegram/ }).click({ noWaitAfter: true })
    await expect.poll(async () => {
      const response = await request.get(`${apiURL}/api/test/analytics-events`)
      const body = await response.json()
      return body.events.some((event: { eventName?: string }) => event.eventName === 'contact_method_click')
    }, { timeout: 8_000 }).toBe(true)

    await request.patch(`${apiURL}/api/test/auth`, { data: { authenticated: false } })
    await page.goto('/register?invite=TESTCODE')
    await expect(page.getByText('已识别邀请码：Playwright 邀请')).toBeVisible()
    await page.getByPlaceholder('英文字母和数字，3-20 位').fill('inviteuser')
    await page.getByPlaceholder('your@email.com').fill('inviteuser@example.test')
    await page.getByPlaceholder('至少 8 位').fill('Password123')
    await page.getByPlaceholder('再次输入密码').fill('Password123')
    await page.getByRole('button', { name: '注册' }).click()
    await expect(page).toHaveURL('/')

    await expect.poll(async () => {
      const response = await request.get(`${apiURL}/api/test/analytics-events`)
      const body = await response.json()
      return {
        registrations: body.registrations.length,
        registerSuccess: body.events.some((event: { eventName?: string }) => event.eventName === 'register_success'),
      }
    }, { timeout: 8_000 }).toEqual({ registrations: 1, registerSuccess: true })

    const response = await request.get(`${apiURL}/api/test/analytics-events`)
    const payload = await response.json()
    expect(payload.registrations[0]).toMatchObject({ inviteCode: 'TESTCODE', sourceChannel: 'invite' })

    const eventNames = payload.events.map((event: { eventName?: string }) => event.eventName)
    expect(eventNames).toContain('page_view')
    expect(eventNames).toContain('gallery_detail_view')
    expect(eventNames).toContain('contact_panel_open')
    expect(eventNames).toContain('contact_method_click')
    expect(eventNames).toContain('invite_landed')
    expect(eventNames).toContain('invite_code_checked')
    expect(eventNames).toContain('register_success')
    expect(payload.events.some((event: { eventName?: string; props?: { method_type?: string; action_type?: string } }) =>
      event.eventName === 'contact_method_click' &&
      event.props?.method_type === 'telegram' &&
      ['open_link', 'copy'].includes(event.props?.action_type || ''),
    )).toBe(true)

    const serialized = JSON.stringify(payload)
    expect(serialized).not.toContain('meigallery_admin')
    expect(serialized).not.toContain('token=')
    expect(serialized).not.toContain('api_key=')
    expect(serialized).not.toContain('access_token=')
    expect(serialized).not.toContain('originals/')
    expect(serialized).not.toContain('imports/')
  })
})
