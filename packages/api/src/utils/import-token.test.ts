import { describe, expect, it } from 'vitest'
import {
  createImportToken,
  hashImportToken,
  hasImportPermission,
  isImportTokenExpired,
  isSourceBotAllowed,
  parseJsonStringArray,
} from './import-token'

describe('Import Token 工具', () => {
  it('生成带 mgi 前缀的一次性 token', () => {
    const token = createImportToken()

    expect(token).toMatch(/^mgi_[A-Za-z0-9_-]{43}$/)
  })

  it('使用稳定 SHA-256 hex 哈希 token', async () => {
    const hash = await hashImportToken('mgi_test_token')

    expect(hash).toBe(await hashImportToken('mgi_test_token'))
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('从 JSON 数组字符串检查权限', () => {
    expect(hasImportPermission('["gallery:create"]', 'gallery:create')).toBe(true)
    expect(hasImportPermission('["gallery:create"]', 'case:create')).toBe(false)
  })

  it('将非法 JSON 权限视为空数组', () => {
    expect(parseJsonStringArray('{bad json')).toEqual([])
    expect(hasImportPermission('{bad json', 'gallery:create')).toBe(false)
  })

  it('精确检查 sourceBotKey 允许列表', () => {
    expect(isSourceBotAllowed('["ops_gallery_bot"]', 'ops_gallery_bot')).toBe(true)
    expect(isSourceBotAllowed('["ops_gallery_bot"]', 'other_bot')).toBe(false)
    expect(isSourceBotAllowed('[]', 'ops_gallery_bot')).toBe(false)
  })

  it('识别已过期 token 时间戳', () => {
    expect(isImportTokenExpired(null, new Date('2026-05-06T10:00:00.000Z'))).toBe(false)
    expect(isImportTokenExpired('2026-05-06T09:59:59.000Z', new Date('2026-05-06T10:00:00.000Z'))).toBe(true)
    expect(isImportTokenExpired('2026-05-06T10:01:00.000Z', new Date('2026-05-06T10:00:00.000Z'))).toBe(false)
  })
})
