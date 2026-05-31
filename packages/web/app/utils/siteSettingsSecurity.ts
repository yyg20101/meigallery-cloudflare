export function normalizePublicSettingUrl(value: unknown) {
  const url = String(value ?? '').trim()
  if (!url || hasWhitespaceOrControlCharacter(url) || hasEncodedWhitespaceOrControlCharacter(url)) return ''

  if (url.startsWith('/')) {
    if (url.startsWith('//') || url.startsWith('/\\')) return ''
    try {
      const parsed = new URL(url, 'https://meigallery.local')
      return `${parsed.pathname}${parsed.search}${parsed.hash}`
    } catch {
      return ''
    }
  }

  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'https:') return parsed.toString()
  } catch {
    return ''
  }

  return ''
}

export function normalizeInternalPath(value: unknown) {
  const url = String(value ?? '').trim()
  if (!url || hasWhitespaceOrControlCharacter(url) || hasEncodedWhitespaceOrControlCharacter(url)) return ''
  if (!url.startsWith('/') || url.startsWith('//') || url.startsWith('/\\')) return ''

  try {
    const parsed = new URL(url, 'https://meigallery.local')
    return `${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return ''
  }
}

export function normalizeSiteSettingPixelId(value: unknown) {
  const pixelId = String(value ?? '').trim()
  return /^\d{5,30}$/.test(pixelId) ? pixelId : ''
}

export function normalizeBooleanSetting(value: unknown) {
  return value === true || value === 'true'
}

function hasEncodedWhitespaceOrControlCharacter(value: string) {
  return /%(?:0[0-9a-f]|1[0-9a-f]|20|7f)/i.test(value)
}

function hasWhitespaceOrControlCharacter(value: string) {
  for (const char of value) {
    const code = char.charCodeAt(0)
    if (code <= 0x20 || code === 0x7f) return true
  }
  return false
}
