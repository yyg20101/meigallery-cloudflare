import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('后台导航', () => {
  it('使用多平台归因入口名称', () => {
    const source = readFileSync(join(process.cwd(), 'app/layouts/admin.vue'), 'utf8')

    expect(source).toContain("{ to: '/admin/attribution', label: '广告归因'")
    expect(source).toContain("{ to: '/admin/app/wallets', label: 'App 金币钱包'")
    expect(source).not.toContain("label: 'Meta 归因'")
  })
})
