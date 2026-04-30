/**
 * 生成唯一 ID（用于数据库主键）
 * 格式：前缀 + 时间戳(base36) + 随机数(base36)
 */
export function generateId(prefix: string = ''): string {
  const timestamp = Date.now().toString(36)
  const random = Math.random().toString(36).substring(2, 10)
  return prefix ? `${prefix}_${timestamp}${random}` : `${timestamp}${random}`
}
