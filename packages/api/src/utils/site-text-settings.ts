type TextSettingConfig = {
  label: string
  maxLength: number
  pattern?: RegExp
  patternMessage?: string
}

const SITE_TEXT_SETTINGS: Record<string, TextSettingConfig> = {
  site_name: { label: '站点名称', maxLength: 40 },
  site_description: { label: '站点描述', maxLength: 180 },
  seo_title: { label: 'SEO 标题', maxLength: 80 },
  seo_keywords: { label: 'SEO 关键词', maxLength: 600 },
  og_title: { label: 'OG 标题', maxLength: 80 },
  og_description: { label: 'OG 描述', maxLength: 220 },
  footer_text: { label: '页脚文案', maxLength: 120 },
  membership_description: { label: '会员说明', maxLength: 300 },
  home_hero_title: { label: '首页主标题', maxLength: 40 },
  home_hero_subtitle: { label: '首页副标题', maxLength: 180 },
  rules_entry_title: { label: '规则入口标题', maxLength: 20 },
  rules_entry_summary: { label: '规则入口说明', maxLength: 120 },
  rules_entry_icon: {
    label: '规则入口图标',
    maxLength: 32,
    pattern: /^[a-z0-9_-]+$/i,
    patternMessage: '规则入口图标仅允许字母、数字、短横线和下划线',
  },
  rules_page_title: { label: '规则页标题', maxLength: 40 },
  rules_page_summary: { label: '规则页摘要', maxLength: 180 },
}

export function isSiteTextSettingKey(key: string) {
  return key in SITE_TEXT_SETTINGS
}

export function normalizeSiteTextSetting(key: string, value: unknown) {
  const config = SITE_TEXT_SETTINGS[key]
  if (!config) return value
  if (value === null || value === undefined) return ''

  const raw = String(value)
  if (hasDisallowedControlCharacter(raw)) {
    throw new Error(`${config.label}不能包含控制字符`)
  }

  if (key === 'seo_keywords') {
    return normalizeSeoKeywordsSetting(raw)
  }

  const text = raw.trim().replace(/\s+/g, ' ')
  if (text.length > config.maxLength) {
    throw new Error(`${config.label}不能超过 ${config.maxLength} 个字符`)
  }
  if (text && config.pattern && !config.pattern.test(text)) {
    throw new Error(config.patternMessage || `${config.label}格式无效`)
  }

  return text
}

export function safeSiteTextSetting(key: string, value: unknown) {
  try {
    return normalizeSiteTextSetting(key, value) as string
  } catch {
    return ''
  }
}

const MAX_SEO_KEYWORD_COUNT = 30
const MAX_SEO_KEYWORD_LENGTH = 24

function normalizeSeoKeywordsSetting(value: string) {
  const keywords: string[] = []
  const seen = new Set<string>()

  for (const part of value.split(/[,，、;；\n\r]+/)) {
    const keyword = part
      .trim()
      .replace(/^#+/, '')
      .trim()
      .replace(/\s+/g, ' ')
    if (!keyword) continue
    if (keyword.length > MAX_SEO_KEYWORD_LENGTH) {
      throw new Error(`单个 SEO 关键词不能超过 ${MAX_SEO_KEYWORD_LENGTH} 个字符`)
    }

    const dedupeKey = keyword.toLowerCase()
    if (seen.has(dedupeKey)) continue
    keywords.push(keyword)
    seen.add(dedupeKey)
  }

  if (keywords.length > MAX_SEO_KEYWORD_COUNT) {
    throw new Error(`SEO 关键词不能超过 ${MAX_SEO_KEYWORD_COUNT} 个`)
  }

  return keywords.join(',')
}

function hasDisallowedControlCharacter(value: string) {
  for (const char of value) {
    const code = char.charCodeAt(0)
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return true
    if (code === 0x7f) return true
  }
  return false
}
