import { describe, expect, it } from 'vitest'
import { canTransitionConnectionVersion } from './connection-commands'

describe('连接版本状态机', () => {
  it.each([
    ['candidate', 'validating', true],
    ['validating', 'ready', true],
    ['ready', 'active', true],
    ['active', 'draining', true],
    ['draining', 'retired', true],
    ['candidate', 'active', false],
    ['failed', 'active', false],
    ['retired', 'active', false],
  ] as const)('%s -> %s 是否允许', (from, to, allowed) => {
    expect(canTransitionConnectionVersion(from, to)).toBe(allowed)
  })
})
