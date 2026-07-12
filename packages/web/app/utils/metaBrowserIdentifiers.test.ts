import { describe, expect, it } from 'vitest'
import { readMetaBrowserIdentifiers } from './metaBrowserIdentifiers'

describe('readMetaBrowserIdentifiers', () => {
  it('读取合法 _fbp 并从 fbclid 生成 _fbc', () => {
    expect(readMetaBrowserIdentifiers('_fbp=fb.1.1700000000000.123456789', 'CLICK_abc-123', 1_700_000_000_000)).toEqual({
      fbp: 'fb.1.1700000000000.123456789',
      fbc: 'fb.1.1700000000000.CLICK_abc-123',
    })
  })

  it('保留合法 _fbc，拒绝控制字符、超长值和无效 fbclid', () => {
    expect(readMetaBrowserIdentifiers(
      '_fbp=bad%0Avalue; _fbc=fb.1.1700000000000.saved-click',
      `${'x'.repeat(129)}\n`,
      1_700_000_000_000,
    )).toEqual({ fbc: 'fb.1.1700000000000.saved-click' })
  })
})
