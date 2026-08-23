const RECOMMENDATION_REGION_CODE_PATTERN = /^[a-z0-9-]{2,32}$/u
const RECOMMENDATION_MAX_TARGET_REGIONS = 50

/**
 * 解析数据库中的推荐规则地区作用域。
 *
 * 空数组表示全局规则；返回 null 表示配置不可信，调用方必须安全关闭该规则。
 */
export function parseRecommendationRuleRegions(raw: string): string[] | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  }
  catch {
    return null
  }
  if (!Array.isArray(value) || value.length > RECOMMENDATION_MAX_TARGET_REGIONS) {
    return null
  }
  const regions = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string' || !RECOMMENDATION_REGION_CODE_PATTERN.test(item)) {
      return null
    }
    regions.add(item)
  }
  return [...regions].sort()
}

/**
 * undefined 表示 capability 探测，不绑定具体地区；null 表示请求未选择地区。
 */
export function recommendationRuleMatchesRegion(
  raw: string,
  regionCode: string | null | undefined,
): boolean {
  const regions = parseRecommendationRuleRegions(raw)
  if (!regions) return false
  if (regionCode === undefined) return true
  if (regions.length === 0) return true
  return regionCode !== null && regions.includes(regionCode)
}

/**
 * 回退规则必须覆盖目标规则会收到的全部地区流量；全局目标只能回退到全局规则。
 */
export function recommendationFallbackCoversTargetRegions(
  targetRaw: string,
  fallbackRaw: string,
): boolean {
  const targetRegions = parseRecommendationRuleRegions(targetRaw)
  const fallbackRegions = parseRecommendationRuleRegions(fallbackRaw)
  if (!targetRegions || !fallbackRegions) return false
  if (fallbackRegions.length === 0) return true
  if (targetRegions.length === 0) return false
  return targetRegions.every(region => fallbackRegions.includes(region))
}
