import { Hono, type Context } from 'hono'
import type { Bindings, Variables } from '../index'
import { requireAuth } from '../middleware/auth'
import { recordTrustedAnalyticsEvent } from '../services/analytics-ingest'
import { errorJson } from '../utils/api-error'
import { isExternalCoverKey, safeExternalCoverUrl } from '../utils/cover-url'
import { isExpectedGalleryCoverKey, isExpectedGalleryMediaKey } from '../utils/media-keys'
import { checkMediaAccess } from '../utils/permission'
import { MEDIA_ACCESS_TTL } from '@meigallery/shared/constants'

export const mediaRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

/**
 * GET /api/media/public/* - 公开 R2 对象访问（头像等）
 * 仅允许 avatars/ 前缀
 */
mediaRoutes.get('/public/*', async (c) => {
  const path = c.req.path.replace('/api/media/public/', '')

  // 白名单前缀，仅允许公开访问特定目录
  const allowedPrefixes = ['avatars/', 'site/', 'home-ads/']
  const isAllowed = allowedPrefixes.some(prefix => path.startsWith(prefix))
  if (!isAllowed) {
    return c.json({ statusCode: 403, message: '不允许访问该路径' }, 403)
  }

  const object = await c.env.R2.get(path)
  if (!object) {
    return c.json({ statusCode: 404, message: '文件不存在' }, 404)
  }

  const headers = new Headers()
  headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream')
  headers.set('Cache-Control', 'public, max-age=86400')
  headers.set('ETag', object.httpEtag)

  return new Response(object.body, { headers })
})

/**
 * GET /api/media/cover/:galleryId - 图库封面图
 * 公开接口，直接返回 R2 对象
 */
mediaRoutes.get('/cover/:galleryId', async (c) => {
  const galleryId = c.req.param('galleryId')
  const db = c.env.DB

  const gallery = await db
    .prepare('SELECT cover_key FROM galleries WHERE id = ? AND status = ?')
    .bind(galleryId, 'published')
    .first<{ cover_key: string | null }>()

  if (!gallery?.cover_key) {
    return c.json({ statusCode: 404, message: '封面不存在' }, 404)
  }

  // 外部 URL（迁移数据）仅允许安全 HTTPS 公开地址，避免公开接口跳转到 http、localhost 或非公网地址。
  if (isExternalCoverKey(gallery.cover_key)) {
    const safeUrl = safeExternalCoverUrl(gallery.cover_key)
    if (!safeUrl) {
      return c.json({ statusCode: 404, message: '封面不存在' }, 404)
    }
    return c.redirect(safeUrl, 302)
  }

  if (!isExpectedGalleryCoverKey(gallery.cover_key, galleryId)) {
    return c.json({ statusCode: 404, message: '封面不存在' }, 404)
  }

  const object = await c.env.R2.get(gallery.cover_key)
  if (!object) {
    return c.json({ statusCode: 404, message: '封面文件不存在' }, 404)
  }

  const headers = new Headers()
  headers.set('Content-Type', object.httpMetadata?.contentType || 'image/jpeg')
  headers.set('Cache-Control', 'public, max-age=86400') // 缓存 1 天
  headers.set('ETag', object.httpEtag)

  return new Response(object.body, { headers })
})

/**
 * GET /api/media/:assetId/thumbnail - 缩略图
 * 公开接口，支持宽度参数 ?w=480
 *
 * 策略：
 * - IMAGE_RESIZING_ENABLED=true：通过 Cloudflare Images Transformations 实时缩放
 * - 首期固定只生成 480px 单规格，避免 Free unique transformations 被多规格消耗
 * - 未启用或转换失败：直接返回原图，由浏览器/CDN 缓存
 */
mediaRoutes.get('/:assetId/thumbnail', async (c) => {
  const assetId = c.req.param('assetId')
  const thumbnailWidth = 480
  const db = c.env.DB

  const asset = await db
    .prepare(`
      SELECT ma.gallery_id, ma.r2_key, ma.type, ma.required_rank, g.required_level_rank, g.status
      FROM media_assets ma
      JOIN galleries g ON ma.gallery_id = g.id
      WHERE ma.id = ? AND ma.upload_status = 'completed'
    `)
    .bind(assetId)
    .first<{ gallery_id: string; r2_key: string | null; type: string; required_rank: number; required_level_rank: number; status: string }>()

  if (!asset || asset.type !== 'image' || asset.status !== 'published') {
    return c.json({ statusCode: 404, message: '资源不存在' }, 404)
  }

  // 受保护图片不提供公开缩略图；同时遵守图库级会员要求。
  if (Math.max(asset.required_rank, asset.required_level_rank) > 0) {
    return c.json({ statusCode: 403, message: '需要登录查看' }, 403)
  }

  if (!asset.r2_key) {
    return c.json({ statusCode: 404, message: '文件不存在' }, 404)
  }
  if (!isExpectedGalleryMediaKey(asset.r2_key, asset.gallery_id, assetId)) {
    return c.json({ statusCode: 404, message: '文件不存在' }, 404)
  }

  const imageResizingEnabled = c.env.IMAGE_RESIZING_ENABLED === 'true'

  const fallbackOriginal = async () => {
    const object = await c.env.R2.get(asset.r2_key!)
    if (!object) return c.json({ statusCode: 404, message: '文件不存在' }, 404)

    const headers = new Headers()
    headers.set('Content-Type', object.httpMetadata?.contentType || 'image/jpeg')
    headers.set('Cache-Control', 'public, max-age=604800')
    headers.set('ETag', object.httpEtag)

    return new Response(object.body, { headers })
  }

  if (imageResizingEnabled) {
    // Cloudflare Images Transformations：通过内部 URL 自请求 + cf.image 实时缩放。
    const originUrl = new URL(c.req.url)
    originUrl.pathname = `/api/media/raw/${assetId}`
    originUrl.search = ''

    try {
      const resized = await fetch(originUrl.toString(), {
        cf: {
          image: {
            width: thumbnailWidth,
            fit: 'scale-down' as const,
            quality: 80,
            format: 'webp' as const,
          },
        },
      })

      if (!resized.ok) {
        return fallbackOriginal()
      }

      const headers = new Headers(resized.headers)
      headers.set('Cache-Control', 'public, max-age=604800')
      return new Response(resized.body, { headers })
    } catch {
      return fallbackOriginal()
    }
  }

  // Free 计划 fallback：直接返回原图
  return fallbackOriginal()
})

/**
 * GET /api/media/raw/:assetId - 原图内部端点（供 Image Resizing 使用）
 * 不对外暴露，仅用于 cf.image 的 origin fetch
 */
mediaRoutes.get('/raw/:assetId', async (c) => {
  const assetId = c.req.param('assetId')
  const db = c.env.DB

  const asset = await db
    .prepare(`
      SELECT ma.gallery_id, ma.r2_key, ma.required_rank, g.required_level_rank, g.status
      FROM media_assets ma
      JOIN galleries g ON ma.gallery_id = g.id
      WHERE ma.id = ? AND ma.upload_status = 'completed'
    `)
    .bind(assetId)
    .first<{ gallery_id: string; r2_key: string | null; required_rank: number; required_level_rank: number; status: string }>()

  if (!asset || asset.status !== 'published' || Math.max(asset.required_rank, asset.required_level_rank) > 0 || !asset.r2_key) {
    return new Response(null, { status: 404 })
  }
  if (!isExpectedGalleryMediaKey(asset.r2_key, asset.gallery_id, assetId)) {
    return new Response(null, { status: 404 })
  }

  const object = await c.env.R2.get(asset.r2_key)
  if (!object) return new Response(null, { status: 404 })

  return new Response(object.body, {
    headers: {
      'Content-Type': object.httpMetadata?.contentType || 'image/jpeg',
      'Cache-Control': 'public, max-age=86400',
    },
  })
})

/**
 * GET /api/media/:assetId/access - 受保护媒体访问接口
 * 需要登录，验证会员等级后返回媒体内容或播放凭证
 * - 图片：Worker 代理返回 R2 对象内容，不暴露 R2 原始地址
 * - 视频：返回 Cloudflare Stream 签名 token
 */
mediaRoutes.get('/:assetId/access', requireAuth, async (c) => {
  const assetId = c.req.param('assetId')
  const userId = c.get('userId')!
  const userRole = c.get('userRole')
  const db = c.env.DB

  const asset = await db
    .prepare(`
      SELECT ma.id, ma.gallery_id, ma.type, ma.role, ma.r2_key, ma.stream_uid,
             ma.required_rank, g.status, g.required_level_rank
      FROM media_assets ma
      JOIN galleries g ON ma.gallery_id = g.id
      WHERE ma.id = ? AND ma.upload_status = 'completed'
    `)
    .bind(assetId)
    .first<{
      id: string
      gallery_id: string
      type: string
      role: string
      r2_key: string | null
      stream_uid: string | null
      required_rank: number
      status: string
      required_level_rank: number
    }>()

  if (!asset || asset.status !== 'published') {
    return c.json({ statusCode: 404, message: '资源不存在' }, 404)
  }

  // 管理员角色跳过等级检查
  const isAdmin = userRole === 'admin' || userRole === 'owner'
  const effectiveRank = Math.max(asset.required_rank, asset.required_level_rank)

  if (!isAdmin) {
    // 检查图库级别要求
    const hasAccess = await checkMediaAccess(db, userId, effectiveRank)
    if (!hasAccess) {
      scheduleMediaAccessAnalytics(c, asset, 'media_access_denied', effectiveRank, 'rank_insufficient')
      return c.json({
        statusCode: 403,
        message: '会员等级不足，无法访问',
        requiredRank: effectiveRank,
      }, 403)
    }
  }

  // 根据媒体类型返回不同的访问凭证
  if (asset.type === 'image' && asset.r2_key) {
    if (!isExpectedGalleryMediaKey(asset.r2_key, asset.gallery_id, assetId)) {
      scheduleMediaAccessAnalytics(c, asset, 'media_access_denied', effectiveRank, 'media_config_error')
      return c.json({ statusCode: 404, message: '媒体文件配置异常' }, 404)
    }

    // 图片：服务端校验通过后代理返回 R2 对象。
    const object = await c.env.R2.get(asset.r2_key)
    if (!object) {
      scheduleMediaAccessAnalytics(c, asset, 'media_access_denied', effectiveRank, 'file_missing')
      return c.json({ statusCode: 404, message: '文件不存在' }, 404)
    }

    const headers = new Headers()
    headers.set('Content-Type', object.httpMetadata?.contentType || 'image/jpeg')
    headers.set('Cache-Control', `private, max-age=${MEDIA_ACCESS_TTL.PROTECTED_IMAGE_CACHE}`)

    scheduleMediaAccessAnalytics(c, asset, 'media_access_granted', effectiveRank)
    return new Response(object.body, { headers })
  }

  if (asset.type === 'video' && asset.stream_uid) {
    if (!c.env.STREAM_ACCOUNT_ID?.trim() || !c.env.STREAM_API_TOKEN?.trim()) {
      scheduleMediaAccessAnalytics(c, asset, 'media_access_denied', effectiveRank, 'stream_not_configured')
      return errorJson(c, 503, '视频服务暂未配置，请联系站点管理员', {
        code: 'STREAM_NOT_CONFIGURED',
      })
    }

    // 视频：生成 Cloudflare Stream 签名 token
    const signedToken = await generateStreamSignedToken(
      c.env.STREAM_ACCOUNT_ID,
      c.env.STREAM_API_TOKEN,
      asset.stream_uid,
      MEDIA_ACCESS_TTL.STREAM_TOKEN,
    )

    scheduleMediaAccessAnalytics(c, asset, 'media_access_granted', effectiveRank)
    return c.json({
      type: 'video',
      streamUid: asset.stream_uid,
      token: signedToken,
      expiresIn: MEDIA_ACCESS_TTL.STREAM_TOKEN,
    })
  }

  scheduleMediaAccessAnalytics(c, asset, 'media_access_denied', effectiveRank, 'media_config_error')
  return c.json({ statusCode: 404, message: '媒体文件配置异常' }, 404)
})

// === 内部工具 ===

/**
 * 生成 Cloudflare Stream 签名 token
 * 使用 Stream API 创建临时播放 token
 */
async function generateStreamSignedToken(
  accountId: string,
  apiToken: string,
  videoUid: string,
  ttlSeconds: number,
): Promise<string> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/${videoUid}/token`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        exp: Math.floor(Date.now() / 1000) + ttlSeconds,
      }),
    },
  )

  const result = await response.json() as { result?: { token?: string }; success: boolean }

  if (!result.success || !result.result?.token) {
    throw new Error('Stream 签名生成失败')
  }

  return result.result.token
}

type MediaAccessContext = Context<{ Bindings: Bindings; Variables: Variables }>
type MediaAccessAsset = {
  id: string
  gallery_id: string
  required_rank: number
  required_level_rank: number
}

function scheduleMediaAccessAnalytics(
  c: MediaAccessContext,
  asset: MediaAccessAsset,
  eventName: 'media_access_granted' | 'media_access_denied',
  effectiveRank: number,
  reason?: string,
) {
  const task = recordTrustedAnalyticsEvent(c.env, {
    eventName,
    userId: c.get('userId') ?? null,
    routeName: '/media/access',
    path: `/gallery/${asset.gallery_id}`,
    entityType: 'media',
    entityId: asset.id,
    visitorId: c.req.header('X-Analytics-Visitor-Id'),
    sessionId: c.req.header('X-Analytics-Session-Id'),
    country: c.req.header('CF-IPCountry'),
    props: {
      gallery_id: asset.gallery_id,
      asset_id: asset.id,
      required_rank: effectiveRank,
      ...(reason ? { reason } : {}),
    },
  }).catch(() => undefined)

  try {
    c.executionCtx.waitUntil(task)
  } catch {
    void task
  }
}
