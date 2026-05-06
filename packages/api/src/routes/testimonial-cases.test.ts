import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { Bindings, Variables } from '../index'
import { testimonialCaseRoutes } from './testimonial-cases'

function createApp() {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()
  app.route('/api/testimonial-cases', testimonialCaseRoutes)
  return app
}

function createDb(handlers: {
  first?: (sql: string, params: unknown[]) => unknown
  all?: (sql: string, params: unknown[]) => unknown[]
}) {
  return {
    prepare(sql: string) {
      const params: unknown[] = []
      return {
        bind(...values: unknown[]) {
          params.push(...values)
          return this
        },
        async first<T>() {
          return (handlers.first?.(sql, params) ?? null) as T | null
        },
        async all<T>() {
          return { results: (handlers.all?.(sql, params) ?? []) as T[] }
        },
      }
    },
  }
}

describe('公开真实案例 API', () => {
  it('无公开案例时返回 200 空列表', async () => {
    const app = createApp()
    const env = {
      DB: createDb({
        first: () => ({ total: 0 }),
        all: () => [],
      }),
    } as unknown as Bindings

    const res = await app.request('/api/testimonial-cases', {}, env)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({ data: [], total: 0, page: 1, pageSize: 12 })
  })

  it('详情只返回公开图片 URL，不泄露 R2 key', async () => {
    const app = createApp()
    const env = {
      DB: createDb({
        first: sql => sql.includes('FROM testimonial_cases')
          ? {
              id: 'tc_1',
              title: '授权反馈案例',
              slug: 'member-feedback-001',
              summary: '已脱敏的反馈摘要',
              body_md: '## 案例说明',
              seo_title: null,
              seo_description: null,
              published_at: '2026-05-06T00:00:00.000Z',
            }
          : null,
        all: () => [
          { id: 'tci_1', alt_text: '授权反馈案例 1', sort_order: 0, r2_key: 'testimonials/tc_1/tci_1.jpg' },
        ],
      }),
    } as unknown as Bindings

    const res = await app.request('/api/testimonial-cases/member-feedback-001', {}, env)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.images).toEqual([
      { id: 'tci_1', url: '/api/testimonial-cases/images/tci_1', alt: '授权反馈案例 1', sortOrder: 0 },
    ])
    expect(JSON.stringify(body)).not.toContain('testimonials/tc_1/tci_1.jpg')
  })

  it('草稿或不存在的案例详情返回 404', async () => {
    const app = createApp()
    const env = {
      DB: createDb({ first: () => null }),
    } as unknown as Bindings

    const res = await app.request('/api/testimonial-cases/draft-case', {}, env)
    const body = await res.json()

    expect(res.status).toBe(404)
    expect(body.message).toBe('真实案例不存在或暂未公开')
  })

  it('图片代理只返回已发布案例图片内容', async () => {
    const app = createApp()
    const env = {
      DB: createDb({
        first: () => ({ r2_key: 'testimonials/tc_1/tci_1.jpg', mime_type: 'image/jpeg' }),
      }),
      R2: {
        async get(key: string) {
          expect(key).toBe('testimonials/tc_1/tci_1.jpg')
          return { body: new Response('image-bytes').body }
        },
      },
    } as unknown as Bindings

    const res = await app.request('/api/testimonial-cases/images/tci_1', {}, env)

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('image/jpeg')
    expect(await res.text()).toBe('image-bytes')
  })
})
