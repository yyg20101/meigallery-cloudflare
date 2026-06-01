/**
 * WordPress HTML 正文解析器
 * 从 WordPress Block Editor HTML 中提取图片、视频和纯文本
 */

export interface ParsedMedia {
  type: 'image' | 'video'
  url: string
  width?: number
  height?: number
  alt?: string
}

export interface ParsedContent {
  /** 提取的所有媒体资源 */
  media: ParsedMedia[]
  /** 纯文本正文（去除图片/视频标签后） */
  textContent: string
  /** 简易 Markdown 正文 */
  markdown: string
  /** 原始 HTML（保留快照） */
  rawHtml: string
}

/**
 * 解析 WordPress 文章正文 HTML
 */
export function parseWpContent(html: string): ParsedContent {
  const rawHtml = html
  const media: ParsedMedia[] = []

  // 提取图片: <figure class="wp-block-image..."><img src="..." width="..." height="..." alt="..." /></figure>
  const imgRegex = /<figure[^>]*class="[^"]*wp-block-image[^"]*"[^>]*>\s*<img[^>]*src="([^"]+)"[^>]*\/?>\s*<\/figure>/gi
  let match: RegExpExecArray | null

  while ((match = imgRegex.exec(html)) !== null) {
    const imgTag = match[0]
    const url = match[1]!
    const width = extractAttr(imgTag, 'width')
    const height = extractAttr(imgTag, 'height')
    const alt = extractAttrStr(imgTag, 'alt')

    media.push({
      type: 'image',
      url: getOriginalImageUrl(url),
      width: width ? parseInt(width, 10) : undefined,
      height: height ? parseInt(height, 10) : undefined,
      alt: alt || undefined,
    })
  }

  // 提取视频: <figure class="wp-block-video"><video ... src="..."></video></figure>
  const videoRegex = /<figure[^>]*class="[^"]*wp-block-video[^"]*"[^>]*>\s*<video[^>]*src="([^"]+)"[^>]*>.*?<\/video>\s*<\/figure>/gi

  while ((match = videoRegex.exec(html)) !== null) {
    const videoTag = match[0]
    const url = match[1]!
    const width = extractAttr(videoTag, 'width')
    const height = extractAttr(videoTag, 'height')

    media.push({
      type: 'video',
      url,
      width: width ? parseInt(width, 10) : undefined,
      height: height ? parseInt(height, 10) : undefined,
    })
  }

  // 去除图片和视频块后提取文本
  const textHtml = html
    .replace(/<figure[^>]*class="[^"]*wp-block-image[^"]*"[^>]*>.*?<\/figure>/gi, '')
    .replace(/<figure[^>]*class="[^"]*wp-block-video[^"]*"[^>]*>.*?<\/figure>/gi, '')

  // HTML 转纯文本
  const textContent = htmlToText(textHtml).trim()

  // 生成 Markdown
  const markdown = generateMarkdown(textContent, media)

  return { media, textContent, markdown, rawHtml }
}

/**
 * 将 WordPress 缩略图 URL 转换为原图 URL
 * 如 photo-857x1024.jpg → photo.jpg
 */
export function getOriginalImageUrl(url: string): string {
  return url.replace(/-\d+x\d+(\.\w+)$/, '$1')
}

/**
 * 从 HTML 标签中提取属性值（数字型）
 */
function extractAttr(html: string, attr: string): string | null {
  const regex = new RegExp(`${attr}="(\\d+)"`, 'i')
  const match = regex.exec(html)
  return match ? match[1]! : null
}

/**
 * 从 HTML 标签中提取属性值（字符串型）
 */
function extractAttrStr(html: string, attr: string): string | null {
  const regex = new RegExp(`${attr}="([^"]*)"`, 'i')
  const match = regex.exec(html)
  return match ? match[1]! : null
}

/**
 * 简易 HTML 转纯文本
 */
function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
}

/**
 * 生成 Markdown 正文
 */
function generateMarkdown(text: string, media: ParsedMedia[]): string {
  const parts: string[] = []

  // 图片
  const images = media.filter(m => m.type === 'image')
  if (images.length > 0) {
    parts.push(images.map((img, i) => `![图${i + 1}](${img.url})`).join('\n\n'))
  }

  // 视频
  const videos = media.filter(m => m.type === 'video')
  if (videos.length > 0) {
    parts.push(videos.map((vid, i) => `[视频${i + 1}](${vid.url})`).join('\n\n'))
  }

  // 文本
  if (text) {
    parts.push(text)
  }

  return parts.join('\n\n')
}
