import { expect, test } from '@playwright/test'

const apiURL = process.env.PLAYWRIGHT_API_URL || 'http://127.0.0.1:8788'

test.beforeEach(async ({ request }) => {
  await request.post(`${apiURL}/api/test/reset`)
})

test('统一导航按上下文保留平台和日期，Google 字段完全由 Schema 渲染', async ({ page }) => {
  await page.goto('/admin/attribution/platforms?provider=google')

  const tabs = page.locator('[data-attribution-tabs]')
  for (const label of ['总览', '平台连接', '事件绑定', '投递质量', '验证记录', '审计日志']) {
    await expect(tabs.getByRole('link', { name: label, exact: true })).toBeVisible()
  }
  await expect(page.getByRole('heading', { name: 'Google Ads 连接' })).toBeVisible()
  for (const label of ['Tag ID', 'Customer ID', 'Manager Account ID（可选）', 'Cloud Project']) {
    await expect(page.getByText(label, { exact: true })).toBeVisible()
  }
  await expect(page.getByText('Service Account JSON', { exact: true })).toBeVisible()
  await expect(page.locator('input[type="file"]')).toHaveAttribute('accept', /json/)
  await expect(page.locator('input[type="password"]')).toHaveCount(0)
  await expect(page.locator('input[type="date"]')).toHaveCount(0)

  await tabs.getByRole('link', { name: '事件绑定', exact: true }).click()
  await expect(page).toHaveURL(/\/admin\/attribution\/bindings\?provider=google/)
  for (const label of ['有效联系 Label', '完成注册 Label', '有效联系 Conversion Action ID', '完成注册 Conversion Action ID']) {
    await expect(page.getByText(label, { exact: true })).toBeVisible()
  }
  await expect(page.locator('input[type="date"]')).toHaveCount(0)

  await page.locator('[data-attribution-tabs]').getByRole('link', { name: '投递质量', exact: true }).click()
  await expect(page).toHaveURL(/provider=google/)
  await expect(page).toHaveURL(/range=7d/)
  await expect(page.getByText('Server target', { exact: true }).first()).toBeVisible()
})

test('测试码只在单次验证请求内存在，重新验证必须二次确认', async ({ page, request }) => {
  await page.goto('/admin/attribution/verifications?provider=meta&range=7d')
  const testCode = page.getByLabel('Test Event Code')

  await expect(testCode).toBeVisible()
  await testCode.fill('TEST_PLAYWRIGHT_ONCE')
  await testCode.press('Enter')
  await expect(testCode).toHaveValue('')
  await expect(page.getByText('验证已启动', { exact: true })).toBeVisible()
  await expect(page.getByText('TEST_PLAYWRIGHT_ONCE')).toHaveCount(0)

  await testCode.fill('TEST_PLAYWRIGHT_REVERIFY')
  await page.getByRole('button', { name: '重新验证', exact: true }).click()
  await expect(page.getByText('重新验证会创建新的验证尝试，当前验证记录保留。')).toBeVisible()
  await page.getByRole('button', { name: '确认重新验证', exact: true }).click()
  await expect(testCode).toHaveValue('')
  await expect(page.getByText('重新验证已启动', { exact: true })).toBeVisible()

  const actions = await (await request.get(`${apiURL}/api/test/admin-attribution-actions`)).json()
  expect(actions.actions.filter((item: { type: string }) => item.type === 'verify' || item.type === 'reverify')).toEqual([
    { type: 'verify', provider: 'meta', body: { testEventCode: 'TEST_PLAYWRIGHT_ONCE' } },
    { type: 'reverify', provider: 'meta', body: { testEventCode: 'TEST_PLAYWRIGHT_REVERIFY' } },
  ])
})

test('三平台后台在当前视口没有页面级横向溢出或交互控件重叠', async ({ page }) => {
  await page.goto('/admin/attribution/platforms?provider=google')
  await expect(page.getByRole('heading', { name: 'Google Ads 连接' })).toBeVisible()

  const layout = await page.evaluate(() => {
    const doc = document.documentElement
    const visible = (element: HTMLElement) => {
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
    }
    const controls = [...document.querySelectorAll<HTMLElement>('[data-attribution-page] button, [data-attribution-page] a, [data-attribution-page] input, [data-attribution-page] select')].filter(visible)
    const overlapPairs = controls.flatMap((item, index) => controls.slice(index + 1).flatMap((other) => {
      const first = item.getBoundingClientRect()
      const second = other.getBoundingClientRect()
      const overlapping = Math.min(first.right, second.right) - Math.max(first.left, second.left) > 1
        && Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top) > 1
      return overlapping ? [`${item.tagName}:${item.textContent?.trim() || item.getAttribute('aria-label')} <> ${other.tagName}:${other.textContent?.trim() || other.getAttribute('aria-label')}`] : []
    }))
    return {
      documentOverflow: doc.scrollWidth > doc.clientWidth + 1,
      overlapPairs,
    }
  })

  expect(layout.documentOverflow).toBe(false)
  expect(layout.overlapPairs).toEqual([])
})
