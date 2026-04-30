import { Hono } from 'hono'
import type { Bindings, Variables } from '../index'
import { requireAuth } from '../middleware/auth'
import { getUserEffectiveRank, checkMediaAccess } from '../utils/permission'
import { R2_KEY_PREFIX, SIGNED_URL_TTL } from '@meigallery/shared/constants'

export const mediaRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

/**
 * GET /api/media/public/* - 公开 R2 对象访问（头像等）
 * 仅允许 avatars/ 前缀
 */
mediaRoutes.get('/public/*', async (c) => {
  const path = c.req.path.replace('/api/media/public/', '')

  // 白名单前缀，仅允许公开访问特定目录
  const allowedPrefixes = ['avatars/']
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
 * 先检查缓存的缩略图，没有则返回原图（实际缩略图生成由 Image Resizing 或首次请求时缓存）
 */
mediaRoutes.get('/:assetId/thumbnail', async (c) => {
  const assetId = c.req.param('assetId')
  const width = parseInt(c.req.query('w') || '480', 10)
  const db = c.env.DB

  const asset = await db
    .prepare(`
      SELECT ma.r2_key, ma.type, ma.required_rank, g.status
      FROM media_assets ma
      JOIN galleries g ON ma.gallery_id = g.id
      WHERE ma.id = ? AND ma.upload_status = 'completed'
    `)
    .bind(assetId)
    .first<{ r2_key: string | null; type: string; required_rank: number; status: string }>()

  if (!asset || asset.type !== 'image' || asset.status !== 'published') {
    return c.json({ statusCode: 404, message: '资源不存在' }, 404)
  }

  // 缩略图是公开的低分辨率版本（不受 required_rank 限制）
  const thumbnailKey = `${R2_KEY_PREFIX.THUMBNAILS}/${assetId}_w${width}`

  // 先尝试获取已缓存的缩略图
  let object = await c.env.R2.get(thumbnailKey)

  if (!object) {
    // 缩略图不存在，返回原图（生产环境应集成 Image Resizing）
    // 仅在 required_rank = 0 时返回原图作为 fallback
    if (asset.required_rank > 0) {
      // 受保护图片不提供 fallback 缩略图
      return c.json({ statusCode: 403, message: '需要登录查看' }, 403)
    }
    if (asset.r2_key) {
      object = await c.env.R2.get(asset.r2_key)
    }
  }

  if (!object) {
    return c.json({ statusCode: 404, message: '文件不存在' }, 404)
  }

  const headers = new Headers()
  headers.set('Content-Type', object.httpMetadata?.contentType || 'image/jpeg')
  headers.set('Cache-Control', 'public, max-age=604800') // 缓存 7 天
  headers.set('ETag', object.httpEtag)

  return new Response(object.body, { headers })
})

/**
 * GET /api/media/:assetId/access - 受保护媒体访问签名
 * 需要登录，验证会员等级后返回临时访问 URL
 * - 图片：返回 R2 预签名 URL 或直接 stream
 * - 视频：返回 Cloudflare Stream 签名 token
 */
mediaRoutes.get('/:assetId/access', requireAuth, async (c) => {
  const assetId = c.req.param('assetId')
  const userId = c.get('userId')!
  const userRole = c.get('userRole')
  const db = c.env.DB

  const asset = await db
    .prepare(`
      SELECT ma.id, ma.type, ma.role, ma.r2_key, ma.stream_uid,
             ma.required_rank, g.status, g.required_level_rank
      FROM media_assets ma
      JOIN galleries g ON ma.gallery_id = g.id
      WHERE ma.id = ? AND ma.upload_status = 'completed'
    `)
    .bind(assetId)
    .first<{
      id: string
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

  if (!isAdmin) {
    // 检查图库级别要求
    const effectiveRank = Math.max(asset.required_rank, asset.required_level_rank)
    const hasAccess = await checkMediaAccess(db, userId, effectiveRank)
    if (!hasAccess) {
      return c.json({
        statusCode: 403,
        message: '会员等级不足，无法访问',
        requiredRank: effectiveRank,
      }, 403)
    }
  }

  // 根据媒体类型返回不同的访问凭证
  if (asset.type === 'image' && asset.r2_key) {
    // 图片：直接通过此接口代理返回
    const object = await c.env.R2.get(asset.r2_key)
    if (!object) {
      return c.json({ statusCode: 404, message: '文件不存在' }, 404)
    }

    const headers = new Headers()
    headers.set('Content-Type', object.httpMetadata?.contentType || 'image/jpeg')
    headers.set('Cache-Control', 'private, max-age=600')

    return new Response(object.body, { headers })
  }

  if (asset.type === 'video' && asset.stream_uid) {
    // 视频：生成 Cloudflare Stream 签名 token
    const signedToken = await generateStreamSignedToken(
      c.env.STREAM_ACCOUNT_ID,
      c.env.STREAM_API_TOKEN,
      asset.stream_uid,
      SIGNED_URL_TTL.VIDEO,
    )

    return c.json({
      type: 'video',
      streamUid: asset.stream_uid,
      token: signedToken,
      expiresIn: SIGNED_URL_TTL.VIDEO,
    })
  }

  return c.json({ statusCode: 404, message: '媒体文件配置异常' }, 404)
})

// === 内部工具 ===

/**
 * 生成 Cloudflare Stream 签名 token
 * 使用 Stream API 创建临时签名 URL
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
