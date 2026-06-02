import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { Bindings, Variables } from '../../index'
import { adminSettingsRoutes } from './settings'

type ExecutedSql = Array<{ sql: string; params: unknown[] }>

function createApp(role: string | null = 'owner') {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()
  app.use('*', async (c, next) => {
    c.set('userId', role ? 1 : null)
    c.set('userRole', role)
    await next()
  })
  app.route('/api/admin/settings', adminSettingsRoutes)
  return app
}

function createDb(handlers: {
  first?: (sql: string, params: unknown[]) => unknown
  all?: (sql: string, params: unknown[]) => unknown[]
  run?: (sql: string, params: unknown[]) => unknown
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
        async run() {
          return handlers.run?.(sql, params) ?? { success: true }
        },
      }
    },
  }
}

function hasSettingWrite(executed: ExecutedSql, key: string, jsonValue?: string) {
  return executed.some(item =>
    item.sql.includes('INSERT INTO site_settings')
    && item.sql.includes('ON CONFLICT(key) DO UPDATE')
    && item.params[0] === key
    && (jsonValue === undefined || item.params[1] === jsonValue),
  )
}

describe('后台站点设置 API', () => {
  it('站长读取设置时单条历史损坏 JSON 不阻断页面打开', async () => {
    const app = createApp()
    const env = {
      DB: createDb({
        all: (sql) => {
          if (sql.includes('SELECT key, value, updated_at FROM site_settings')) {
            return [
              { key: 'site_name', value: JSON.stringify('测试图库'), updated_at: '2026-06-02 00:00:00' },
              { key: 'seo_title', value: '{"broken"', updated_at: '2026-06-02 00:00:00' },
              { key: 'home_ad_enabled', value: 'true', updated_at: '2026-06-02 00:00:00' },
            ]
          }
          return []
        },
      }),
    } as unknown as Bindings

    const res = await app.request('/api/admin/settings', {}, env)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.site_name.value).toBe('测试图库')
    expect(body.data.seo_title.value).toBe('')
    expect(body.data.home_ad_enabled.value).toBe(true)
  })

  it('站长更新首页广告链接时会写入归一化值和审计日志', async () => {
    const executed: ExecutedSql = []
    const app = createApp()
    const env = {
      DB: createDb({
        all: (sql) => {
          if (sql.includes('SELECT key, value FROM site_settings')) {
            return [
              { key: 'home_ad_enabled', value: JSON.stringify(false) },
              { key: 'home_ad_url', value: JSON.stringify('') },
            ]
          }
          return []
        },
        run: (sql, params) => {
          executed.push({ sql, params })
          return { success: true }
        },
      }),
    } as unknown as Bindings

    const res = await app.request('/api/admin/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        home_ad_enabled: 'true',
        home_ad_url: ' /discover?sort=hot ',
      }),
    }, env)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.updated).toEqual(['home_ad_enabled', 'home_ad_url'])
    expect(hasSettingWrite(executed, 'home_ad_enabled', 'true')).toBe(true)
    expect(hasSettingWrite(executed, 'home_ad_url', '"/discover?sort=hot"')).toBe(true)
    expect(executed.some(item => item.sql.includes('INSERT INTO admin_audit_logs'))).toBe(true)
  })

  it('拒绝不安全的首页广告链接', async () => {
    const executed: ExecutedSql = []
    const app = createApp()
    const env = {
      DB: createDb({
        run: (sql, params) => {
          executed.push({ sql, params })
          return { success: true }
        },
      }),
    } as unknown as Bindings

    for (const homeAdUrl of [
      'javascript:alert(1)',
      '/admin/settings',
      '/api/settings/public',
      '/api/media/public/site/icon.png',
      'https:\\\\example.com\\campaign',
      'https://example.com\\campaign',
      '/discover%5Cnext',
      '/discover?token=abc',
      '/discover#token=abc',
      'https://example.com/campaign?api_key=abc',
      'https://example.com/campaign#/callback?access_token=abc',
    ]) {
      const res = await app.request('/api/admin/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ home_ad_url: homeAdUrl }),
      }, env)
      const body = await res.json()

      expect(res.status).toBe(400)
      expect(body.message).toContain('首页广告链接')
    }
    expect(executed).toHaveLength(0)
  })

  it('站长更新首页广告文案时会归一化空白并限制长度', async () => {
    const executed: ExecutedSql = []
    const app = createApp()
    const env = {
      DB: createDb({
        all: (sql) => {
          if (sql.includes('SELECT key, value FROM site_settings')) {
            return [
              { key: 'home_ad_title', value: JSON.stringify('旧标题') },
              { key: 'home_ad_summary', value: JSON.stringify('旧摘要') },
            ]
          }
          return []
        },
        run: (sql, params) => {
          executed.push({ sql, params })
          return { success: true }
        },
      }),
    } as unknown as Bindings

    const res = await app.request('/api/admin/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        home_ad_title: '  会员季   精选内容  ',
        home_ad_summary: '精选图库与真实案例',
      }),
    }, env)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.updated).toEqual(['home_ad_title', 'home_ad_summary'])
    expect(hasSettingWrite(executed, 'home_ad_title', '"会员季 精选内容"')).toBe(true)
    expect(executed.some(item => item.sql.includes('INSERT INTO admin_audit_logs'))).toBe(true)
  })

  it('站长更新 SEO 和首页短文案时会归一化空白并记录审计日志', async () => {
    const executed: ExecutedSql = []
    const app = createApp()
    const env = {
      DB: createDb({
        all: (sql) => {
          if (sql.includes('SELECT key, value FROM site_settings')) {
            return [
              { key: 'site_name', value: JSON.stringify('旧站名') },
              { key: 'seo_title', value: JSON.stringify('旧标题') },
              { key: 'home_hero_title', value: JSON.stringify('旧首页标题') },
            ]
          }
          return []
        },
        run: (sql, params) => {
          executed.push({ sql, params })
          return { success: true }
        },
      }),
    } as unknown as Bindings

    const res = await app.request('/api/admin/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        site_name: '  测试   图库站  ',
        seo_title: '  测试站点   -   精选图库  ',
        home_hero_title: '首页精选',
      }),
    }, env)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.updated).toEqual(['site_name', 'seo_title', 'home_hero_title'])
    expect(hasSettingWrite(executed, 'site_name', '"测试 图库站"')).toBe(true)
    expect(hasSettingWrite(executed, 'seo_title', '"测试站点 - 精选图库"')).toBe(true)
    expect(executed.some(item => item.sql.includes('INSERT INTO admin_audit_logs'))).toBe(true)
  })

  it('站长保存 SEO 时历史损坏旧值不会阻断覆盖修复', async () => {
    const executed: ExecutedSql = []
    const app = createApp()
    const env = {
      DB: createDb({
        all: (sql) => {
          if (sql.includes('SELECT key, value FROM site_settings')) {
            return [
              { key: 'seo_title', value: '{"broken"' },
            ]
          }
          return []
        },
        run: (sql, params) => {
          executed.push({ sql, params })
          return { success: true }
        },
      }),
    } as unknown as Bindings

    const res = await app.request('/api/admin/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        seo_title: '  测试站点   -   精选图库  ',
      }),
    }, env)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.updated).toEqual(['seo_title'])
    expect(hasSettingWrite(executed, 'seo_title', '"测试站点 - 精选图库"')).toBe(true)
    expect(executed.some(item => item.sql.includes('INSERT INTO admin_audit_logs'))).toBe(true)
  })

  it('站长保存 SEO 时缺失设置行会自动补齐', async () => {
    const executed: ExecutedSql = []
    const app = createApp()
    const env = {
      DB: createDb({
        all: (sql) => {
          if (sql.includes('SELECT key, value FROM site_settings')) return []
          return []
        },
        run: (sql, params) => {
          executed.push({ sql, params })
          return { success: true }
        },
      }),
    } as unknown as Bindings

    const res = await app.request('/api/admin/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        site_name: '  星耀   传媒  ',
        seo_title: '  星耀传媒  ',
        site_description: '  用专业服务   点亮每一次相遇.  ',
      }),
    }, env)
    const body = await res.json()
    const auditLog = executed.find(item => item.sql.includes('INSERT INTO admin_audit_logs'))

    expect(res.status).toBe(200)
    expect(body.updated).toEqual(['site_name', 'seo_title', 'site_description'])
    expect(hasSettingWrite(executed, 'site_name', '"星耀 传媒"')).toBe(true)
    expect(hasSettingWrite(executed, 'seo_title', '"星耀传媒"')).toBe(true)
    expect(hasSettingWrite(executed, 'site_description', '"用专业服务 点亮每一次相遇."')).toBe(true)
    expect(auditLog?.params[5]).toBe('{}')
    expect(auditLog?.params[6]).toBe(JSON.stringify({
      site_name: '星耀 传媒',
      seo_title: '星耀传媒',
      site_description: '用专业服务 点亮每一次相遇.',
    }))
  })

  it('站长更新首页内容配置时会归一化数量、slug 和规则 Markdown', async () => {
    const executed: ExecutedSql = []
    const app = createApp()
    const env = {
      DB: createDb({
        all: (sql) => {
          if (sql.includes('SELECT key, value FROM site_settings')) {
            return [
              { key: 'home_hot_tag_limit', value: JSON.stringify('15') },
              { key: 'home_featured_region_slugs', value: JSON.stringify('') },
              { key: 'rules_page_content', value: JSON.stringify('旧规则') },
            ]
          }
          return []
        },
        run: (sql, params) => {
          executed.push({ sql, params })
          return { success: true }
        },
      }),
    } as unknown as Bindings

    const res = await app.request('/api/admin/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        home_hot_tag_limit: ' 12 ',
        home_featured_region_slugs: ' Canada,domestic,canada,toronto-city ',
        rules_page_content: '## 规则\r\n\r\n- 仅限授权内容',
      }),
    }, env)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.updated).toEqual(['home_hot_tag_limit', 'home_featured_region_slugs', 'rules_page_content'])
    expect(hasSettingWrite(executed, 'home_hot_tag_limit', '"12"')).toBe(true)
    expect(hasSettingWrite(executed, 'home_featured_region_slugs', '"canada,domestic,toronto-city"')).toBe(true)
    expect(hasSettingWrite(executed, 'rules_page_content', '"## 规则\\n\\n- 仅限授权内容"')).toBe(true)
    expect(executed.some(item => item.sql.includes('INSERT INTO admin_audit_logs'))).toBe(true)
  })

  it('拒绝异常首页内容配置', async () => {
    const app = createApp()
    const env = { DB: createDb({}) } as unknown as Bindings

    for (const payload of [
      { home_hot_tag_limit: '31' },
      { home_hot_tag_limit: '1.5' },
      { home_featured_region_slugs: 'canada,../admin' },
      { home_featured_region_slugs: Array.from({ length: 13 }, (_, index) => `tag-${index}`).join(',') },
      { rules_modal_content: '规则\u0001内容' },
      { rules_page_content: 'x'.repeat(8001) },
    ]) {
      const res = await app.request('/api/admin/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }, env)
      const body = await res.json()

      expect(res.status).toBe(400)
      expect(body.message).toMatch(/首页热门标签数量|主推地区|Markdown/)
    }
  })

  it('拒绝过长或包含控制字符的 SEO 和首页短文案', async () => {
    const app = createApp()
    const env = { DB: createDb({}) } as unknown as Bindings

    for (const payload of [
      { site_name: '测试\u0001图库' },
      { seo_title: 'x'.repeat(81) },
      { home_hero_subtitle: 'x'.repeat(181) },
      { rules_entry_icon: '<svg>' },
    ]) {
      const res = await app.request('/api/admin/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }, env)
      const body = await res.json()

      expect(res.status).toBe(400)
      expect(body.message).toMatch(/站点名称|SEO 标题|首页副标题|规则入口图标/)
    }
  })

  it('拒绝过长或包含控制字符的首页广告文案', async () => {
    const app = createApp()
    const env = { DB: createDb({}) } as unknown as Bindings

    for (const payload of [
      { home_ad_title: 'x'.repeat(41) },
      { home_ad_summary: 'x'.repeat(121) },
      { home_ad_cta_label: '查看\u0001推荐' },
    ]) {
      const res = await app.request('/api/admin/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }, env)
      const body = await res.json()

      expect(res.status).toBe(400)
      expect(body.message).toMatch(/首页广告/)
    }
  })

  it('站长更新首页广告排期时会写入 ISO 时间并记录审计日志', async () => {
    const executed: ExecutedSql = []
    const app = createApp()
    const env = {
      DB: createDb({
        all: (sql) => {
          if (sql.includes('SELECT key, value FROM site_settings')) {
            return [
              { key: 'home_ad_starts_at', value: JSON.stringify('') },
              { key: 'home_ad_ends_at', value: JSON.stringify('') },
            ]
          }
          return []
        },
        run: (sql, params) => {
          executed.push({ sql, params })
          return { success: true }
        },
      }),
    } as unknown as Bindings

    const res = await app.request('/api/admin/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        home_ad_starts_at: '2026-06-01T08:00:00+08:00',
        home_ad_ends_at: '2026-06-02T08:00:00+08:00',
      }),
    }, env)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.updated).toEqual(['home_ad_starts_at', 'home_ad_ends_at'])
    expect(hasSettingWrite(executed, 'home_ad_starts_at', '"2026-06-01T00:00:00.000Z"')).toBe(true)
    expect(hasSettingWrite(executed, 'home_ad_ends_at', '"2026-06-02T00:00:00.000Z"')).toBe(true)
    expect(executed.some(item => item.sql.includes('INSERT INTO admin_audit_logs'))).toBe(true)
  })

  it('拒绝无效或倒置的首页广告排期', async () => {
    const app = createApp()
    const env = { DB: createDb({}) } as unknown as Bindings
    const cases = [
      { home_ad_starts_at: 'not-a-date' },
      {
        home_ad_starts_at: '2026-06-02T08:00:00+08:00',
        home_ad_ends_at: '2026-06-01T08:00:00+08:00',
      },
    ]

    for (const payload of cases) {
      const res = await app.request('/api/admin/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }, env)
      const body = await res.json()

      expect(res.status).toBe(400)
      expect(body.message).toMatch(/首页广告/)
    }
  })

  it('只更新单个广告排期字段时会结合已有值校验顺序', async () => {
    const executed: ExecutedSql = []
    const app = createApp()
    const env = {
      DB: createDb({
        all: (sql) => {
          if (sql.includes('SELECT key, value FROM site_settings')) {
            return [
              { key: 'home_ad_starts_at', value: JSON.stringify('2026-06-02T00:00:00.000Z') },
              { key: 'home_ad_ends_at', value: JSON.stringify('') },
            ]
          }
          return []
        },
        run: (sql, params) => {
          executed.push({ sql, params })
          return { success: true }
        },
      }),
    } as unknown as Bindings

    const res = await app.request('/api/admin/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ home_ad_ends_at: '2026-06-01T00:00:00.000Z' }),
    }, env)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.message).toContain('首页广告结束时间必须晚于开始时间')
    expect(executed).toHaveLength(0)
  })

  it('归一化公开图片设置和规则页路径', async () => {
    const executed: ExecutedSql = []
    const app = createApp()
    const env = {
      DB: createDb({
        all: (sql) => {
          if (sql.includes('SELECT key, value FROM site_settings')) {
            return [
              { key: 'site_icon', value: JSON.stringify('') },
              { key: 'og_image', value: JSON.stringify('') },
              { key: 'rules_page_url', value: JSON.stringify('/rules') },
            ]
          }
          return []
        },
        run: (sql, params) => {
          executed.push({ sql, params })
          return { success: true }
        },
      }),
    } as unknown as Bindings

    const res = await app.request('/api/admin/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        site_icon: ' /api/media/public/site/icon.png ',
        og_image: ' https://example.com/og.jpg ',
        rules_page_url: ' /rules?from=entry ',
      }),
    }, env)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.updated).toEqual(['site_icon', 'og_image', 'rules_page_url'])
    expect(hasSettingWrite(executed, 'site_icon', '"/api/media/public/site/icon.png"')).toBe(true)
    expect(hasSettingWrite(executed, 'og_image', '"https://example.com/og.jpg"')).toBe(true)
    expect(hasSettingWrite(executed, 'rules_page_url', '"/rules?from=entry"')).toBe(true)
    expect(executed.some(item => item.sql.includes('INSERT INTO admin_audit_logs'))).toBe(true)
  })

  it('拒绝危险的公开图片设置和规则页路径', async () => {
    const app = createApp()
    const env = { DB: createDb({}) } as unknown as Bindings
    const cases = [
      { site_icon: 'javascript:alert(1)' },
      { og_image: 'http://example.com/og.jpg' },
      { site_icon: 'https://localhost/icon.png' },
      { og_image: 'https://192.168.1.10/og.jpg' },
      { og_image: 'https://198.51.100.10/og.jpg' },
      { og_image: 'https://example.com/og.jpg?signature=abc' },
      { og_image: 'https://example.com/og.jpg#signature=abc' },
      { site_icon: 'https://example.com\\icon.png' },
      { og_image: 'https://example.com/%5Cog.jpg' },
      { site_icon: '/discover?sort=hot' },
      { og_image: '/api/media/public/avatars/user.png' },
      { rules_page_url: 'https://example.com/rules' },
      { rules_page_url: '/rules%5Cnext' },
      { rules_page_url: '/rules?access_token=abc' },
      { rules_page_url: '/rules#access_token=abc' },
    ]

    for (const payload of cases) {
      const res = await app.request('/api/admin/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }, env)
      const body = await res.json()

      expect(res.status).toBe(400)
      expect(body.message).toMatch(/URL|链接/)
    }
  })

  it('站长可以上传站点图标并同步写入 site_icon 设置', async () => {
    const putKeys: string[] = []
    const executed: ExecutedSql = []
    const app = createApp()
    const env = {
      DB: createDb({
        first: (sql) => {
          if (sql.includes("WHERE key = 'site_icon'")) return { value: JSON.stringify('') }
          return null
        },
        run: (sql, params) => {
          executed.push({ sql, params })
          return { success: true }
        },
      }),
      R2: {
        put: async (key: string) => {
          putKeys.push(key)
        },
      },
    } as unknown as Bindings
    const form = new FormData()
    form.set('file', new File([new Uint8Array([1, 2, 3])], 'brand.png', { type: 'image/png' }))

    const res = await app.request('/api/admin/settings/site-icon', { method: 'POST', body: form }, env)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.iconUrl).toMatch(/^\/api\/media\/public\/site\/site-icon-/)
    expect(putKeys[0]).toMatch(/^site\/site-icon-/)
    expect(hasSettingWrite(executed, 'site_icon')).toBe(true)
    expect(executed.some(item => item.sql.includes('INSERT INTO admin_audit_logs'))).toBe(true)
  })

  it('站点图标历史旧值损坏时仍可上传新图标', async () => {
    const putKeys: string[] = []
    const deletedKeys: string[] = []
    const executed: ExecutedSql = []
    const app = createApp()
    const env = {
      DB: createDb({
        first: (sql) => {
          if (sql.includes("WHERE key = 'site_icon'")) return { value: '{"broken"' }
          return null
        },
        run: (sql, params) => {
          executed.push({ sql, params })
          return { success: true }
        },
      }),
      R2: {
        put: async (key: string) => {
          putKeys.push(key)
        },
        delete: async (key: string) => {
          deletedKeys.push(key)
        },
      },
    } as unknown as Bindings
    const form = new FormData()
    form.set('file', new File([new Uint8Array([1, 2, 3])], 'brand.png', { type: 'image/png' }))

    const res = await app.request('/api/admin/settings/site-icon', { method: 'POST', body: form }, env)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.iconUrl).toMatch(/^\/api\/media\/public\/site\/site-icon-/)
    expect(putKeys[0]).toMatch(/^site\/site-icon-/)
    expect(deletedKeys).toHaveLength(0)
    expect(hasSettingWrite(executed, 'site_icon')).toBe(true)
    expect(executed.some(item => item.sql.includes('INSERT INTO admin_audit_logs'))).toBe(true)
  })
})
