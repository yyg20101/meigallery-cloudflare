import { expect, test } from '@playwright/test'

const apiURL = process.env.PLAYWRIGHT_API_URL || 'http://127.0.0.1:8788'
const runtimeBase = `${apiURL}/api/admin/attribution-runtime`

test.beforeEach(async ({ request }) => {
  await request.post(`${apiURL}/api/test/reset`)
})

test('候选验证失败不影响 Active 身份和运行策略', async ({ page, request }) => {
  await page.goto('/admin/attribution/connections/conn_meta_a')

  await expect(page.getByRole('heading', { name: 'Meta 美国 BJ 团队' }))
    .toBeVisible()
  await expect(page.getByText('1615446443914929', { exact: true }))
    .toBeVisible()
  await expect(page.getByLabel('Browser 投递')).toBeChecked()
  await expect(page.getByLabel('Server 投递')).toBeChecked()

  await page.getByLabel('Pixel ID / Dataset ID').fill('00000')
  await page.getByRole('button', { name: '保存并自动验证' }).click()

  await expect(page.getByText('验证未通过', { exact: true })).toBeVisible()
  await expect(page.getByText(
    '候选配置未替换生产版本，当前生产版本继续运行。',
    { exact: true },
  )).toBeVisible()
  await expect(page.getByText('1615446443914929', { exact: true }))
    .toBeVisible()
  await expect(page.getByLabel('Browser 投递')).toBeChecked()
  await expect(page.getByLabel('Server 投递')).toBeChecked()
  const runtime = page.locator('[data-test="runtime-policy-panel"]')
  await expect(runtime.getByText('目标比例').locator('..')
    .getByText('10%', { exact: true })).toBeVisible()
  await expect(runtime.getByText('当前生效').locator('..')
    .getByText('10%', { exact: true })).toBeVisible()

  const commands = await (
    await request.get(`${apiURL}/api/test/admin-attribution-commands`)
  ).json()
  expect(commands.writesByType.createCandidate).toBe(1)
})

test('运行策略重复提交和相同幂等键重放都只写入一次', async ({
  page,
  request,
}) => {
  await page.goto('/admin/attribution/connections/conn_meta_a')

  await page.getByRole('group', { name: 'Server 灰度比例' })
    .getByRole('button', { name: '50%' })
    .click()
  await page.getByRole('button', { name: '保存运行策略' }).dblclick()
  await expect(page.getByText('运行策略已更新', { exact: true }).first())
    .toBeVisible()

  let commands = await (
    await request.get(`${apiURL}/api/test/admin-attribution-commands`)
  ).json()
  expect(commands.writesByType.setRuntimePolicy).toBe(1)
  expect(
    commands.commands.filter(
      (command: { type: string }) => command.type === 'setRuntimePolicy',
    ),
  ).toEqual([
    expect.objectContaining({ requests: 1, writes: 1 }),
  ])

  const headers = { 'Idempotency-Key': 'playwright-runtime-replay' }
  const data = {
    enabled: true,
    browserEnabled: true,
    serverEnabled: true,
    serverTargetPercentage: 100,
  }
  const first = await request.patch(
    `${runtimeBase}/connections/conn_meta_a/runtime-policy`,
    { headers, data },
  )
  const replay = await request.patch(
    `${runtimeBase}/connections/conn_meta_a/runtime-policy`,
    { headers, data },
  )

  expect(first.status()).toBe(200)
  expect(replay.status()).toBe(200)
  expect(await replay.json()).toEqual(await first.json())

  commands = await (
    await request.get(`${apiURL}/api/test/admin-attribution-commands`)
  ).json()
  expect(commands.commands).toContainEqual(expect.objectContaining({
    key: 'playwright-runtime-replay',
    type: 'setRuntimePolicy',
    requests: 2,
    writes: 1,
  }))
})

test('同一平台多连接并列展示，单日和连接上下文跨页面保留', async ({
  page,
  request,
}) => {
  await page.goto('/admin/attribution/connections?provider=meta')

  await expect(page.getByText('Meta 美国 BJ 团队', { exact: true }))
    .toBeVisible()
  await expect(page.getByText('Meta 美国 WA 团队', { exact: true }))
    .toBeVisible()
  await expect(page.getByText('TikTok 美国团队', { exact: true }))
    .toHaveCount(0)

  await page.goto(
    '/admin/attribution?range=day&date=2026-07-23'
    + '&provider=meta&connectionId=conn_meta_b',
  )
  await expect(page.getByRole('combobox', { name: '平台' }))
    .toHaveValue('meta')
  await expect(page.getByRole('combobox', { name: '连接' }))
    .toHaveValue('conn_meta_b')
  await expect(page.getByLabel('选择归因日期')).toHaveValue('2026-07-23')
  await expect(page.locator('[data-attribution-section="quality"]')
    .getByRole('cell', { name: 'Meta 美国 WA 团队', exact: true }))
    .toBeVisible()

  await page.locator('[data-attribution-tabs]')
    .getByRole('link', { name: '投递质量', exact: true })
    .click()
  await expect(page).toHaveURL(/\/admin\/attribution\/deliveries/)
  await expect(page).toHaveURL(/range=day/)
  await expect(page).toHaveURL(/date=2026-07-23/)
  await expect(page).toHaveURL(/provider=meta/)
  await expect(page).toHaveURL(/connectionId=conn_meta_b/)
  await expect(page.getByRole('cell', {
    name: '2026-07-23',
    exact: true,
  })).toBeVisible()

  const requests = await (
    await request.get(`${apiURL}/api/test/admin-attribution-requests`)
  ).json()
  expect(requests.requests).toContainEqual({
    path: '/api/admin/attribution-runtime/operations',
    query: expect.objectContaining({
      dateFrom: '2026-07-23',
      dateTo: '2026-07-23',
      provider: 'meta',
      connectionId: 'conn_meta_b',
    }),
  })
})
