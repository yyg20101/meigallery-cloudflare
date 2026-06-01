const MAX_FEATURED_REGION_SLUGS = 12
const MAX_RULES_MARKDOWN_LENGTH = 8000
const SLUG_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/i

export function normalizeHomeHotTagLimit(value: unknown) {
  const raw = String(value ?? '').trim()
  if (!raw) return '15'
  if (!/^\d+$/.test(raw)) throw new Error('首页热门标签数量必须是 1-30 之间的整数')

  const limit = Number(raw)
  if (!Number.isInteger(limit) || limit < 1 || limit > 30) {
    throw new Error('首页热门标签数量必须是 1-30 之间的整数')
  }
  return String(limit)
}

export function safeHomeHotTagLimit(value: unknown) {
  try {
    return normalizeHomeHotTagLimit(value)
  } catch {
    return '15'
  }
}

export function normalizeFeaturedRegionSlugs(value: unknown) {
  const raw = String(value ?? '').trim()
  if (!raw) return ''

  const slugs = raw
    .split(',')
    .map(slug => slug.trim())
    .filter(Boolean)

  if (slugs.length > MAX_FEATURED_REGION_SLUGS) {
    throw new Error(`主推地区最多配置 ${MAX_FEATURED_REGION_SLUGS} 个 slug`)
  }

  const uniqueSlugs: string[] = []
  const seen = new Set<string>()
  for (const slug of slugs) {
    if (!SLUG_PATTERN.test(slug)) {
      throw new Error('主推地区 slug 仅允许字母、数字、短横线和下划线')
    }
    const normalized = slug.toLowerCase()
    if (seen.has(normalized)) continue
    uniqueSlugs.push(normalized)
    seen.add(normalized)
  }

  return uniqueSlugs.join(',')
}

export function safeFeaturedRegionSlugs(value: unknown) {
  try {
    return normalizeFeaturedRegionSlugs(value)
  } catch {
    return ''
  }
}

export function normalizeRulesMarkdown(value: unknown, label: string) {
  if (value === null || value === undefined) return ''
  const text = String(value).replace(/\r\n/g, '\n').trim()
  if (hasDisallowedControlCharacter(text)) {
    throw new Error(`${label}不能包含控制字符`)
  }
  if (text.length > MAX_RULES_MARKDOWN_LENGTH) {
    throw new Error(`${label}不能超过 ${MAX_RULES_MARKDOWN_LENGTH} 个字符`)
  }
  return text
}

export function safeRulesMarkdown(value: unknown) {
  try {
    return normalizeRulesMarkdown(value, '规则 Markdown')
  } catch {
    return ''
  }
}

function hasDisallowedControlCharacter(value: string) {
  for (const char of value) {
    const code = char.charCodeAt(0)
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return true
    if (code === 0x7f) return true
  }
  return false
}
