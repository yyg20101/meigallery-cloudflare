import { expect, test } from '@playwright/test'

const apiURL = process.env.PLAYWRIGHT_API_URL || 'http://127.0.0.1:8788'

test.use({
  viewport: { width: 375, height: 812 },
  isMobile: true,
  hasTouch: true,
})

test.beforeEach(async ({ request }) => {
  await request.post(`${apiURL}/api/test/reset`)
})

async function expectNoPageOverflow(
  page: import('@playwright/test').Page,
) {
  expect(await page.evaluate(() => ({
    document: document.documentElement.scrollWidth
      <= document.documentElement.clientWidth + 1,
    body: document.body.scrollWidth <= document.body.clientWidth + 1,
  }))).toEqual({ document: true, body: true })
}

test('375x812 下控制面主体不溢出且导航独立横向滚动', async ({ page }) => {
  await page.goto('/admin/attribution/connections/conn_meta_a')
  await expect(page.getByRole('heading', { name: 'Meta 美国 BJ 团队' }))
    .toBeVisible()

  await expectNoPageOverflow(page)
  expect(await page.locator('[data-attribution-tabs]').evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      scrollable: element.scrollWidth > element.clientWidth,
      overflowX: style.overflowX,
    }
  })).toEqual({
    scrollable: true,
    overflowX: 'auto',
  })

  await expect(page.getByLabel('启用此连接')).toBeChecked()
  await expect(page.getByLabel('Browser 投递')).toBeChecked()
  await expect(page.getByLabel('Server 投递')).toBeChecked()
  await expect(page.getByRole('group', { name: 'Server 灰度比例' }))
    .toBeVisible()
})

test('危险操作确认弹窗锁定焦点并可无副作用取消', async ({ page }) => {
  await page.goto('/admin/attribution/connections/conn_meta_a')
  await page.getByRole('button', { name: '回滚上一生产版本' }).click()

  const dialog = page.getByRole('alertdialog', { name: '确认回滚' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText(
    '确认回滚到上一生产版本？当前运行策略保持不变。',
    { exact: true },
  )).toBeVisible()

  for (let index = 0; index < 6; index += 1) {
    await page.keyboard.press('Tab')
    expect(await dialog.evaluate(
      element => element.contains(document.activeElement),
    )).toBe(true)
  }

  await dialog.getByRole('button', { name: '取消' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByText('生产运行', { exact: true })).toBeVisible()
  await expectNoPageOverflow(page)
})
