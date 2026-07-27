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
        { selector: '[data-attribution-refresh]' },
        { selector: '[data-attribution-tabs]', allowHorizontalOverflow: true },
        { selector: '[data-attribution-tab-list]', allowHorizontalOverflow: true },
        { selector: '[data-attribution-tab]', exactCount: 6, allowHorizontalOverflow: true },
      )
      if (['/admin/attribution', '/admin/attribution/deliveries', '/admin/attribution/audit'].includes(location.pathname)) {
        requirements.push(
          { selector: '[data-attribution-range-group]' },
          { selector: '[data-attribution-range-control]', minCount: 4 },
          { selector: '[data-attribution-control]', minCount: 5 },
        )
      }
    }
    if (location.pathname === '/admin/attribution') {
      requirements.push(
        { selector: '[data-evidence-rail]', allowHorizontalOverflow: true },
        { selector: '[data-attribution-section]', exactCount: 4 },
        { selector: '[data-attribution-trend]', minCount: 3 },
      )
    }
    if (location.pathname === '/admin/attribution/platforms') {
      requirements.push(
        { selector: '[data-attribution-connection-editor]' },
        { selector: '[data-attribution-binding-editor]' },
        { selector: '[data-attribution-credential-editor]' },
      )
    }
    if (location.pathname === '/admin/attribution/deliveries') {
      requirements.push(
        { selector: '[data-attribution-incident-list]' },
      )
    }
    if (location.pathname === '/admin/attribution/diagnostics') {
      requirements.push({ selector: '[data-attribution-diagnostic]' })
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
      '[data-attribution-connection-editor]',
      '[data-attribution-binding-editor]',
      '[data-attribution-credential-editor]',
      '[data-attribution-diagnostic]',
      '[data-attribution-incident-list]',
      '[data-attribution-trend]',
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

  test('编码后的中文图库链接可直接 SSR 渲染', async ({ page }) => {
    const response = await page.goto('/gallery/%E4%B8%AD%E6%96%87%E7%9B%B4%E8%BE%BE%E5%9B%BE%E5%BA%93')

    expect(response?.ok()).toBe(true)
    await expect(page.getByRole('heading', { name: '中文直达图库' }).first()).toBeVisible()
    await expect(page).toHaveTitle('中文直达图库 - 测试图库站')
  })

  for (const smokePage of smokePages) {
    test(`${smokePage.path} 可渲染且无横向溢出 @responsive`, async ({ page }) => {
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

  test('首页广告位在当前断点下不溢出 @responsive', async ({ page }) => {
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

  test('联系方式入口不遮挡登录按钮 @responsive', async ({ request, page }) => {
    await request.patch(`${apiURL}/api/test/auth`, { data: { authenticated: false } })
    await page.goto('/login')

    const loginButton = page.getByRole('button', { name: '登录', exact: true })
    const contactButton = page.getByRole('button', { name: '打开联系方式' })
    await expect(loginButton).toBeVisible()
    await expect(contactButton).toBeVisible()

    const loginBox = await loginButton.boundingBox()
    const contactBox = await contactButton.boundingBox()
    expect(loginBox).not.toBeNull()
    expect(contactBox).not.toBeNull()

    const overlaps = Boolean(loginBox && contactBox
      && loginBox.x < contactBox.x + contactBox.width
      && loginBox.x + loginBox.width > contactBox.x
      && loginBox.y < contactBox.y + contactBox.height
      && loginBox.y + loginBox.height > contactBox.y)
    expect(overlaps).toBe(false)

    if ((page.viewportSize()?.width ?? 0) < 1024) {
      expect(contactBox?.width).toBeLessThanOrEqual(48)
      expect(contactBox?.height).toBeLessThanOrEqual(48)
    }
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

  test('后台数据分析空数据时保持大盘布局和健康详情 @responsive', async ({ request, page }) => {
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

  test('后台广告归因总览可查看四层证据、单日归因和平台连接 @responsive', async ({ page }, testInfo) => {
    await page.goto('/admin/attribution')
    await expect(page.locator('main h1')).toHaveText('广告归因总览')
    await expect(page.getByText('统一核对 Meta、TikTok 与 Google 的业务事实、投递状态、质量和容量。')).toBeVisible()

    const sections = page.locator('[data-attribution-section]')
    await expect(sections).toHaveCount(4)
    expect(await sections.evaluateAll(elements => elements.map(element => element.getAttribute('data-attribution-section')))).toEqual([
      'business', 'delivery', 'quality', 'capacity',
    ])
    for (const label of ['站内事实', 'Browser 计划', 'Server 状态', '质量证据']) {
      await expect(page.locator('[data-evidence-rail]')).toContainText(label)
    }

    await expect(page.getByText('Meta · 生产运行', { exact: true })).toBeVisible()
    await expect(page.getByRole('link', { name: '管理平台连接' })).toBeVisible()

    const deliverySection = page.locator('[data-attribution-section="delivery"]')
    await expect(deliverySection.getByRole('heading', { name: 'Meta Pixel 与 Conversions API' })).toBeVisible()
    const deliveryItems = deliverySection.locator('[data-health-item]')
    await expect(deliveryItems.filter({ hasText: /^Browser 指令\s*12$/ })).toHaveCount(1)
    await expect(deliveryItems.filter({ hasText: /^Server 已接收\s*9$/ })).toHaveCount(1)
    await expect(page.locator('[data-attribution-section="quality"]').getByRole('heading', { name: '配对与匹配覆盖' })).toBeVisible()
    await expect(page.locator('[data-attribution-section="capacity"]').getByRole('heading', { name: 'UTC 配额日内部估算' })).toBeVisible()
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
    await page.locator('[data-attribution-tabs]').getByRole('link', { name: '平台连接', exact: true }).click()

    await expect(page).toHaveURL(/\/admin\/attribution\/platforms\?provider=meta/)
    await expect(page.getByRole('heading', { name: 'Meta 连接' })).toBeVisible()
    await expect(page.getByText('Pixel ID / Dataset ID', { exact: true })).toBeVisible()
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

  test('签名广告来源上下文通过 Web 同源代理转发且不出现授权界面', async ({ request, page }) => {
    await request.patch(`${apiURL}/api/test/auth`, { data: { authenticated: false } })
    const protectedRequestUrls: string[] = []
    page.on('request', (browserRequest) => {
      if (/\/api\/(ad-attribution|conversions\/events|auth\/register|me)$/.test(new URL(browserRequest.url()).pathname)) {
        protectedRequestUrls.push(browserRequest.url())
      }
    })

    await page.goto('/register?invite=TESTCODE&fbclid=fb-proxy-test')
    await page.waitForLoadState('networkidle')
    await expect(page.getByText(/营销追踪|允许效果分析|拒绝营销分析/)).toHaveCount(0)

    await page.getByRole('button', { name: '打开联系方式' }).click()
    await page.route('https://t.me/**', route => route.abort())
    await page.getByRole('link', { name: /Telegram/ }).click({ noWaitAfter: true })
    await expect.poll(async () => {
      const body = await (await request.get(`${apiURL}/api/test/analytics-events`)).json()
      return body.contextProtectedRequests.some((item: { endpoint?: string }) => item.endpoint === '/api/conversions/events')
    }).toBe(true)
    await page.getByRole('button', { name: '关闭联系方式' }).click()

    await page.getByPlaceholder('英文字母和数字，3-20 位').fill('receiptuser')
    await page.getByPlaceholder('your@email.com').fill('receiptuser@example.test')
    await page.getByPlaceholder('至少 8 位').fill('Password123')
    await page.getByPlaceholder('再次输入密码').fill('Password123')
    await page.getByRole('button', { name: '注册' }).click()
    await expect(page).toHaveURL('/')

    const registrationPayload = await (await request.get(`${apiURL}/api/test/analytics-events`)).json()
    expect(registrationPayload.contextProtectedRequests).toEqual(expect.arrayContaining([
      expect.objectContaining({ endpoint: '/api/conversions/events', cookie: expect.stringContaining('mei_ad_attribution=mock-meta') }),
      expect.objectContaining({ endpoint: '/api/auth/register', cookie: expect.stringContaining('mei_ad_attribution=mock-meta') }),
    ]))

    await request.post(`${apiURL}/api/test/context-protected-requests/clear`)
    await page.reload()
    await page.waitForLoadState('networkidle')

    const reloadPayload = await (await request.get(`${apiURL}/api/test/analytics-events`)).json()
    const reloadSessionRequests = reloadPayload.contextProtectedRequests.filter((item: { endpoint?: string }) => item.endpoint === '/api/me')
    expect(reloadSessionRequests.length).toBeGreaterThan(0)
    expect(reloadSessionRequests.every((item: { cookie?: string }) => /mei_session=(?:mock|renewed)-session/.test(item.cookie || ''))).toBe(true)

    await request.post(`${apiURL}/api/test/context-protected-requests/clear`)
    await page.evaluate(() => fetch('/api/me', { credentials: 'include' }).then(response => response.json()))
    const renewedPayload = await (await request.get(`${apiURL}/api/test/analytics-events`)).json()
    const renewedSessionRequests = renewedPayload.contextProtectedRequests.filter((item: { endpoint?: string }) => item.endpoint === '/api/me')
    expect(renewedSessionRequests.length).toBeGreaterThan(0)
    expect(renewedSessionRequests.every((item: { cookie?: string }) => item.cookie?.includes('mei_session=renewed-session'))).toBe(true)
    expect(protectedRequestUrls.length).toBeGreaterThanOrEqual(4)
    expect(protectedRequestUrls.every(url => new URL(url).origin === new URL(page.url()).origin)).toBe(true)
    expect(protectedRequestUrls.some(url => url.includes('meigallery-api-dev.wajie.workers.dev'))).toBe(false)
  })

  test('TikTok Pixel 仅在 TikTok 来源公开页面加载并发送首次 PageView', async ({ page }) => {
    const pixelId = 'C123456789ABCDEF'
    const scriptRequests: string[] = []
    await page.route('https://analytics.tiktok.com/**', async (route) => {
      scriptRequests.push(route.request().url())
      await route.fulfill({ contentType: 'application/javascript', body: 'window.__tiktokSdkTestLoaded = true' })
    })

    await page.goto('/')
    await expect.poll(() => scriptRequests.length).toBe(0)

    await page.goto('/?ttclid=tiktok-click-test')
    await expect.poll(() => scriptRequests.length).toBe(1)
    expect(scriptRequests[0]).toContain(`sdkid=${pixelId}`)
    expect(scriptRequests[0]).toContain('lib=ttq')
    await expect.poll(() => page.evaluate(() => Boolean((window as Window & { __tiktokSdkTestLoaded?: boolean }).__tiktokSdkTestLoaded))).toBe(true)

    const state = await page.evaluate(() => {
      const script = document.head.querySelector<HTMLScriptElement>('script[src*="analytics.tiktok.com/i18n/pixel/events.js"]')
      const queue = window.ttq as unknown as unknown[] | undefined
      return {
        inHead: Boolean(script),
        async: script?.async,
        referrerPolicy: script?.referrerPolicy,
        queuedPageViews: queue?.filter(item => Array.isArray(item) && item[0] === 'page').length ?? 0,
      }
    })
    expect(state).toEqual({ inHead: true, async: true, referrerPolicy: 'no-referrer', queuedPageViews: 1 })

    await page.goto('/?fbclid=meta-click-test')
    await expect.poll(() => scriptRequests.length).toBe(1)

    await page.goto('/admin')
    await expect.poll(() => scriptRequests.length).toBe(1)
    await expect(page.locator('head script[src*="analytics.tiktok.com"]')).toHaveCount(0)
  })

  test('Web 同源代理完整保留 multipart 二进制字节', async ({ page }) => {
    await page.goto('/')
    const result = await page.evaluate(async () => {
      const marker = new Uint8Array([0x00, 0xff, 0xfe, 0x80, 0x41, 0x42, 0x43])
      const body = new FormData()
      body.append('file', new Blob([marker], { type: 'application/octet-stream' }), 'binary.dat')
      const response = await fetch('/api/test/binary-upload', { method: 'POST', body, credentials: 'include' })
      return response.json() as Promise<{ preserved: boolean; bytes: number }>
    })

    expect(result.preserved).toBe(true)
    expect(result.bytes).toBeGreaterThan(7)
  })
})
