import { describe, expect, it } from 'vitest'
import { isExternalCoverKey, resolvePublicCoverUrl, safeExternalCoverUrl } from './cover-url'

describe('公开封面 URL 解析', () => {
  it('安全 HTTPS 外链会归一化后返回', () => {
    const value = ' HTTPS://example.com/cover.jpg?next="x" '

    expect(isExternalCoverKey(value)).toBe(true)
    expect(safeExternalCoverUrl(value)).toBe('https://example.com/cover.jpg?next=%22x%22')
    expect(resolvePublicCoverUrl('gallery-1', value)).toBe('https://example.com/cover.jpg?next=%22x%22')
  })

  it('不安全外链不会作为公开封面下发', () => {
    for (const value of [
      'http://example.com/cover.jpg',
      'https://localhost/cover.jpg',
      'https://127.0.0.1/cover.jpg',
      'https://192.168.1.10/cover.jpg',
    ]) {
      expect(isExternalCoverKey(value)).toBe(true)
      expect(safeExternalCoverUrl(value)).toBeNull()
      expect(resolvePublicCoverUrl('gallery-1', value)).toBeNull()
    }
  })

  it('R2 key 走内部封面代理', () => {
    expect(isExternalCoverKey('covers/gallery-1/cover.jpg')).toBe(false)
    expect(safeExternalCoverUrl('covers/gallery-1/cover.jpg')).toBeNull()
    expect(resolvePublicCoverUrl('gallery-1', 'covers/gallery-1/cover.jpg')).toBe('/api/media/cover/gallery-1')
  })

  it('空封面值返回 null', () => {
    expect(isExternalCoverKey('  ')).toBe(false)
    expect(safeExternalCoverUrl('  ')).toBeNull()
    expect(resolvePublicCoverUrl('gallery-1', '  ')).toBeNull()
  })
})
