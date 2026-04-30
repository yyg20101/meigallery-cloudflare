import type { H3Event } from 'h3'

/**
 * 权限校验工具
 * 基于 rank 数值比较，不硬编码等级名称
 */

/**
 * 获取用户当前有效的最高会员 rank
 * 查询 user_memberships 表，取未过期记录中最高 rank
 */
export async function getUserEffectiveRank(event: H3Event, userId: string): Promise<number> {
  const db = useDB(event)

  const result = await db
    .prepare(`
      SELECT MAX(ml.rank) as max_rank
      FROM user_memberships um
      JOIN membership_levels ml ON um.level_id = ml.id
      WHERE um.user_id = ?
        AND datetime('now') BETWEEN um.starts_at AND um.expires_at
    `)
    .bind(userId)
    .first<{ max_rank: number | null }>()

  // 未找到有效会员记录，返回 0（free 等级）
  return result?.max_rank ?? 0
}

/**
 * 检查用户是否有权访问指定 rank 的内容
 */
export async function checkMediaAccess(
  event: H3Event,
  userId: string,
  requiredRank: number,
): Promise<boolean> {
  // rank 为 0 表示免费内容，所有已登录用户可访问
  if (requiredRank <= 0) {
    return true
  }

  const userRank = await getUserEffectiveRank(event, userId)
  return userRank >= requiredRank
}

/**
 * 写入审计日志
 * 所有后台修改操作必须调用此函数
 */
export async function writeAuditLog(
  event: H3Event,
  params: {
    adminId: string
    action: string
    targetType: string
    targetId?: string
    beforeValue?: unknown
    afterValue?: unknown
  },
): Promise<void> {
  const db = useDB(event)
  const id = generateId('log')

  await db
    .prepare(`
      INSERT INTO admin_audit_logs (id, admin_id, action, target_type, target_id, before_value, after_value)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(
      id,
      params.adminId,
      params.action,
      params.targetType,
      params.targetId ?? null,
      params.beforeValue ? JSON.stringify(params.beforeValue) : null,
      params.afterValue ? JSON.stringify(params.afterValue) : null,
    )
    .run()
}
