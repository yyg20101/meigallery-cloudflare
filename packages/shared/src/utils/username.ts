/**
 * 用户名校验工具
 * 前后端共用，确保一致的验证规则
 */

/** 用户名正则：仅英文字母和数字，3-20 字符 */
export const USERNAME_REGEX = /^[a-z0-9]{3,20}$/

/** 系统保留用户名 */
export const RESERVED_USERNAMES = new Set([
  'admin', 'root', 'system', 'support', 'noreply', 'api', 'www',
  'mail', 'help', 'info', 'meigallery', 'owner', 'moderator', 'mod',
  'staff', 'test', 'null', 'undefined',
])

/**
 * 校验用户名格式和保留词
 * @param username 原始输入（会自动转小写）
 * @returns { valid: true } 或 { valid: false, error: string }
 */
export function validateUsername(username: string): { valid: true } | { valid: false; error: string } {
  const normalized = username.toLowerCase()

  if (normalized.length < 3) {
    return { valid: false, error: '用户名至少 3 个字符' }
  }
  if (normalized.length > 20) {
    return { valid: false, error: '用户名最多 20 个字符' }
  }
  if (!USERNAME_REGEX.test(normalized)) {
    return { valid: false, error: '用户名只允许英文字母和数字' }
  }
  if (RESERVED_USERNAMES.has(normalized)) {
    return { valid: false, error: '该用户名为系统保留' }
  }

  return { valid: true }
}
