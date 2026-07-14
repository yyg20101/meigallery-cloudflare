import { Hono, type Context } from 'hono'
import type { AdPlatformProvider } from '@meigallery/shared'
import type { Bindings, Variables } from '../../index'
import { getMetaConnectionStatus } from '../../services/meta-connection'
import { listAdPlatformConnections } from '../../services/ad-platform/status'
import {
  requireVerifiedTikTokConnection,
  verifyTikTokConnection,
} from '../../services/tiktok-connection'
import { loadTikTokEventsCryptoKeys } from '../../utils/tiktok-events-crypto'
import { errorJson } from '../../utils/api-error'
import { generateId } from '../../utils/db'

type AdminAdPlatformContext = Context<{ Bindings: Bindings; Variables: Variables }>
type ConfigurableProvider = Extract<AdPlatformProvider, 'meta' | 'tiktok'>

export const adminAdPlatformRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

adminAdPlatformRoutes.get('/', async (c) => {
  try {
    return c.json({ data: await listAdPlatformConnections(c.env) })
  }
  catch {
    return errorJson(c, 503, '归因看板数据暂时不可用', { code: 'ATTRIBUTION_DASHBOARD_UNAVAILABLE' })
  }
})

adminAdPlatformRoutes.post('/:provider/verify', async (c) => {
  if (c.get('userRole') !== 'owner') {
    return errorJson(c, 403, '需要站长权限', { code: 'OWNER_REQUIRED' })
  }
  if (c.env.APP_ENV !== 'production') {
    return errorJson(c, 409, '广告平台连接只允许在生产环境验证', { code: 'AD_PLATFORM_PRODUCTION_ONLY' })
  }
  if (c.req.param('provider') !== 'tiktok') {
    return errorJson(c, 404, '该平台不使用此验证入口', { code: 'AD_PLATFORM_VERIFICATION_UNSUPPORTED' })
  }

  const body = await c.req.json<Record<string, unknown>>()
  try {
    const result = await verifyTikTokConnection(c.env, {
      testEventCode: String(body.testEventCode || ''),
    })
    await c.env.DB.prepare(`
      INSERT INTO admin_audit_logs
        (id, admin_id, action, target_type, target_id, before_value, after_value)
      VALUES (?, ?, ?, 'ad_platform_connection', 'tiktok', '{}', ?)
    `).bind(
      generateId('log'),
      c.get('userId')!,
      result.idempotent ? 'test_ad_platform_connection' : 'verify_ad_platform_connection',
      JSON.stringify({
        verified: true,
        idempotent: result.idempotent,
        verifiedAt: result.verifiedAt,
        revision: result.revision,
        testEventsSent: result.testEventsSent,
      }),
    ).run()
    return c.json({ data: result })
  }
  catch (error) {
    const code = error instanceof Error ? error.message : ''
    if (code === 'TIKTOK_TEST_EVENT_CODE_INVALID') {
      return errorJson(c, 400, 'TikTok Test Event Code 无效', { code })
    }
    if (code === 'TIKTOK_VERIFICATION_REJECTED' || code === 'TIKTOK_VERIFICATION_NETWORK_ERROR') {
      return errorJson(c, 502, 'TikTok 未接受测试事件，请检查 token、Pixel ID 和测试码', { code })
    }
    return errorJson(c, 409, 'TikTok 连接尚未满足验证条件', { code: code || 'TIKTOK_VERIFICATION_BLOCKED' })
  }
})

adminAdPlatformRoutes.patch('/:provider', async (c) => {
  if (c.get('userRole') !== 'owner') {
    return errorJson(c, 403, '需要站长权限', { code: 'OWNER_REQUIRED' })
  }
  if (c.env.APP_ENV !== 'production') {
    return errorJson(c, 409, '广告平台连接只允许在生产环境配置', { code: 'AD_PLATFORM_PRODUCTION_ONLY' })
  }

  const provider = configurableProvider(c.req.param('provider'))
  if (!provider) {
    return errorJson(c, 404, '广告平台连接不存在', { code: 'AD_PLATFORM_NOT_SUPPORTED' })
  }
  const body = await c.req.json<Record<string, unknown>>()
  const result = provider === 'meta'
    ? await updateMetaConnection(c, body)
    : await updateTikTokConnection(c, body)
  if (result) return result
  return c.json({ data: await listAdPlatformConnections(c.env) })
})

async function updateMetaConnection(c: AdminAdPlatformContext, body: Record<string, unknown>) {
  const destinationId = String(body.destinationId ?? '').trim()
  const mode = String(body.mode ?? '')
  const rolloutPercentage = Number(body.rolloutPercentage)
  if (!/^\d{5,30}$/.test(destinationId)) {
    return errorJson(c, 400, 'Meta Dataset ID 无效', { code: 'AD_PLATFORM_DESTINATION_INVALID' })
  }
  if (!isTrackingMode(mode)) {
    return errorJson(c, 400, 'Meta 运行模式无效', { code: 'AD_PLATFORM_MODE_INVALID' })
  }
  if (!isRolloutPercentage(rolloutPercentage)) {
    return errorJson(c, 400, 'Meta 服务端放量比例无效', { code: 'AD_PLATFORM_ROLLOUT_INVALID' })
  }

  const enabled = body.enabled === true
  const browserEnabled = body.browserEnabled === true
  const serverEnabled = body.serverEnabled === true
  const debugEnabled = body.debugEnabled === true
  const before = await readConnectionSnapshot(c.env.DB, 'meta')
  if (!before) return errorJson(c, 409, 'Meta 连接尚未初始化', { code: 'AD_PLATFORM_CONNECTION_MISSING' })

  const identityChanged = before.destination_id !== destinationId
  if (serverEnabled) {
    const status = await getMetaConnectionStatus(c.env)
    if (identityChanged || status.state !== 'verified' || mode !== 'production') {
      return errorJson(c, 409, '必须先以当前连接完成验证并切换生产模式，才能启用 Server API', {
        code: 'AD_PLATFORM_SERVER_GATE_BLOCKED',
      })
    }
  }

  const after = { enabled, mode, browserEnabled, serverEnabled, destinationId, debugEnabled, rolloutPercentage }
  await c.env.DB.batch([
    c.env.DB.prepare(`
      UPDATE ad_platform_connections
      SET enabled = ?, mode = ?, browser_enabled = ?, server_enabled = ?,
        destination_id = ?, debug_enabled = ?, rollout_percentage = ?,
        revision = CASE WHEN ? THEN NULL ELSE revision END,
        updated_at = datetime('now')
      WHERE provider = 'meta'
    `).bind(
      enabled ? 1 : 0,
      mode,
      browserEnabled ? 1 : 0,
      serverEnabled ? 1 : 0,
      destinationId,
      debugEnabled ? 1 : 0,
      rolloutPercentage,
      identityChanged ? 1 : 0,
    ),
    c.env.DB.prepare(`
      UPDATE meta_connection_verifications
      SET invalidated_at = CASE WHEN ? THEN datetime('now') ELSE invalidated_at END,
        invalidation_reason = CASE WHEN ? THEN 'connection_configuration_changed' ELSE invalidation_reason END,
        updated_at = datetime('now')
      WHERE environment = 'production' AND ?
    `).bind(identityChanged ? 1 : 0, identityChanged ? 1 : 0, identityChanged ? 1 : 0),
    auditConnectionUpdate(c, 'meta', before, after),
  ])
}

async function updateTikTokConnection(c: AdminAdPlatformContext, body: Record<string, unknown>) {
  const destinationId = String(body.destinationId ?? '').trim().toUpperCase()
  const mode = String(body.mode ?? '')
  const rolloutPercentage = Number(body.rolloutPercentage)
  if (!/^[A-Z0-9]{10,30}$/.test(destinationId)) {
    return errorJson(c, 400, 'TikTok Pixel ID 无效', { code: 'AD_PLATFORM_DESTINATION_INVALID' })
  }
  if (!isTrackingMode(mode)) {
    return errorJson(c, 400, 'TikTok 运行模式无效', { code: 'AD_PLATFORM_MODE_INVALID' })
  }
  if (!isRolloutPercentage(rolloutPercentage)) {
    return errorJson(c, 400, 'TikTok 服务端放量比例无效', { code: 'AD_PLATFORM_ROLLOUT_INVALID' })
  }

  const enabled = body.enabled === true
  const browserEnabled = body.browserEnabled === true
  const serverEnabled = body.serverEnabled === true
  const debugEnabled = body.debugEnabled === true
  const before = await readConnectionSnapshot(c.env.DB, 'tiktok')
  if (!before) return errorJson(c, 409, 'TikTok 连接尚未初始化', { code: 'AD_PLATFORM_CONNECTION_MISSING' })

  const identityChanged = before.destination_id !== destinationId
  if (serverEnabled) {
    try {
      const verified = await requireVerifiedTikTokConnection(c.env)
      if (identityChanged || verified.pixelId !== destinationId || mode !== 'production') throw new Error()
      if (!c.env.TIKTOK_EVENTS_QUEUE) throw new Error()
      await loadTikTokEventsCryptoKeys(c.env)
    }
    catch {
      return errorJson(c, 409, '必须先验证当前连接并配置 TikTok Queue 与数据密钥，才能启用 Events API', {
        code: 'AD_PLATFORM_SERVER_GATE_BLOCKED',
      })
    }
  }

  const after = { enabled, mode, browserEnabled, serverEnabled, destinationId, debugEnabled, rolloutPercentage }
  await c.env.DB.batch([
    c.env.DB.prepare(`
      UPDATE ad_platform_connections
      SET enabled = ?, mode = ?, browser_enabled = ?, server_enabled = ?,
        destination_id = ?, debug_enabled = ?, rollout_percentage = ?,
        revision = CASE WHEN ? THEN NULL ELSE revision END,
        updated_at = datetime('now')
      WHERE provider = 'tiktok'
    `).bind(
      enabled ? 1 : 0,
      mode,
      browserEnabled ? 1 : 0,
      serverEnabled ? 1 : 0,
      destinationId,
      debugEnabled ? 1 : 0,
      rolloutPercentage,
      identityChanged ? 1 : 0,
    ),
    c.env.DB.prepare(`
      UPDATE tiktok_connection_verifications
      SET invalidated_at = CASE WHEN ? THEN datetime('now') ELSE invalidated_at END,
        invalidation_reason = CASE WHEN ? THEN 'connection_configuration_changed' ELSE invalidation_reason END,
        updated_at = datetime('now')
      WHERE environment = 'production' AND ?
    `).bind(identityChanged ? 1 : 0, identityChanged ? 1 : 0, identityChanged ? 1 : 0),
    auditConnectionUpdate(c, 'tiktok', before, after),
  ])
}

function readConnectionSnapshot(db: D1Database, provider: ConfigurableProvider) {
  return db.prepare(`
    SELECT enabled, mode, browser_enabled, server_enabled, destination_id,
      debug_enabled, rollout_percentage, revision
    FROM ad_platform_connections
    WHERE provider = ?
  `).bind(provider).first<Record<string, unknown>>()
}

function auditConnectionUpdate(
  c: AdminAdPlatformContext,
  provider: ConfigurableProvider,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
) {
  return c.env.DB.prepare(`
    INSERT INTO admin_audit_logs
      (id, admin_id, action, target_type, target_id, before_value, after_value)
    VALUES (?, ?, 'update_ad_platform_connection', 'ad_platform_connection', ?, ?, ?)
  `).bind(
    generateId('log'),
    c.get('userId')!,
    provider,
    JSON.stringify(before),
    JSON.stringify(after),
  )
}

function configurableProvider(value: string): ConfigurableProvider | null {
  return value === 'meta' || value === 'tiktok' ? value : null
}

function isTrackingMode(value: string) {
  return value === 'disabled' || value === 'test' || value === 'production'
}

function isRolloutPercentage(value: number) {
  return value === 0 || value === 10 || value === 50 || value === 100
}
