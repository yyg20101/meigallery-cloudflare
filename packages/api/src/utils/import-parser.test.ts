import { describe, it, expect } from 'vitest'
import { parseManifestCsv, parseCsvLine, levelToRank } from './import-parser'

describe('parseCsvLine', () => {
  it('解析简单行', () => {
    expect(parseCsvLine('a,b,c')).toEqual(['a', 'b', 'c'])
  })

  it('处理引号内逗号', () => {
    expect(parseCsvLine('a,"b,c",d')).toEqual(['a', 'b,c', 'd'])
  })

  it('处理转义引号', () => {
    expect(parseCsvLine('a,"b""c",d')).toEqual(['a', 'b"c', 'd'])
  })

  it('处理空字段', () => {
    expect(parseCsvLine('a,,c')).toEqual(['a', '', 'c'])
  })

  it('处理前后空格', () => {
    expect(parseCsvLine(' a , b , c ')).toEqual(['a', 'b', 'c'])
  })
})

describe('parseManifestCsv', () => {
  it('解析完整 CSV', () => {
    const csv = `folder,title,slug,region,personality,style,tags,required_level,status
gallery-001,夏日写真,summer-portrait-001,广东,甜美,清新,"长发,户外",vip,draft
gallery-002,秋日时光,autumn-time-002,北京,知性,优雅,"短发,室内",svip,published`

    const result = parseManifestCsv(csv)
    expect(result.errors).toHaveLength(0)
    expect(result.entries).toHaveLength(2)
    expect(result.entries[0]).toEqual({
      folder: 'gallery-001',
      title: '夏日写真',
      slug: 'summer-portrait-001',
      region: '广东',
      personality: '甜美',
      style: '清新',
      tags: '长发,户外',
      requiredLevel: 'vip',
      status: 'draft',
    })
    expect(result.entries[1]!.requiredLevel).toBe('svip')
    expect(result.entries[1]!.status).toBe('published')
  })

  it('空 CSV 返回错误', () => {
    const result = parseManifestCsv('folder,title,slug')
    expect(result.entries).toHaveLength(0)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]!.error).toContain('至少需要')
  })

  it('缺少必填表头返回错误', () => {
    const csv = `folder,name,slug\ngallery-001,test,test-001`
    const result = parseManifestCsv(csv)
    expect(result.errors[0]!.error).toContain('缺少必填列')
    expect(result.errors[0]!.error).toContain('title')
  })

  it('缺少必填字段的行记录错误但不中断', () => {
    const csv = `folder,title,slug
gallery-001,,test-001
gallery-002,有标题,valid-slug`

    const result = parseManifestCsv(csv)
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]!.title).toBe('有标题')
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]!.line).toBe(2)
  })

  it('无效 slug 格式记录错误', () => {
    const csv = `folder,title,slug
gallery-001,测试,INVALID SLUG!`

    const result = parseManifestCsv(csv)
    expect(result.entries).toHaveLength(0)
    expect(result.errors[0]!.error).toContain('slug 格式无效')
  })

  it('无效 required_level 记录错误', () => {
    const csv = `folder,title,slug,required_level
gallery-001,测试,test-001,gold`

    const result = parseManifestCsv(csv)
    expect(result.entries).toHaveLength(0)
    expect(result.errors[0]!.error).toContain('无效的 required_level')
  })

  it('无效 status 记录错误', () => {
    const csv = `folder,title,slug,status
gallery-001,测试,test-001,archived`

    const result = parseManifestCsv(csv)
    expect(result.entries).toHaveLength(0)
    expect(result.errors[0]!.error).toContain('无效的 status')
  })

  it('跳过空行', () => {
    const csv = `folder,title,slug
gallery-001,测试一,test-001

gallery-002,测试二,test-002`

    const result = parseManifestCsv(csv)
    expect(result.entries).toHaveLength(2)
    expect(result.errors).toHaveLength(0)
  })

  it('中文 slug 合法', () => {
    const csv = `folder,title,slug
gallery-001,测试,测试-slug-001`

    const result = parseManifestCsv(csv)
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]!.slug).toBe('测试-slug-001')
  })
})

describe('levelToRank', () => {
  it('free 或 undefined 返回 0', () => {
    expect(levelToRank()).toBe(0)
    expect(levelToRank('free')).toBe(0)
    expect(levelToRank('')).toBe(0)
  })

  it('vip 返回 10', () => {
    expect(levelToRank('vip')).toBe(10)
  })

  it('svip 返回 20', () => {
    expect(levelToRank('svip')).toBe(20)
  })

  it('未知值返回 0', () => {
    expect(levelToRank('gold')).toBe(0)
  })
})
