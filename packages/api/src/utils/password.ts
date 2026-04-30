/**
 * 密码哈希工具
 * 使用 Web Crypto API PBKDF2（Workers 原生支持）
 */

const ITERATIONS = 100000
const KEY_LENGTH = 32
const ALGORITHM = 'PBKDF2'
const HASH = 'SHA-256'

/**
 * 哈希密码
 * 返回格式：$pbkdf2$iterations$salt_base64$hash_base64
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const encoder = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    ALGORITHM,
    false,
    ['deriveBits'],
  )

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: ALGORITHM,
      salt,
      iterations: ITERATIONS,
      hash: HASH,
    },
    keyMaterial,
    KEY_LENGTH * 8,
  )

  const saltB64 = btoa(String.fromCharCode(...salt))
  const hashB64 = btoa(String.fromCharCode(...new Uint8Array(derivedBits)))

  return `$pbkdf2$${ITERATIONS}$${saltB64}$${hashB64}`
}

/**
 * 验证密码
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split('$')
  // 格式: $pbkdf2$iterations$salt_base64$hash_base64
  if (parts.length !== 5 || parts[1] !== 'pbkdf2') {
    return false
  }

  const iterations = parseInt(parts[2]!, 10)
  const salt = Uint8Array.from(atob(parts[3]!), c => c.charCodeAt(0))
  const expectedHash = parts[4]!

  const encoder = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    ALGORITHM,
    false,
    ['deriveBits'],
  )

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: ALGORITHM,
      salt,
      iterations,
      hash: HASH,
    },
    keyMaterial,
    KEY_LENGTH * 8,
  )

  const computedHash = btoa(String.fromCharCode(...new Uint8Array(derivedBits)))
  return computedHash === expectedHash
}
