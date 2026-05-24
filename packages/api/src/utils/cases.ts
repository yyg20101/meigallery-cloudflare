const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const

export function isValidSlug(value: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
}

export function assertPublishableImageCount(count: number): void {
  if (count < 2 || count > 9) {
    throw new Error('真实案例发布需要 2-9 张图片')
  }
}

export function isAllowedImageType(type: string): boolean {
  return (ALLOWED_IMAGE_TYPES as readonly string[]).includes(type)
}

export function normalizeSortOrder(value: unknown): number {
  const num = Number(value)
  return Number.isFinite(num) ? Math.max(0, Math.floor(num)) : 0
}

export function getPublicOrderClause(sort: string): string {
  switch (sort) {
    case 'newest':
      return ' ORDER BY c.published_at DESC, c.sort_order ASC'
    case 'sort':
    default:
      return ' ORDER BY c.sort_order ASC, c.published_at DESC'
  }
}

export function getPublicImageUrl(imageId: string): string {
  return `/api/cases/images/${imageId}`
}

export function getR2Extension(fileName: string, mimeType: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase()
  if (ext === 'jpg' || ext === 'jpeg' || ext === 'png' || ext === 'webp') return ext
  if (mimeType === 'image/png') return 'png'
  if (mimeType === 'image/webp') return 'webp'
  return 'jpg'
}
