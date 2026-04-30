import { describe, it, expect } from 'vitest'
import { parseWpContent, getOriginalImageUrl } from './wp-html-parser'

describe('getOriginalImageUrl', () => {
  it('去除尺寸后缀', () => {
    expect(getOriginalImageUrl('https://example.com/photo-857x1024.jpg'))
      .toBe('https://example.com/photo.jpg')
  })

  it('保留无尺寸后缀的 URL', () => {
    expect(getOriginalImageUrl('https://example.com/photo.jpg'))
      .toBe('https://example.com/photo.jpg')
  })

  it('处理不同扩展名', () => {
    expect(getOriginalImageUrl('https://example.com/image-640x480.png'))
      .toBe('https://example.com/image.png')
  })
})

describe('parseWpContent', () => {
  it('提取图片', () => {
    const html = `
<figure class="wp-block-image size-large"><img loading="lazy" decoding="async" width="857" height="1024" src="https://example.com/photo-857x1024.jpg" alt="测试图" class="wp-image-5432"/></figure>
`
    const result = parseWpContent(html)
    expect(result.media).toHaveLength(1)
    expect(result.media[0]!.type).toBe('image')
    expect(result.media[0]!.url).toBe('https://example.com/photo.jpg')
    expect(result.media[0]!.width).toBe(857)
    expect(result.media[0]!.height).toBe(1024)
    expect(result.media[0]!.alt).toBe('测试图')
  })

  it('提取视频', () => {
    const html = `
<figure class="wp-block-video"><video height="848" style="aspect-ratio: 384 / 848;" width="384" controls src="https://example.com/video.mp4"></video></figure>
`
    const result = parseWpContent(html)
    expect(result.media).toHaveLength(1)
    expect(result.media[0]!.type).toBe('video')
    expect(result.media[0]!.url).toBe('https://example.com/video.mp4')
  })

  it('提取多张图片和视频', () => {
    const html = `
<figure class="wp-block-image size-large"><img width="857" height="1024" src="https://example.com/a-857x1024.jpg" alt="" class="wp-image-1"/></figure>

<figure class="wp-block-image size-large"><img width="890" height="1024" src="https://example.com/b-890x1024.jpg" alt="" class="wp-image-2"/></figure>

<figure class="wp-block-video"><video height="848" width="384" controls src="https://example.com/c.mp4"></video></figure>

<p>描述文本</p>
`
    const result = parseWpContent(html)
    expect(result.media).toHaveLength(3)
    expect(result.media.filter(m => m.type === 'image')).toHaveLength(2)
    expect(result.media.filter(m => m.type === 'video')).toHaveLength(1)
    expect(result.textContent).toContain('描述文本')
  })

  it('提取纯文本内容', () => {
    const html = `
<figure class="wp-block-image size-large"><img src="https://example.com/a.jpg" alt="" class="wp-image-1"/></figure>

<p>00年&nbsp;身高170&nbsp;&nbsp;体重98&nbsp;&nbsp;留学生</p>
`
    const result = parseWpContent(html)
    expect(result.textContent).toContain('00年')
    expect(result.textContent).toContain('身高170')
    expect(result.textContent).toContain('留学生')
  })

  it('生成 Markdown', () => {
    const html = `
<figure class="wp-block-image size-large"><img src="https://example.com/a-100x200.jpg" alt="" class="wp-image-1"/></figure>

<p>描述</p>
`
    const result = parseWpContent(html)
    expect(result.markdown).toContain('![图1](https://example.com/a.jpg)')
    expect(result.markdown).toContain('描述')
  })

  it('空 HTML 返回空结果', () => {
    const result = parseWpContent('')
    expect(result.media).toHaveLength(0)
    expect(result.textContent).toBe('')
  })

  it('保留原始 HTML', () => {
    const html = '<p>test</p>'
    const result = parseWpContent(html)
    expect(result.rawHtml).toBe(html)
  })
})
