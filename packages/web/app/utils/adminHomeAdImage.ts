export const HOME_AD_IMAGE_REQUIREMENTS = {
  accept: 'image/png,image/jpeg,image/webp',
  formatsLabel: 'PNG、JPEG、WebP',
  maxBytes: 3 * 1024 * 1024,
  maxLabel: '3MB',
  minWidth: 1200,
  minHeight: 525,
  recommendedWidth: 1600,
  recommendedHeight: 700,
  ratioLabel: '16:7',
} as const

const ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])

export interface HomeAdImageValidationResult {
  valid: boolean
  message?: string
}

export function validateHomeAdImageFile(file: File): HomeAdImageValidationResult {
  if (!ALLOWED_TYPES.has(file.type)) {
    return { valid: false, message: `广告大图仅支持 ${HOME_AD_IMAGE_REQUIREMENTS.formatsLabel} 格式` }
  }

  if (file.size > HOME_AD_IMAGE_REQUIREMENTS.maxBytes) {
    return { valid: false, message: `广告大图不能超过 ${HOME_AD_IMAGE_REQUIREMENTS.maxLabel}` }
  }

  return { valid: true }
}

export function validateHomeAdImageDimensions(width: number, height: number): HomeAdImageValidationResult {
  if (width < HOME_AD_IMAGE_REQUIREMENTS.minWidth || height < HOME_AD_IMAGE_REQUIREMENTS.minHeight) {
    return {
      valid: false,
      message: `广告大图尺寸不能低于 ${HOME_AD_IMAGE_REQUIREMENTS.minWidth}x${HOME_AD_IMAGE_REQUIREMENTS.minHeight}px`,
    }
  }

  return { valid: true }
}

export function formatHomeAdImageRequirement(): string {
  return `支持 ${HOME_AD_IMAGE_REQUIREMENTS.formatsLabel}，单张不超过 ${HOME_AD_IMAGE_REQUIREMENTS.maxLabel}；推荐 ${HOME_AD_IMAGE_REQUIREMENTS.ratioLabel}，建议 ${HOME_AD_IMAGE_REQUIREMENTS.recommendedWidth}x${HOME_AD_IMAGE_REQUIREMENTS.recommendedHeight}px 或更高，不低于 ${HOME_AD_IMAGE_REQUIREMENTS.minWidth}x${HOME_AD_IMAGE_REQUIREMENTS.minHeight}px。`
}

export function formatHomeAdImageSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB'
  if (bytes >= 1024 * 1024) {
    const value = bytes / 1024 / 1024
    return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)} MB`
  }

  const value = bytes / 1024
  return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)} KB`
}
