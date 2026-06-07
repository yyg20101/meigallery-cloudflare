import { describe, expect, it } from 'vitest'
import { normalizeAnalyticsRoute } from './analyticsRoute'

describe('analyticsRoute', () => {
  it('归一化图库和真实案例详情路由', () => {
    expect(normalizeAnalyticsRoute({ fullPath: '/gallery/summer-001?from=home', params: { slug: 'summer-001' } })).toMatchObject({
      skip: false,
      routeName: '/gallery/:slug',
      path: '/gallery/summer-001',
      entityType: 'gallery',
      entityId: 'summer-001',
    })

    expect(normalizeAnalyticsRoute({ fullPath: '/cases/case-001' })).toMatchObject({
      routeName: '/cases/:slug',
      entityType: 'case',
      entityId: 'case-001',
    })
  })

  it('跳过后台和敏感路径', () => {
    expect(normalizeAnalyticsRoute({ fullPath: '/admin' }).skip).toBe(true)
    expect(normalizeAnalyticsRoute({ fullPath: '/api/me' }).skip).toBe(true)
    expect(normalizeAnalyticsRoute({ fullPath: '/login?redirect=/callback?token=abc' }).skip).toBe(true)
  })

  it('搜索和发现页只保留安全筛选参数', () => {
    expect(normalizeAnalyticsRoute({ fullPath: '/search?q=private&tags=a,b&sort=newest' })).toMatchObject({
      routeName: '/search',
      path: '/search?tags=a%2Cb&sort=newest',
    })
    expect(normalizeAnalyticsRoute({ fullPath: '/discover?region=gd&style=fresh' })).toMatchObject({
      routeName: '/discover',
      path: '/discover?region=gd&style=fresh',
    })
  })
})
