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

  if (!/^\d+$/.test(parts[2]!)) {
    return false
  }

  const iterations = parseInt(parts[2]!, 10)
  if (!Number.isInteger(iterations) || iterations <= 0) {
    return false
  }

  const salt = base64ToBytes(parts[3]!)
  const expectedHash = base64ToBytes(parts[4]!)
  if (!salt || !expectedHash || salt.length === 0 || expectedHash.length === 0) {
    return false
  }

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

  return timingSafeEqual(new Uint8Array(derivedBits), expectedHash)
}

function base64ToBytes(value: string): Uint8Array | null {
  try {
    const decoded = atob(value)
    return Uint8Array.from(decoded, c => c.charCodeAt(0))
  }
  catch {
    return null
  }
}

function timingSafeEqual(actual: Uint8Array, expected: Uint8Array): boolean {
  let diff = actual.length ^ expected.length
  const maxLength = Math.max(actual.length, expected.length)

  for (let index = 0; index < maxLength; index += 1) {
    diff |= (actual[index] ?? 0) ^ (expected[index] ?? 0)
  }

  return diff === 0
}
