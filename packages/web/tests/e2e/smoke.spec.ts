import { expect, test } from '@playwright/test'

const smokePages = [
  { path: '/', heading: /精选写真/ },
  { path: '/search?q=夏日', heading: /搜索写真/, title: '搜索: 夏日 - 测试图库站' },
  { path: '/gallery/summer-portrait', heading: /夏日授权写真/, title: '夏日授权写真 - 测试图库站' },
  { path: '/login', heading: /登录 测试图库站/, title: '登录 - 测试图库站' },
  { path: '/user', heading: /会员权益/, title: '个人中心 - 测试图库站' },
  { path: '/admin', heading: /数据概览/ },
]

test.describe('核心页面 smoke', () => {
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
        await expect(homeAd.getByText('会员季精选内容精选内容精选内容')).toBeVisible()
        await expect(homeAd.getByRole('link', { name: '查看推荐' })).toHaveAttribute('href', '/discover?sort=hot')
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

  test('后台更新站点 SEO 后首页立即读取新标题', async ({ page }) => {
    await page.goto('/admin/settings')

    await page.getByLabel('站点名称').fill('运营新站名')
    await page.getByLabel('站点描述').fill('后台保存后的新站点描述')
    await page.getByLabel('SEO 标题').fill('运营新标题 - 首页')
    await page.getByLabel('OG 标题').fill('运营新 OG 标题')
    await page.getByLabel('OG 描述').fill('运营新 OG 描述')
    await page.getByRole('button', { name: '保存设置' }).click()

    await expect(page.getByText('设置已保存')).toBeVisible()
    await page.goto('/')

    await expect(page).toHaveTitle('运营新标题 - 首页')
    await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', '后台保存后的新站点描述')
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', '运营新 OG 标题')
    await expect(page.locator('meta[property="og:description"]')).toHaveAttribute('content', '运营新 OG 描述')
    await expect(page).not.toHaveTitle('MeiGallery - 精选写真图库')
  })
})
