const ALLOWED_PROTOCOLS = new Set(['https:', 'mailto:', 'tel:', 'tg:', 'line:', 'whatsapp:'])

export function normalizeContactLinkUrl(value: unknown) {
  const url = String(value ?? '').trim()
  if (!url) return null
  if (hasWhitespaceOrControlCharacter(url)) {
    throw new Error('联系方式跳转链接不能包含空白或控制字符')
  }

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('联系方式跳转链接格式无效')
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new Error('联系方式跳转链接只允许 https、mailto、tel 或受支持的客户端协议')
  }

  return url
}

function hasWhitespaceOrControlCharacter(value: string) {
  for (const char of value) {
    const code = char.charCodeAt(0)
    if (code <= 0x20 || code === 0x7f) return true
  }
  return false
}
