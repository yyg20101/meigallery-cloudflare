import { describe, expect, it } from 'vitest'
import { decodeRouteParam } from './routeParam'

describe('decodeRouteParam', () => {
  it('解码 SSR 直达时的中文路由参数', () => {
    expect(decodeRouteParam('%E4%B8%AD%E6%96%87%E5%9B%BE%E5%BA%93')).toBe('中文图库')
  })

  it('保留客户端导航时已经解码的路由参数', () => {
    expect(decodeRouteParam('中文图库')).toBe('中文图库')
    expect(decodeRouteParam(['gallery-001'])).toBe('gallery-001')
  })

  it('遇到无效编码或缺失参数时安全回退', () => {
    expect(decodeRouteParam('%E4%B8')).toBe('%E4%B8')
    expect(decodeRouteParam(undefined)).toBe('')
  })
})
