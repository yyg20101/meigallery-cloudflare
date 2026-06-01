import { generateId } from './db'

/**
 * 获取用户当前有效的最高会员 rank
 */
export async function getUserEffectiveRank(db: D1Database, userId: number): Promise<number> {
  const result = await db
    .prepare(`
      SELECT MAX(ml.rank) as max_rank
      FROM user_memberships um
      JOIN membership_levels ml ON um.level_id = ml.id
      WHERE um.user_id = ?
        AND datetime('now') BETWEEN datetime(um.starts_at) AND datetime(um.expires_at)
    `)
    .bind(userId)
    .first<{ max_rank: number | null }>()

  return result?.max_rank ?? 0
}

/**
 * 检查用户是否有权访问指定 rank 的内容
 */
export async function checkMediaAccess(
  db: D1Database,
  userId: number,
  requiredRank: number,
): Promise<boolean> {
  if (requiredRank <= 0) return true
  const userRank = await getUserEffectiveRank(db, userId)
  return userRank >= requiredRank
}

/**
 * 写入审计日志
 */
export async function writeAuditLog(
  db: D1Database,
  params: {
    adminId: number
    action: string
    targetType: string
    targetId?: string
    beforeValue?: unknown
    afterValue?: unknown
  },
): Promise<void> {
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
