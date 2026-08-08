import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cwd } from 'node:process'
import { describe, expect, it } from 'vitest'

describe('Wallet-1 后台页面边界', () => {
  const source = readFileSync(join(cwd(), 'app/pages/admin/app/wallets/index.vue'), 'utf8')

  it('提供账号查询、预览、申请和独立复核完整流程', () => {
    expect(source).toContain('/api/admin/app/wallets/accounts')
    expect(source).toContain('/api/admin/app/wallets/adjustments/preview')
    expect(source).toContain('/api/admin/app/wallets/adjustments')
    expect(source).toContain("item.adjustmentId}/${decision}")
    expect(source).toContain("'Idempotency-Key'")
    expect(source).toContain('expectedVersion: item.version')
    expect(source).toContain('必须由另一位管理员复核')
  })

  it('不提供交易、批量调币或直接余额写入入口', () => {
    expect(source).toContain('不可购买、消费、转赠、兑换或提现')
    expect(source).toContain('不提供批量调币、直接改余额')
    expect(source).not.toContain('批量提交')
    expect(source).not.toContain('充值按钮')
    expect(source).not.toContain('直接保存余额')
  })

  it('关键容器与按钮具备窄屏防溢出约束', () => {
    expect(source).toContain('min-w-0 space-y-5')
    expect(source).toContain('w-full rounded-lg bg-pink-600')
    expect(source).toContain('sm:w-auto')
    expect(source).toContain('[overflow-wrap:anywhere]')
  })
})
