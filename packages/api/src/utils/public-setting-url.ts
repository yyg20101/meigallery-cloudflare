export function normalizePublicSettingUrl(value: unknown, fieldLabel: string) {
  const url = String(value ?? '').trim()
  if (!url) return ''
  if (hasWhitespaceOrControlCharacter(url)) {
    throw new Error(`${fieldLabel}不能包含空白或控制字符`)
  }

  if (url.startsWith('/')) {
    if (url.startsWith('//') || url.startsWith('/\\')) {
      throw new Error(`${fieldLabel}只允许站内相对路径或 https 链接`)
    }
    return url
  }

  if (url.startsWith('https://')) return url

  throw new Error(`${fieldLabel}只允许站内相对路径或 https 链接`)
}

export function normalizeInternalPathSetting(value: unknown, fieldLabel: string) {
  const url = String(value ?? '').trim()
  if (!url) return ''
  if (hasWhitespaceOrControlCharacter(url)) {
    throw new Error(`${fieldLabel}不能包含空白或控制字符`)
  }
  if (!url.startsWith('/') || url.startsWith('//') || url.startsWith('/\\')) {
    throw new Error(`${fieldLabel}只允许站内相对路径`)
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
