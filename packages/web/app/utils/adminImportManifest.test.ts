import { describe, expect, it } from 'vitest'
import { parseAdminImportManifestCsv } from './adminImportManifest'

describe('adminImportManifest', () => {
  it('解析含 quoted 逗号字段的 manifest CSV', () => {
    const result = parseAdminImportManifestCsv([
      'folder,title,slug,region,personality,style,tags,required_level,status',
      'gallery-001,夏日写真,summer-portrait-001,广东,甜美,清新,"长发,户外,视频",vip,draft',
    ].join('\n'))

    expect(result.errors).toEqual([])
    expect(result.galleries).toEqual([
      {
        folder: 'gallery-001',
        title: '夏日写真',
        slug: 'summer-portrait-001',
        region: '广东',
        personality: '甜美',
        style: '清新',
        tags: '长发,户外,视频',
        requiredLevel: 'vip',
        status: 'draft',
      },
    ])
  })

  it('支持 CRLF、空行和转义引号', () => {
    const csv = 'folder,title,slug,tags\r\n\r\ngallery-001,"夏日 ""轻写真""",summer-portrait-001,"长发,户外"\r\n'

    const result = parseAdminImportManifestCsv(csv)

    expect(result.errors).toEqual([])
    expect(result.galleries).toHaveLength(1)
    expect(result.galleries[0]!.title).toBe('夏日 "轻写真"')
    expect(result.galleries[0]!.tags).toBe('长发,户外')
    expect(result.galleries[0]!.requiredLevel).toBe('free')
    expect(result.galleries[0]!.status).toBe('draft')
  })

  it('缺少必填表头时返回错误', () => {
    const result = parseAdminImportManifestCsv('folder,name,slug\ngallery-001,夏日写真,summer-portrait-001')

    expect(result.galleries).toEqual([])
    expect(result.errors[0]).toContain('缺少必填列')
    expect(result.errors[0]).toContain('title')
  })

  it('数据行为空或引号未闭合时返回错误', () => {
    expect(parseAdminImportManifestCsv('folder,title,slug').errors[0]).toContain('至少需要')
    expect(parseAdminImportManifestCsv('folder,title,slug\n"gallery-001,夏日写真,summer').errors[0]).toContain('未闭合')
  })
})
