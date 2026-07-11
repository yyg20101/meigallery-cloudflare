import { mkdirSync } from 'node:fs'
import { expect, test } from '@playwright/test'

const apiURL = process.env.PLAYWRIGHT_API_URL || 'http://127.0.0.1:8788'
const artifactDir = 'test-results/admin-attribution'
type AttributionRequest = { path: string; query: Record<string, string> }

const singleDayEndpointQueries = new Map<string, Record<string, string>>([
  ['/api/admin/attribution/summary', { from: '2026-07-10', to: '2026-07-10' }],
  ['/api/admin/attribution/trends', { from: '2026-07-10', to: '2026-07-10', granularity: 'day' }],
  ['/api/admin/attribution/quality', { from: '2026-07-10', to: '2026-07-10' }],
  ['/api/admin/attribution/breakdown', { from: '2026-07-10', to: '2026-07-10', dimension: 'utm_campaign', limit: '8' }],
  ['/api/admin/attribution/meta/status', { from: '2026-07-10', to: '2026-07-10' }],
  ['/api/admin/attribution/readiness', { from: '2026-07-10', to: '2026-07-10' }],
  ['/api/admin/attribution/duplicates', { from: '2026-07-10', to: '2026-07-10' }],
  ['/api/admin/attribution/meta/incidents', { from: '2026-07-10', to: '2026-07-10', status: 'all', limit: '20' }],
])

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

  const fbpPath = page.locator('[data-trend-path][data-series-key="fbp.rate"]')
  await expect(fbpPath).toHaveCount(1)
  const fbpPathData = await fbpPath.getAttribute('d') || ''
  expect(fbpPathData.match(/\bM\b/g)).toHaveLength(2)
  expect(fbpPathData).not.toMatch(/\bL\b/)
  await expect(page.locator('[data-trend-marker][data-series-key="fbp.rate"]')).toHaveCount(2)
  await expect(page.locator('[data-attribution-chart]', { has: fbpPath })).toHaveAttribute('aria-label', /fbp .*缺失 1 个样本，缺失处不连线且不显示数据点/)

  const legendContracts = await page.locator('[data-attribution-trend]').evaluateAll(panels => panels.flatMap(panel => (
    [...panel.querySelectorAll<SVGPathElement>('[data-trend-path]')].map((path) => {
      const key = path.dataset.seriesKey || ''
      const legends = panel.querySelectorAll<SVGSVGElement>(`[data-trend-legend-swatch][data-series-key="${key}"]`)
      const legendLine = legends[0]?.querySelector<SVGLineElement>('[data-trend-legend-line]')
      const legendMarker = legends[0]?.querySelector<SVGCircleElement>('[data-trend-legend-marker]')
      const chartMarker = panel.querySelector<SVGCircleElement>(`[data-trend-marker][data-series-key="${key}"]`)
      return {
        legendCount: legends.length,
        lineMatches: Boolean(legendLine)
          && legendLine.getAttribute('stroke') === path.getAttribute('stroke')
          && legendLine.getAttribute('stroke-dasharray') === path.getAttribute('stroke-dasharray')
          && legendLine.getAttribute('opacity') === path.getAttribute('opacity'),
        markerMatches: Boolean(legendMarker && chartMarker)
          && legendMarker!.getAttribute('r') === chartMarker!.getAttribute('r')
          && legendMarker!.getAttribute('fill') === chartMarker!.getAttribute('fill')
          && legendMarker!.getAttribute('stroke') === chartMarker!.getAttribute('stroke')
          && legendMarker!.getAttribute('opacity') === chartMarker!.getAttribute('opacity'),
      }
    })
  )))
  expect(legendContracts.length).toBeGreaterThan(0)
  expect(legendContracts.every(contract => contract.legendCount === 1 && contract.lineMatches && contract.markerMatches)).toBe(true)

  await page.getByRole('button', { name: '单日' }).click()
  await expect(page).toHaveURL(/range=day&date=/)
  await request.post(`${apiURL}/api/test/admin-attribution-requests/clear`)
  await page.getByLabel('选择归因日期').fill('2026-07-10')
  await expect(page).toHaveURL(/range=day&date=2026-07-10/)
  await expect.poll(async () => {
    const response = await request.get(`${apiURL}/api/test/admin-attribution-requests`)
    const body = await response.json()
    return body.requests.length
  }).toBe(singleDayEndpointQueries.size)
  const requestLog = await (await request.get(`${apiURL}/api/test/admin-attribution-requests`)).json() as { requests: AttributionRequest[] }
  expect(requestLog.requests).toHaveLength(singleDayEndpointQueries.size)
  for (const [path, query] of singleDayEndpointQueries) {
    const matches = requestLog.requests.filter(item => item.path === path)
    expect(matches, path).toHaveLength(1)
    expect(matches[0]?.query, path).toEqual(query)
  }

  const paths = page.locator('[data-trend-path]')
  expect(await paths.count()).toBeGreaterThan(0)
  for (const path of await paths.all()) expect((await path.getAttribute('d'))?.trim().length).toBeGreaterThan(2)
  await expect(page.locator('[data-trend-marker]').first()).toBeVisible()
  await expect(page.getByText('尚未取得 Meta 质量数据')).toBeVisible()
  await expect(page.getByText('Meta 质量 0 分')).toHaveCount(0)

  await request.patch(`${apiURL}/api/test/admin-attribution-dataset-scenario`, { data: { scenario: 'error' } })
  await page.reload()
  await expect(page.getByText('Meta 质量数据采集失败')).toBeVisible()

  const forceReason = '当前已核对投递指标与回退方案确认由站长承担本次灰度升级风险并持续观察'
  const hardBlocked = await request.post(`${apiURL}/api/admin/attribution/meta/rollout`, {
    data: { percentage: 50, force: true, reason: forceReason },
  })
  expect(hardBlocked.status()).toBe(409)
  await expect(page.locator('[data-rollout-percentage="50"]')).toBeDisabled()
  await expect(page.locator('[data-rollout-hard-blockers]')).toContainText('critical incident 尚未关闭')

  await request.patch(`${apiURL}/api/test/admin-attribution-action-mode`, { data: { mode: 'conflict' } })
  await page.locator('[data-close-incident]').click()
  const incidentDialog = page.getByRole('dialog', { name: '关闭 Meta incident' })
  await incidentDialog.locator('[data-incident-resolution]').fill('已完成重试耗尽根因修复，并核对近期投递证据恢复正常。')
  await incidentDialog.getByRole('button', { name: '确认关闭' }).click()
  await expect(incidentDialog).toContainText('关闭门禁未通过')

  await request.patch(`${apiURL}/api/test/admin-attribution-action-mode`, { data: { mode: 'success' } })
  await request.patch(`${apiURL}/api/test/admin-attribution-rollout-scenario`, { data: { scenario: 'metric-only', target: 10 } })
  await page.reload()
  await page.locator('[data-rollout-percentage="50"]').click()
  const rolloutDialog = page.getByRole('dialog', { name: '确认调整 CAPI rollout' })
  await expect(rolloutDialog).toBeVisible()
  await rolloutDialog.getByRole('button', { name: '确认调整' }).click()
  await expect(rolloutDialog).toContainText('rollout 状态已变化或升级门禁未通过')

  await rolloutDialog.getByRole('button', { name: '强制升级' }).click()
  const forceDialog = page.getByRole('dialog', { name: '强制升级 CAPI rollout' })
  await forceDialog.locator('[data-force-reason]').fill(forceReason)
  await forceDialog.getByRole('button', { name: '确认强制升级' }).click()
  await expect(forceDialog).toBeHidden()
  await expect(page.locator('[data-meta-rollout-control]')).toContainText('target50%')
  await expect(page.locator('[data-meta-rollout-control]')).toContainText('effective50%')

  const actionLog = await (await request.get(`${apiURL}/api/test/admin-attribution-actions`)).json() as { actions: Array<{ type: string; body: Record<string, unknown> }> }
  expect(actionLog.actions).toEqual([
    { type: 'rollout', body: { percentage: 50, force: true, reason: forceReason } },
    { type: 'rollout', body: { percentage: 50, force: false, reason: '' } },
    { type: 'rollout', body: { percentage: 50, force: true, reason: forceReason } },
  ])
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
    const marker = page.locator('[data-trend-marker]').first()
    await expect(marker).toBeVisible()
    const markerBox = await marker.boundingBox()
    expect(markerBox?.width).toBeGreaterThan(0)
    expect(markerBox?.height).toBeGreaterThan(0)
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
      const chartScroll = document.querySelector<HTMLElement>('[data-chart-scroll]')!
      const chartRect = chartScroll.getBoundingClientRect()
      const initialScrollLeft = chartScroll.scrollLeft
      chartScroll.scrollLeft = chartScroll.scrollWidth
      const movedScrollLeft = chartScroll.scrollLeft
      chartScroll.scrollLeft = initialScrollLeft
      return {
        documentOverflow: doc.scrollWidth > doc.clientWidth + 1,
        overlap,
        clippedButtons,
        clippedText,
        uncontainedTables,
        chartOverflowX: getComputedStyle(chartScroll).overflowX,
        chartContained: chartRect.left >= -1 && chartRect.right <= doc.clientWidth + 1,
        chartScrollable: chartScroll.scrollWidth > chartScroll.clientWidth + 1,
        chartScrollMoved: movedScrollLeft > initialScrollLeft,
      }
    })
    expect(layout.documentOverflow).toBe(false)
    expect(layout.overlap).toBe(false)
    expect(layout.clippedButtons).toEqual([])
    expect(layout.clippedText).toEqual([])
    expect(layout.uncontainedTables).toBe(0)
    expect(layout.chartOverflowX).toBe('auto')
    expect(layout.chartContained).toBe(true)
    expect(layout.chartScrollable).toBe(viewport.width === 360)
    expect(layout.chartScrollMoved).toBe(viewport.width === 360)
    await page.screenshot({ path: `${artifactDir}/${viewport.name}.png`, fullPage: true })
  }
})
