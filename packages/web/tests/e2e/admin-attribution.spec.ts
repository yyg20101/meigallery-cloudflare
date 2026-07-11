import { mkdirSync } from 'node:fs'
import { expect, test } from '@playwright/test'

const apiURL = process.env.PLAYWRIGHT_API_URL || 'http://127.0.0.1:8788'
const artifactDir = 'test-results/admin-attribution'

test.beforeEach(async ({ request }) => {
  await request.post(`${apiURL}/api/test/reset`)
})

test('共享单日 query、五区证据轨与 Meta 操作错误态', async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/admin/attribution')
  await expect(page).toHaveURL(/range=7d/)
  await expect(page.locator('[data-attribution-section]')).toHaveCount(5)
  expect(await page.locator('[data-attribution-section]').evaluateAll(elements => elements.map(element => element.getAttribute('data-attribution-section')))).toEqual([
    'connection', 'business', 'delivery', 'quality', 'rollout',
  ])
  const rail = page.locator('[data-evidence-rail]')
  for (const label of ['站内事实', 'Pixel 尝试', 'CAPI 接收', 'Meta 质量']) await expect(rail).toContainText(label)

  await page.getByRole('button', { name: '单日' }).click()
  await page.getByLabel('选择归因日期').fill('2026-07-10')
  await expect(page).toHaveURL(/range=day&date=2026-07-10/)
  await expect.poll(async () => {
    const response = await request.get(`${apiURL}/api/test/admin-attribution-requests`)
    const body = await response.json()
    return body.requests.filter((item: { query: Record<string, string> }) => item.query.from === '2026-07-10').length
  }).toBeGreaterThanOrEqual(8)
  const requestLog = await (await request.get(`${apiURL}/api/test/admin-attribution-requests`)).json()
  const singleDayRequests = requestLog.requests.filter((item: { query: Record<string, string> }) => item.query.from === '2026-07-10')
  expect(singleDayRequests.every((item: { query: Record<string, string> }) => item.query.to === '2026-07-10')).toBe(true)

  const paths = page.locator('[data-trend-path]')
  expect(await paths.count()).toBeGreaterThan(0)
  for (const path of await paths.all()) expect((await path.getAttribute('d'))?.trim().length).toBeGreaterThan(2)
  await expect(page.getByText('尚未取得 Meta 质量数据')).toBeVisible()
  await expect(page.getByText('Meta 质量 0 分')).toHaveCount(0)

  await request.patch(`${apiURL}/api/test/admin-attribution-action-mode`, { data: { mode: 'conflict' } })
  await page.locator('[data-rollout-percentage="50"]').click()
  const rolloutDialog = page.getByRole('dialog', { name: '确认调整 CAPI rollout' })
  await expect(rolloutDialog).toBeVisible()
  await rolloutDialog.getByRole('button', { name: '确认调整' }).click()
  await expect(rolloutDialog).toContainText('升级门禁未通过')

  await request.patch(`${apiURL}/api/test/admin-attribution-action-mode`, { data: { mode: 'success' } })
  await rolloutDialog.getByRole('button', { name: '强制升级' }).click()
  const forceDialog = page.getByRole('dialog', { name: '强制升级 CAPI rollout' })
  await forceDialog.locator('[data-force-reason]').fill('当前已核对投递指标与回退方案，确认由站长承担本次灰度升级风险。')
  await forceDialog.getByRole('button', { name: '确认强制升级' }).click()
  await expect(forceDialog).toBeHidden()
  await expect(page.locator('[data-meta-rollout-control]')).toContainText('target50%')
  await expect(page.locator('[data-meta-rollout-control]')).toContainText('effective0%')

  await request.patch(`${apiURL}/api/test/admin-attribution-action-mode`, { data: { mode: 'conflict' } })
  await page.locator('[data-close-incident]').click()
  const incidentDialog = page.getByRole('dialog', { name: '关闭 Meta incident' })
  await incidentDialog.locator('[data-incident-resolution]').fill('已完成重试耗尽根因修复，并核对近期投递证据恢复正常。')
  await incidentDialog.getByRole('button', { name: '确认关闭' }).click()
  await expect(incidentDialog).toContainText('关闭门禁未通过')
})

test('三视口无 document overflow、控件重叠且保留可滚动表格', async ({ page }) => {
  mkdirSync(artifactDir, { recursive: true })
  for (const viewport of [
    { width: 360, height: 800, name: '360x800' },
    { width: 768, height: 1024, name: '768x1024' },
    { width: 1440, height: 1000, name: '1440x1000' },
  ]) {
    await page.setViewportSize(viewport)
    await page.goto('/admin/attribution?range=day&date=2026-07-10')
    await expect(page.locator('[data-attribution-section]')).toHaveCount(5)
    await expect(page.locator('[data-trend-path]').first()).toHaveAttribute('d', /^M /)
    const layout = await page.evaluate(() => {
      const doc = document.documentElement
      const isVisible = (element: HTMLElement) => {
        const style = getComputedStyle(element)
        const rect = element.getBoundingClientRect()
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0
      }
      const actions = [...document.querySelectorAll<HTMLElement>('[data-attribution-page] button, [data-attribution-page] a, [data-attribution-page] input')]
        .filter(isVisible)
      const overlap = actions.some((item, index) => actions.slice(index + 1).some((other) => {
        const a = item.getBoundingClientRect()
        const b = other.getBoundingClientRect()
        return Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1
          && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1
      }))
      const clippedButtons = [...document.querySelectorAll<HTMLElement>('button')].filter((button) => {
        const rect = button.getBoundingClientRect()
        if (rect.right <= 0 || rect.left >= doc.clientWidth || rect.bottom <= 0) return false
        if (button.closest('[class*="overflow-x-auto"]')) return button.scrollWidth > button.clientWidth + 1
        return rect.width > 0 && (button.scrollWidth > button.clientWidth + 1 || rect.left < -1 || rect.right > doc.clientWidth + 1)
      }).map(button => button.textContent?.trim())
      const clippedText = [...document.querySelectorAll<HTMLElement>('[data-attribution-header] h1, [data-attribution-header] p, [data-attribution-section] h2, [data-attribution-section] h3, [data-attribution-section] p, [data-attribution-section] dt, [data-attribution-section] dd')]
        .filter(element => isVisible(element) && !element.closest('[class*="overflow-x-auto"]') && !element.classList.contains('sr-only'))
        .filter((element) => {
          const rect = element.getBoundingClientRect()
          return element.scrollWidth > element.clientWidth + 1 || rect.left < -1 || rect.right > doc.clientWidth + 1
        })
        .map(element => element.textContent?.trim())
      const uncontainedTables = [...document.querySelectorAll<HTMLElement>('[data-attribution-page] table')]
        .filter(table => table.scrollWidth > table.clientWidth + 1)
        .filter((table) => {
          const container = table.closest<HTMLElement>('[class*="overflow-x-auto"]')
          if (!container) return true
          const rect = container.getBoundingClientRect()
          return rect.left < -1 || rect.right > doc.clientWidth + 1
        }).length
      return { documentOverflow: doc.scrollWidth > doc.clientWidth + 1, overlap, clippedButtons, clippedText, uncontainedTables }
    })
    expect(layout).toEqual({
      documentOverflow: false,
      overlap: false,
      clippedButtons: [],
      clippedText: [],
      uncontainedTables: 0,
    })
    await page.screenshot({ path: `${artifactDir}/${viewport.name}.png`, fullPage: true })
  }
})
