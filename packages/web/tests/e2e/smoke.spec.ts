import { expect, test } from '@playwright/test'

const smokePages = [
  { path: '/', heading: /精选写真/ },
  { path: '/search?q=夏日', heading: /搜索写真/ },
  { path: '/gallery/summer-portrait', heading: /夏日授权写真/ },
  { path: '/login', heading: /登录 MeiGallery/ },
  { path: '/user', heading: /会员权益/ },
  { path: '/admin', heading: /数据概览/ },
]

test.describe('核心页面 smoke', () => {
  for (const smokePage of smokePages) {
    test(`${smokePage.path} 可渲染且无横向溢出`, async ({ page }) => {
      await page.goto(smokePage.path)

      await expect(page.getByRole('heading', { name: smokePage.heading }).first()).toBeVisible()
      if (smokePage.path === '/admin') {
        await expect(page.getByText('DEV 测试环境：')).toBeVisible()
        await expect(page.getByText('当前后台连接正式 D1/R2 数据')).toBeVisible()
      }
      if (smokePage.path === '/') {
        const homeAd = page.getByRole('region', { name: '首页广告推荐' })
        await expect(homeAd.getByText('会员季精选内容')).toBeVisible()
        await expect(homeAd.getByRole('link', { name: '查看推荐' })).toHaveAttribute('href', '/discover?sort=hot')
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
})
