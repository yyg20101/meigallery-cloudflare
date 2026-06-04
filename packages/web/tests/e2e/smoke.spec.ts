import { expect, test } from '@playwright/test'

const apiURL = process.env.PLAYWRIGHT_API_URL || 'http://127.0.0.1:8788'
const longAdHostname = 'verylongsponsoredcampaignlandingdestination.example.com'
const longAdUrl = `https://${longAdHostname}/sponsor-campaign`

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
        await expect(page.getByText('当前后台连接正式 D1/R2 数据')).toBeVisible()
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
    await page.goto('/admin/settings')

    await page.locator('input[placeholder="/discover?sort=hot"]').fill(longAdUrl)
    await page.locator('input[placeholder="查看推荐"]').fill('查看赞助')

    const preview = page.getByRole('region', { name: '首页广告推荐' })
    const previewCta = preview.locator('[aria-disabled="true"]')

    await expect(preview).toBeVisible()
    await expect(previewCta).toContainText('查看赞助')
    await expect(previewCta).toHaveAttribute('aria-describedby', /home-ad-external-note$/)
    await expect(preview.getByText('外部链接')).toBeVisible()
    await expect(preview.getByText(`目标域名 ${longAdHostname}`)).toBeVisible()
    await expect(preview.getByText('不发送来源页信息')).toBeVisible()
    await expect(preview.locator(`a[href="${longAdUrl}"]`)).toHaveCount(0)

    const hasHorizontalOverflow = await page.evaluate(() => {
      const doc = document.documentElement
      return doc.scrollWidth > doc.clientWidth + 1
    })
    expect(hasHorizontalOverflow).toBe(false)
  })

  test('后台更新站点 SEO 后首页立即读取新标题', async ({ page }) => {
    await page.goto('/admin/settings')

    const publicSeoSync = page.getByRole('region', { name: '前台同步状态' })
    await expect(publicSeoSync.getByRole('heading', { name: '前台同步状态' })).toBeVisible()
    await expect(publicSeoSync.getByText('公开 SEO 标题')).toBeVisible()
    await expect(publicSeoSync.getByText('测试站点标题 - 首页 SEO')).toBeVisible()

    await page.getByLabel('站点名称').fill('运营新站名')
    await page.getByLabel('站点描述').fill('后台保存后的新站点描述')
    await page.getByLabel('SEO 标题').fill('运营新标题 - 首页')
    await page.getByLabel('OG 标题').fill('运营新 OG 标题')
    await page.getByLabel('OG 描述').fill('运营新 OG 描述')

    await expect(publicSeoSync.getByText('待同步', { exact: true })).toBeVisible()
    await expect(publicSeoSync.getByText('前台公开读取值与当前表单不一致，保存后会重新校验公开设置。')).toBeVisible()

    await page.getByRole('button', { name: '保存设置' }).click()

    await expect(page.getByText('设置已保存，前台公开 SEO 已同步')).toBeVisible()
    await expect(publicSeoSync.getByText('已同步', { exact: true })).toBeVisible()
    await expect(publicSeoSync.getByText('运营新标题 - 首页')).toBeVisible()
    await expect(publicSeoSync.getByText('后台保存后的新站点描述')).toBeVisible()
    await page.goto('/')

    await expect(page).toHaveTitle('运营新标题 - 首页')
    await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', '后台保存后的新站点描述')
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', '运营新 OG 标题')
    await expect(page.locator('meta[property="og:description"]')).toHaveAttribute('content', '运营新 OG 描述')
    await expect(page).not.toHaveTitle('MeiGallery - 精选写真图库')
  })
})
