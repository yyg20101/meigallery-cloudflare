import { Hono } from 'hono'
import { normalizeMetaTrackingMode } from '@meigallery/shared/utils'
import type { Bindings, Variables } from '../../index'
import { requireOwner } from '../../middleware/auth'
import { normalizeAnalyticsConsentMode, normalizeAnalyticsSampleRate } from '../../utils/analytics-settings'
import { normalizeBooleanSetting, normalizeFacebookPixelId } from '../../utils/facebook-pixel-settings'
import { generateId } from '../../utils/db'
import { normalizeHomeAdScheduleRange } from '../../utils/home-ad-schedule'
import { isHomeAdTextKey, normalizeHomeAdText, normalizeHomeAdUrl } from '../../utils/home-ad-settings'
import { writeAuditLog } from '../../utils/permission'
import { LEGACY_DEFAULT_SEO_TITLE, LEGACY_DEFAULT_SITE_NAME } from '../../utils/public-site-settings'
import { normalizeInternalPathSetting, normalizePublicImageSettingUrl } from '../../utils/public-setting-url'
import { ADMIN_SETTING_KEYS, findProtectedAdminSettingKeys } from '../../utils/site-settings'
import { normalizeFeaturedRegionSlugs, normalizeHomeHotTagLimit, normalizeRulesMarkdown } from '../../utils/site-content-settings'
import { isSiteTextSettingKey, normalizeSiteTextSetting } from '../../utils/site-text-settings'
import { parseStoredSettingValue } from '../../utils/stored-setting-value'

export const adminSettingsRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

const ALLOWED_KEYS: ReadonlyArray<string> = ADMIN_SETTING_KEYS
const PUBLIC_URL_FIELDS: Record<string, string> = {
  site_icon: '站点图标 URL',
  og_image: 'OG 封面图 URL',
}
const SITE_ICON_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
}

function publicMediaPathToR2Key(value: unknown): string | null {
  if (typeof value !== 'string') return null
  if (!value.startsWith('/api/media/public/site/')) return null
  return value.replace('/api/media/public/', '')
}

function clearLegacySiteBrandDefault(key: string, value: unknown) {
  if (key === 'site_name' && value === LEGACY_DEFAULT_SITE_NAME) return ''
  if (key === 'seo_title' && value === LEGACY_DEFAULT_SEO_TITLE) return ''
  if (key === 'home_ad_sponsor' && value === 'MeiGallery 运营推荐') return ''
  if (key === 'rules_page_summary' && value === '了解 MeiGallery 的内容边界、会员访问和联系方式说明。') {
    return '了解本站的内容边界、会员访问和联系方式说明。'
  }
  if (key === 'rules_page_content' && typeof value === 'string') {
    return value.replaceAll('MeiGallery', '本站')
  }
  return value
}

adminSettingsRoutes.get('/', requireOwner, async (c) => {
  const db = c.env.DB
  const result = await db
    .prepare('SELECT key, value, updated_at FROM site_settings ORDER BY key')
    .all<{ key: string; value: string; updated_at: string }>()

  const settings: Record<string, { value: unknown; updatedAt: string }> = {}
  for (const row of result.results) {
    const value = clearLegacySiteBrandDefault(row.key, parseStoredSettingValue(row.value, ''))
    settings[row.key] = { value, updatedAt: row.updated_at }
  }
  return c.json({ data: settings })
})

adminSettingsRoutes.patch('/', requireOwner, async (c) => {
  const adminId = c.get('userId')!
  const db = c.env.DB
  const rawBody = await c.req.json<Record<string, unknown>>()
  const body: Record<string, unknown> = { ...rawBody }
  const protectedKeys = findProtectedAdminSettingKeys(Object.keys(body))
  if (protectedKeys.length > 0) {
    return c.json({
      statusCode: 400,
      code: 'ADMIN_SETTING_PROTECTED',
      message: '受保护设置必须通过专用管理接口修改',
      protectedKeys,
    }, 400)
  }

  if ('facebook_pixel_id' in body) {
    try {
      body.facebook_pixel_id = normalizeFacebookPixelId(body.facebook_pixel_id)
    } catch (error) {
      return c.json({ statusCode: 400, message: error instanceof Error ? error.message : 'Facebook Pixel ID 无效' }, 400)
    }
  }
  if ('facebook_pixel_enabled' in body) {
    body.facebook_pixel_enabled = normalizeBooleanSetting(body.facebook_pixel_enabled)
  }
  if ('facebook_pixel_debug_enabled' in body) {
    body.facebook_pixel_debug_enabled = normalizeBooleanSetting(body.facebook_pixel_debug_enabled)
  }
  if ('meta_tracking_mode' in body) {
    body.meta_tracking_mode = normalizeMetaTrackingMode(body.meta_tracking_mode)
  }
  if ('analytics_enabled' in body) {
    body.analytics_enabled = normalizeBooleanSetting(body.analytics_enabled)
  }
  if ('analytics_sample_rate' in body) {
    try {
      body.analytics_sample_rate = normalizeAnalyticsSampleRate(body.analytics_sample_rate)
    } catch (error) {
      return c.json({ statusCode: 400, message: error instanceof Error ? error.message : '分析采样率无效' }, 400)
    }
  }
  if ('analytics_consent_mode' in body) {
    body.analytics_consent_mode = normalizeAnalyticsConsentMode(body.analytics_consent_mode)
  }
  if ('meta_capi_enabled' in body) {
    body.meta_capi_enabled = normalizeBooleanSetting(body.meta_capi_enabled)
  }
  if ('home_ad_enabled' in body) {
    body.home_ad_enabled = normalizeBooleanSetting(body.home_ad_enabled)
  }
  if ('home_hot_tag_limit' in body) {
    try {
      body.home_hot_tag_limit = normalizeHomeHotTagLimit(body.home_hot_tag_limit)
    } catch (error) {
      return c.json({ statusCode: 400, message: error instanceof Error ? error.message : '首页热门标签数量无效' }, 400)
    }
  }
  if ('home_featured_region_slugs' in body) {
    try {
      body.home_featured_region_slugs = normalizeFeaturedRegionSlugs(body.home_featured_region_slugs)
    } catch (error) {
      return c.json({ statusCode: 400, message: error instanceof Error ? error.message : '主推地区配置无效' }, 400)
    }
  }
  for (const [key, label] of Object.entries({ rules_modal_content: '弹窗 Markdown 摘要', rules_page_content: '规则页 Markdown 正文' })) {
    if (!(key in body)) continue
    try {
      body[key] = normalizeRulesMarkdown(body[key], label)
    } catch (error) {
      return c.json({ statusCode: 400, message: error instanceof Error ? error.message : `${label}无效` }, 400)
    }
  }
  for (const key of Object.keys(body)) {
    if (!isSiteTextSettingKey(key)) continue
    try {
      body[key] = normalizeSiteTextSetting(key, body[key])
    } catch (error) {
      return c.json({ statusCode: 400, message: error instanceof Error ? error.message : '站点文案无效' }, 400)
    }
  }
  if ('home_ad_url' in body) {
    try {
      body.home_ad_url = normalizeHomeAdUrl(body.home_ad_url)
    } catch (error) {
      return c.json({ statusCode: 400, message: error instanceof Error ? error.message : '首页广告链接无效' }, 400)
    }
  }
  for (const key of Object.keys(body)) {
    if (!isHomeAdTextKey(key)) continue
    try {
      body[key] = normalizeHomeAdText(key, body[key])
    } catch (error) {
      return c.json({ statusCode: 400, message: error instanceof Error ? error.message : '首页广告文案无效' }, 400)
    }
  }
  const hasHomeAdScheduleChange = 'home_ad_starts_at' in body || 'home_ad_ends_at' in body
  if ('rules_page_url' in body) {
    try {
      body.rules_page_url = normalizeInternalPathSetting(body.rules_page_url, '规则页链接')
    } catch (error) {
      return c.json({ statusCode: 400, message: error instanceof Error ? error.message : '规则页链接无效' }, 400)
    }
  }
  for (const [key, label] of Object.entries(PUBLIC_URL_FIELDS)) {
    if (!(key in body)) continue
    try {
      body[key] = normalizePublicImageSettingUrl(body[key], label)
    } catch (error) {
      return c.json({ statusCode: 400, message: error instanceof Error ? error.message : `${label}无效` }, 400)
    }
  }

  const keys = Object.keys(body).filter(k => ALLOWED_KEYS.includes(k))
  if (keys.length === 0) {
    return c.json({ statusCode: 400, message: '没有有效的设置项' }, 400)
  }

  // 读取旧值
  const lookupKeys = new Set(keys)
  if (hasHomeAdScheduleChange) {
    lookupKeys.add('home_ad_starts_at')
    lookupKeys.add('home_ad_ends_at')
  }

  const placeholders = Array.from(lookupKeys).map(() => '?').join(',')
  const oldValues = await db
    .prepare(`SELECT key, value FROM site_settings WHERE key IN (${placeholders})`)
    .bind(...lookupKeys)
    .all<{ key: string; value: string }>()
  const currentMap: Record<string, unknown> = {}
  for (const row of oldValues.results) {
    currentMap[row.key] = parseStoredSettingValue(row.value)
  }

  if (hasHomeAdScheduleChange) {
    try {
      const range = normalizeHomeAdScheduleRange(
        'home_ad_starts_at' in body ? body.home_ad_starts_at : currentMap.home_ad_starts_at,
        'home_ad_ends_at' in body ? body.home_ad_ends_at : currentMap.home_ad_ends_at,
      )
      if ('home_ad_starts_at' in body) body.home_ad_starts_at = range.startsAt
      if ('home_ad_ends_at' in body) body.home_ad_ends_at = range.endsAt
    } catch (error) {
      return c.json({ statusCode: 400, message: error instanceof Error ? error.message : '首页广告排期无效' }, 400)
    }
  }

  const oldMap: Record<string, unknown> = {}
  for (const key of keys) {
    oldMap[key] = currentMap[key]
  }

  for (const key of keys) {
    await db
      .prepare(`
        INSERT INTO site_settings (key, value, updated_at)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `)
      .bind(key, JSON.stringify(body[key]))
      .run()
  }

  const newMap: Record<string, unknown> = {}
  for (const key of keys) {
    newMap[key] = body[key]!
  }

  await writeAuditLog(db, {
    adminId,
    action: 'settings_change',
    targetType: 'settings',
    beforeValue: oldMap,
    afterValue: newMap,
  })

  return c.json({ message: '设置已更新', updated: keys })
})

adminSettingsRoutes.post('/site-icon', requireOwner, async (c) => {
  const adminId = c.get('userId')!
  const db = c.env.DB
  const formData = await c.req.formData()
  const file = formData.get('file') as File | null

  if (!file) return c.json({ statusCode: 400, message: '请上传文件（字段名: file）' }, 400)
  const ext = SITE_ICON_TYPES[file.type]
  if (!ext) return c.json({ statusCode: 400, message: '仅支持 PNG、JPEG、WebP、ICO 格式' }, 400)
  if (file.size > 1024 * 1024) return c.json({ statusCode: 400, message: '站点图标不能超过 1MB' }, 400)

  const before = await db.prepare("SELECT value FROM site_settings WHERE key = 'site_icon'").first<{ value: string }>()
  const beforeValue = before ? parseStoredSettingValue(before.value, '') : ''
  const oldKey = publicMediaPathToR2Key(beforeValue)
  const key = `site/site-icon-${generateId('asset')}.${ext}`
  const iconUrl = `/api/media/public/${key}`

  await c.env.R2.put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type },
  })
  if (oldKey && oldKey !== key) await c.env.R2.delete(oldKey)

  await db
    .prepare(`
      INSERT INTO site_settings (key, value, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `)
    .bind('site_icon', JSON.stringify(iconUrl))
    .run()

  await writeAuditLog(db, {
    adminId,
    action: 'settings_site_icon_upload',
    targetType: 'settings',
    targetId: 'site_icon',
    beforeValue: { site_icon: beforeValue },
    afterValue: { site_icon: iconUrl },
  })

  return c.json({ message: '站点图标已上传', iconUrl })
})
