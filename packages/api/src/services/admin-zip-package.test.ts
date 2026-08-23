import { describe, expect, it } from 'vitest'
import {
  assertImageMatchesPath,
  detectImageType,
  parseManifestCsv,
  sanitizeImportedImage,
  ZipImportError,
} from './admin-zip-package'

const HEADERS = 'folder,title,slug,region,personality,style,tags,required_level,status'

describe('ZIP manifest.csv 解析', () => {
  it('按固定 schema 解析引用字段，并保留标签分类', () => {
    const rows = parseManifestCsv([
      HEADERS,
      'gallery-001,夏日写真,summer-portrait,广州,开朗,清新,"户外,长发",vip,draft',
    ].join('\r\n'))

    expect(rows).toEqual([{
      folder: 'gallery-001',
      title: '夏日写真',
      slug: 'summer-portrait',
      region: '广州',
      personality: '开朗',
      style: '清新',
      tags: ['户外', '长发'],
      requiredLevel: 'vip',
      status: 'draft',
    }])
  })

  it('拒绝未知列、重复目录、重复 slug 和不完整引号', () => {
    const invalidDocuments = [
      `${HEADERS},unknown\ngallery-001,标题,test-slug,,,,,free,draft,value`,
      `${HEADERS}\ngallery-001,标题,test-slug,,,,,free,draft\nGALLERY-001,标题二,test-slug-2,,,,,free,draft`,
      `${HEADERS}\ngallery-001,标题,test-slug,,,,,free,draft\ngallery-002,标题二,TEST-SLUG,,,,,free,draft`,
      `${HEADERS}\ngallery-001,"未闭合,test-slug,,,,,free,draft`,
    ]

    for (const document of invalidDocuments) {
      expect(() => parseManifestCsv(document)).toThrow(ZipImportError)
    }
  })
})

describe('ZIP 导入图片净化', () => {
  it('识别 JPEG 后移除 APP1 元数据，并保留可解码图像段', () => {
    const jpeg = minimalJpegWithExif()
    expect(detectImageType(jpeg)).toBe('jpg')
    expect(assertImageMatchesPath(jpeg, 'gallery-001/images/001.jpg')).toBe('jpg')

    const sanitized = sanitizeImportedImage(jpeg, 'jpg')
    expect([...sanitized]).not.toEqual([...jpeg])
    expect(findMarker(sanitized, 0xe1)).toBe(false)
    expect(findMarker(sanitized, 0xc0)).toBe(true)
    expect(assertImageMatchesPath(sanitized, 'gallery-001/images/001.jpg')).toBe('jpg')
  })

  it('不把 GIF 内容伪装成受支持的静态导入图片', () => {
    const gif = new TextEncoder().encode('GIF89a')
    expect(detectImageType(gif)).toBe('gif')
    expect(() => assertImageMatchesPath(gif, 'gallery-001/images/001.jpg')).toThrow(ZipImportError)
  })
})

function minimalJpegWithExif(): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe1, 0x00, 0x06, 0x45, 0x78, 0x69, 0x66,
    0xff, 0xc0, 0x00, 0x11,
    0x08, 0x00, 0x10, 0x00, 0x20, 0x03,
    0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
    0xff, 0xda, 0x00, 0x0c,
    0x03, 0x01, 0x00, 0x02, 0x00, 0x03, 0x00, 0x00, 0x3f, 0x00,
    0x00, 0xff, 0xd9,
  ])
}

function findMarker(bytes: Uint8Array, marker: number): boolean {
  for (let index = 0; index + 1 < bytes.byteLength; index++) {
    if (bytes[index] === 0xff && bytes[index + 1] === marker) return true
  }
  return false
}
