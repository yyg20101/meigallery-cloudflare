export interface PresentationTag {
  id?: string
  type: string
  name: string
  slug: string
}

export interface RegionGuideItem {
  name: string
  slug: string
  label: string
  description: string
}

const REGION_TYPES = new Set(['region', 'region_scope', 'region_group', 'city', 'city_country'])

export function isRegionTag(tag: Pick<PresentationTag, 'type'>) {
  return REGION_TYPES.has(tag.type)
}

export function getPrimaryRegion(tags: PresentationTag[]) {
  return tags.find(isRegionTag) || null
}

export function getSupportTags(tags: PresentationTag[], limit = 3) {
  return tags.filter(tag => !isRegionTag(tag)).slice(0, limit)
}

export function collectRegionGuideItems(
  groupedTags: Record<string, Array<{ id?: string; name: string; slug: string }>>,
  preferredSlugs: string[],
  limit = 6,
): RegionGuideItem[] {
  const regionTags = Object.entries(groupedTags)
    .filter(([type]) => REGION_TYPES.has(type))
    .flatMap(([type, items]) => items.map(item => ({ ...item, type })))

  const preferred = preferredSlugs
    .map(slug => regionTags.find(tag => tag.slug === slug))
    .filter((tag): tag is PresentationTag => Boolean(tag))

  const fallback = regionTags.filter(tag => !preferred.some(item => item.slug === tag.slug))
  return [...preferred, ...fallback].slice(0, limit).map(tag => ({
    name: tag.name,
    slug: tag.slug,
    label: tag.type === 'city_country' || tag.type === 'city' ? '城市' : '地区',
    description: `${tag.name}精选图库`,
  }))
}
