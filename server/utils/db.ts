import type { H3Event } from 'h3'
import type { CloudflareEnv } from '~~/types/cloudflare'

/**
 * 获取 D1 数据库实例
 * 统一入口，方便后续替换或增加连接池逻辑
 */
export function useDB(event: H3Event): D1Database {
  return getCloudflareEnv(event).DB
}

/**
 * 获取 R2 存储桶实例
 */
export function useR2(event: H3Event): R2Bucket {
  return getCloudflareEnv(event).R2
}

/**
 * 获取 Cloudflare 环境变量
 * 生产环境通过 event.context.cloudflare.env 访问
 * 本地开发由 Nitro/wrangler 自动模拟
 */
function getCloudflareEnv(event: H3Event): CloudflareEnv {
  const cf = (event.context as Record<string, unknown>).cloudflare as
    | { env: CloudflareEnv }
    | undefined

  if (!cf?.env) {
    throw createError({
      statusCode: 500,
      message: 'Cloudflare 环境未就绪，请检查 wrangler 配置',
    })
  }

  return cf.env
}

/**
 * 生成唯一 ID（用于数据库主键）
 * 格式：前缀 + 时间戳(base36) + 随机数(base36)
 */
export function generateId(prefix: string = ''): string {
  const timestamp = Date.now().toString(36)
  const random = Math.random().toString(36).substring(2, 10)
  return prefix ? `${prefix}_${timestamp}${random}` : `${timestamp}${random}`
}
