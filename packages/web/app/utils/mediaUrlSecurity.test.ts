import { describe, expect, it } from 'vitest'
import { normalizeMediaUrl, resolveCoverPreviewUrl, resolveMediaDisplayUrl } from './mediaUrlSecurity'

describe('mediaUrlSecurity', () => {
  it('媒体 URL 只允许站内路径和安全 HTTPS 外链', () => {
    expect(normalizeMediaUrl(' /api/media/asset-1/thumbnail ')).toBe('/api/media/asset-1/thumbnail')
    expect(normalizeMediaUrl('HTTPS://example.com/source.jpg?next="x"')).toBe('https://example.com/source.jpg?next=%22x%22')
    expect(resolveMediaDisplayUrl('/api/media/asset-1/thumbnail', 'https://api.test')).toBe('https://api.test/api/media/asset-1/thumbnail')
    expect(resolveMediaDisplayUrl('HTTPS://example.com/source.jpg', 'https://api.test')).toBe('https://example.com/source.jpg')
  })

  it('媒体 URL 拒绝 http、本机和私网地址', () => {
    for (const value of [
      'http://example.com/source.jpg',
      'https://localhost/source.jpg',
      'https://localhost./source.jpg',
      'https://localhost%2e/source.jpg',
      'https://127.0.0.1/source.jpg',
      'https://192.168.1.10/source.jpg',
      'https://preview.local./source.jpg',
      'https://example.com/source%20bad.jpg',
      'https://example.com/%0Asource.jpg',
      'https://user:pass@example.com/source.jpg',
      'https://example.com\\@evil.test/source.jpg',
      'https://example.com/%5Csource.jpg',
      '/api/media/asset-1/thumb%20bad',
      '/api/media/asset-1/%5Cthumb.jpg',
      '//example.com/source.jpg',
      '/\\example.com/source.jpg',
    ]) {
      expect(normalizeMediaUrl(value)).toBe('')
      expect(resolveMediaDisplayUrl(value, 'https://api.test')).toBe('')
    }
  })

  it('封面预览安全外链直通、R2 key 走代理、不安全外链返回 null', () => {
    expect(resolveCoverPreviewUrl('HTTPS://example.com/cover.jpg?next="x"', 'gal_1', 'https://api.test')).toBe('https://example.com/cover.jpg?next=%22x%22')
    expect(resolveCoverPreviewUrl('covers/gal_1/cover.jpg', 'gal_1', 'https://api.test')).toBe('https://api.test/api/media/cover/gal_1')
    expect(resolveCoverPreviewUrl('http://example.com/cover.jpg', 'gal_1', 'https://api.test')).toBeNull()
    expect(resolveCoverPreviewUrl('https://localhost./cover.jpg', 'gal_1', 'https://api.test')).toBeNull()
    expect(resolveCoverPreviewUrl('https://127.0.0.1/cover.jpg', 'gal_1', 'https://api.test')).toBeNull()
  })
})
