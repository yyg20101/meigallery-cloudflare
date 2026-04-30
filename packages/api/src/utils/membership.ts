/**
 * 会员状态校验工具
 */

export interface MembershipRecord {
  levelRank: number
  startsAt: string  // ISO 日期
  expiresAt: string // ISO 日期
}

/**
 * 从会员记录列表中获取当前有效的最高 rank
 * @param memberships 用户的所有会员记录
 * @param now 当前时间（可传入以便测试）
 */
export function getEffectiveRankFromRecords(
  memberships: MembershipRecord[],
  now: Date = new Date(),
): number {
  const nowMs = now.getTime()
  let maxRank = 0

  for (const m of memberships) {
    const startsMs = new Date(m.startsAt).getTime()
    const expiresMs = new Date(m.expiresAt).getTime()
    if (startsMs <= nowMs && expiresMs > nowMs) {
      maxRank = Math.max(maxRank, m.levelRank)
    }
  }

  return maxRank
}

/**
 * 判断会员是否已过期
 */
export function isMembershipExpired(expiresAt: string, now: Date = new Date()): boolean {
  return now.getTime() >= new Date(expiresAt).getTime()
}

/**
 * 判断是否有权访问指定 rank 的内容
 */
export function hasAccessToRank(userRank: number, requiredRank: number): boolean {
  if (requiredRank <= 0) return true
  return userRank >= requiredRank
}
