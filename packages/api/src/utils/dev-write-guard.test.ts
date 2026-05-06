import { describe, expect, it } from 'vitest'
import { shouldBlockDevWrite } from './dev-write-guard'

describe('dev 写入保护', () => {
  it('在 dev 且未显式允许时阻止写请求', () => {
    expect(shouldBlockDevWrite('dev', undefined, 'POST')).toBe(true)
    expect(shouldBlockDevWrite('dev', 'false', 'DELETE')).toBe(true)
  })

  it('允许安全方法和显式开启的 dev 写入', () => {
    expect(shouldBlockDevWrite('dev', undefined, 'GET')).toBe(false)
    expect(shouldBlockDevWrite('dev', undefined, 'OPTIONS')).toBe(false)
    expect(shouldBlockDevWrite('dev', 'true', 'POST')).toBe(false)
    expect(shouldBlockDevWrite('production', undefined, 'POST')).toBe(false)
  })
})
