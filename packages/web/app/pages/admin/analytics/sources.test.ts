import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cwd } from 'node:process'
import { describe, expect, it } from 'vitest'

describe('来源分析页职责边界', () => {
  it('只分析来源并把投放链接创建统一交给归因中心', () => {
    const source = readFileSync(join(cwd(), 'app/pages/admin/analytics/sources.vue'), 'utf8')

    expect(source).toContain('to="/admin/attribution/links"')
    expect(source).toContain('本页只分析来源数据')
    expect(source).not.toContain('createTrackingSource')
    expect(source).not.toContain('创建并复制链接')
    expect(source).not.toContain("method: 'POST'")
  })

  it('归因中心创建链接时固定为广告渠道并绑定当前平台', () => {
    const source = readFileSync(join(cwd(), 'app/pages/admin/attribution/links.vue'), 'utf8')

    expect(source).toContain("channel: 'ad'")
    expect(source).toContain('adProvider: selectedProvider.value')
    expect(source).toContain('创建并复制链接')
    expect(source).toContain('if (!createdLink) return')
    expect(source).toContain('链接已保存，但自动复制失败')
  })
})
