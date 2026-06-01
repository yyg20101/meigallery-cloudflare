import { describe, expect, it } from 'vitest'
import { isExpectedGalleryCoverKey, isExpectedGalleryMediaKey } from './media-keys'

describe('图库媒体 R2 key 工具', () => {
  it('校验图库媒体 R2 key 必须属于当前图库和媒体', () => {
    expect(isExpectedGalleryMediaKey('originals/gal_1/asset_1.jpg', 'gal_1', 'asset_1')).toBe(true)
    expect(isExpectedGalleryMediaKey('originals/gal_1/asset_1.jpeg', 'gal_1', 'asset_1')).toBe(true)
    expect(isExpectedGalleryMediaKey('originals/gal_1/asset_1.webp', 'gal_1', 'asset_1')).toBe(true)
    expect(isExpectedGalleryMediaKey('originals/gal_1/asset_1.gif', 'gal_1', 'asset_1')).toBe(true)
    expect(isExpectedGalleryMediaKey('originals/gal_2/asset_1.jpg', 'gal_1', 'asset_1')).toBe(false)
    expect(isExpectedGalleryMediaKey('originals/gal_1/asset_2.jpg', 'gal_1', 'asset_1')).toBe(false)
    expect(isExpectedGalleryMediaKey('cases/gal_1/asset_1.jpg', 'gal_1', 'asset_1')).toBe(false)
    expect(isExpectedGalleryMediaKey('originals/gal_1/asset_1.svg', 'gal_1', 'asset_1')).toBe(false)
  })

  it('校验图库封面 R2 key 只能指向当前图库封面或当前图库原图', () => {
    expect(isExpectedGalleryCoverKey('covers/gal_1.jpg', 'gal_1')).toBe(true)
    expect(isExpectedGalleryCoverKey('covers/gal_1/cover.webp', 'gal_1')).toBe(true)
    expect(isExpectedGalleryCoverKey('originals/gal_1/asset_1.png', 'gal_1')).toBe(true)
    expect(isExpectedGalleryCoverKey('covers/gal_2.jpg', 'gal_1')).toBe(false)
    expect(isExpectedGalleryCoverKey('originals/gal_2/asset_1.png', 'gal_1')).toBe(false)
    expect(isExpectedGalleryCoverKey('site/icon.png', 'gal_1')).toBe(false)
  })
})
