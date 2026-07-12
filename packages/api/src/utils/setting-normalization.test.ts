import { describe, expect, it } from 'vitest'
import { normalizeBooleanSetting } from './setting-normalization'

describe('通用设置归一化', () => {
  it.each([true, 1, '1', 'true'])('将 %j 归一化为 true', (value) => {
    expect(normalizeBooleanSetting(value)).toBe(true)
  })

  it.each([false, 0, '0', 'false', null, undefined, {}])('将 %j 归一化为 false', (value) => {
    expect(normalizeBooleanSetting(value)).toBe(false)
  })
})
