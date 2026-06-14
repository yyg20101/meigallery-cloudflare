import { describe, expect, it } from 'vitest'
import {
  buildAbsoluteSeoUrl,
  buildArticleJsonLd,
  buildCanonicalUrl,
  buildImageGalleryJsonLd,
  buildJsonLdScript,
  buildWebSiteJsonLd,
  normalizeSeoSiteUrl,
} from './seoMetadata'

describe('seoMetadata', () => {
  it('规范站点域名并为 canonical 去除追踪参数和片段', () => {
    expect(normalizeSeoSiteUrl('https://616618.xyz/path?x=1')).toBe('https://616618.xyz')
    expect(normalizeSeoSiteUrl('not a url')).toBe('https://616618.xyz')

    expect(buildCanonicalUrl('https://616618.xyz/', '/discover?utm_source=meta&tag=guangdong&fbclid=abc&sort=hot#top')).toBe(
      'https://616618.xyz/discover?tag=guangdong&sort=hot',
    )
    expect(buildCanonicalUrl('https://616618.xyz/', 'https://evil.example/gallery/demo?tag=x')).toBe('https://616618.xyz/gallery/demo?tag=x')
  })

  it('把站内路径和安全外链转为可用于 OG 的绝对 URL', () => {
    expect(buildAbsoluteSeoUrl('https://616618.xyz', '/api/media/public/site/og.jpg?size=large#preview')).toBe(
      'https://616618.xyz/api/media/public/site/og.jpg?size=large',
    )
    expect(buildAbsoluteSeoUrl('https://616618.xyz', 'https://cdn.example.com/cover.jpg?x=1#fragment')).toBe(
      'https://cdn.example.com/cover.jpg?x=1',
    )
    expect(buildAbsoluteSeoUrl('https://616618.xyz', 'javascript:alert(1)')).toBe('')
  })

  it('生成安全 JSON-LD script，避免 script 结束标签注入', () => {
    const script = buildJsonLdScript({
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: '</script><script>alert(1)</script>',
    })

    expect(script.type).toBe('application/ld+json')
    expect(script.innerHTML).toContain('\\u003c/script\\u003e')
    expect(script.innerHTML).not.toContain('</script>')
  })

  it('生成首页 WebSite 与 Organization 结构化数据', () => {
    const graph = buildWebSiteJsonLd({
      siteUrl: 'https://616618.xyz',
      siteName: '测试图库站',
      description: '授权写真、时尚、生活与艺术内容。',
      logoUrl: '/api/media/public/site/icon.png',
      keywords: ['授权图库', '写真', '授权图库'],
    })

    expect(graph['@graph']).toEqual([
      expect.objectContaining({
        '@type': 'WebSite',
        name: '测试图库站',
        url: 'https://616618.xyz/',
        description: '授权写真、时尚、生活与艺术内容。',
        inLanguage: 'zh-CN',
        keywords: '授权图库, 写真',
      }),
      expect.objectContaining({
        '@type': 'Organization',
        name: '测试图库站',
        url: 'https://616618.xyz/',
        logo: 'https://616618.xyz/api/media/public/site/icon.png',
      }),
    ])
  })

  it('生成图库详情 ImageGallery 结构化数据', () => {
    const graph = buildImageGalleryJsonLd({
      siteUrl: 'https://616618.xyz',
      path: '/gallery/summer-portrait?utm_source=meta',
      title: '夏日授权写真',
      description: '夏日户外主题授权图库',
      imageUrls: ['/api/media/public/gallery/cover.jpg', 'https://cdn.example.com/photo.jpg'],
      datePublished: '2026-06-01T08:00:00.000Z',
      keywords: ['广东', '清新'],
    })

    expect(graph).toEqual(expect.objectContaining({
      '@type': 'ImageGallery',
      name: '夏日授权写真',
      headline: '夏日授权写真',
      description: '夏日户外主题授权图库',
      url: 'https://616618.xyz/gallery/summer-portrait',
      datePublished: '2026-06-01T08:00:00.000Z',
      keywords: '广东, 清新',
      image: [
        'https://616618.xyz/api/media/public/gallery/cover.jpg',
        'https://cdn.example.com/photo.jpg',
      ],
    }))
  })

  it('生成真实案例 Article 结构化数据', () => {
    const graph = buildArticleJsonLd({
      siteUrl: 'https://616618.xyz',
      path: '/cases/spring-lookbook',
      siteName: '测试图库站',
      title: '春日反馈案例',
      description: '已授权和脱敏的用户反馈。',
      imageUrls: ['/api/cases/images/case_1'],
      datePublished: '2026-06-02T09:30:00.000Z',
      keywords: ['真实案例', '授权反馈'],
    })

    expect(graph).toEqual(expect.objectContaining({
      '@type': 'Article',
      headline: '春日反馈案例',
      description: '已授权和脱敏的用户反馈。',
      url: 'https://616618.xyz/cases/spring-lookbook',
      image: ['https://616618.xyz/api/cases/images/case_1'],
      keywords: '真实案例, 授权反馈',
      publisher: expect.objectContaining({
        '@type': 'Organization',
        name: '测试图库站',
      }),
    }))
  })
})
