import { describe, expect, it } from 'vitest'
import {
  HOME_AD_IMAGE_REQUIREMENTS,
  formatHomeAdImageRequirement,
  formatHomeAdImageSize,
  validateHomeAdImageDimensions,
  validateHomeAdImageFile,
} from './adminHomeAdImage'

describe('adminHomeAdImage', () => {
  it('描述广告大图格式、大小和尺寸要求', () => {
    expect(HOME_AD_IMAGE_REQUIREMENTS.accept).toBe('image/png,image/jpeg,image/webp')
    expect(HOME_AD_IMAGE_REQUIREMENTS.maxBytes).toBe(3 * 1024 * 1024)
    expect(HOME_AD_IMAGE_REQUIREMENTS.minWidth).toBe(1200)
    expect(HOME_AD_IMAGE_REQUIREMENTS.minHeight).toBe(525)
    expect(formatHomeAdImageRequirement()).toContain('推荐 16:7')
    expect(formatHomeAdImageRequirement()).toContain('1600x700px')
    expect(formatHomeAdImageSize(1536)).toBe('1.5 KB')
  })

  it('选择阶段拒绝错误格式和超过 3MB 的文件', () => {
    expect(validateHomeAdImageFile(new File(['x'], 'ad.webp', { type: 'image/webp' }))).toEqual({ valid: true })
    expect(validateHomeAdImageFile(new File(['x'], 'ad.gif', { type: 'image/gif' }))).toEqual({
      valid: false,
      message: '广告大图仅支持 PNG、JPEG、WebP 格式',
    })
    expect(validateHomeAdImageFile(new File([new Uint8Array(3 * 1024 * 1024 + 1)], 'ad.webp', { type: 'image/webp' }))).toEqual({
      valid: false,
      message: '广告大图不能超过 3MB',
    })
  })

  it('选择阶段拒绝尺寸过小的图片', () => {
    expect(validateHomeAdImageDimensions(1600, 700)).toEqual({ valid: true })
    expect(validateHomeAdImageDimensions(1199, 700)).toEqual({
      valid: false,
      message: '广告大图尺寸不能低于 1200x525px',
    })
    expect(validateHomeAdImageDimensions(1600, 524)).toEqual({
      valid: false,
      message: '广告大图尺寸不能低于 1200x525px',
    })
  })
})
