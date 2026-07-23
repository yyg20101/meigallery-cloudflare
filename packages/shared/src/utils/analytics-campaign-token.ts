const CAMPAIGN_TOKEN_PATTERN = /^[a-z0-9][a-z0-9_.-]*$/
const PHONE_LIKE_PATTERN = /^\d(?:[\d._-]*\d)?$/

export function normalizeAnalyticsCampaignToken(value: unknown, maxLength = 120) {
  const normalized = String(value ?? '').trim().toLowerCase().slice(0, maxLength)
  if (!normalized || !CAMPAIGN_TOKEN_PATTERN.test(normalized)) return ''

  const digits = normalized.replace(/\D/g, '')
  if (PHONE_LIKE_PATTERN.test(normalized) && digits.length >= 8 && digits.length <= 15) return ''
  return normalized
}
