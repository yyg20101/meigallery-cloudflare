import { Hono } from 'hono'
import type { Bindings, Variables } from '../index'

export const mediaRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// GET /api/media/:assetId/access - 媒体访问签名
mediaRoutes.get('/:assetId/access', async (c) => {
  const assetId = c.req.param('assetId')
  // TODO: 实现媒体访问权限校验和签名
  return c.json({ message: `媒体 ${assetId} 访问签名待实现` }, 501)
})

// GET /api/media/:assetId/thumbnail - 缩略图
mediaRoutes.get('/:assetId/thumbnail', async (c) => {
  const assetId = c.req.param('assetId')
  // TODO: 实现缩略图按需生成
  return c.json({ message: `媒体 ${assetId} 缩略图待实现` }, 501)
})
