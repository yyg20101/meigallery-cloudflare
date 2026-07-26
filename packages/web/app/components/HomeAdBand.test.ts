import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import HomeAdBand from './HomeAdBand.vue'

const nuxtLinkStub = {
  props: ['to'],
  template: '<a :href="to"><slot /></a>',
}

describe('HomeAdBand', () => {
  const track = vi.fn()

  beforeEach(() => {
    track.mockClear()
    vi.stubGlobal('useAnalytics', () => ({ track }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('关闭时不渲染广告位', () => {
    const wrapper = mount(HomeAdBand, {
      props: { enabled: false },
      global: { stubs: { NuxtLink: nuxtLinkStub } },
    })

    expect(wrapper.find('section').exists()).toBe(false)
  })

  it('站内链接使用 NuxtLink 渲染', () => {
    const wrapper = mount(HomeAdBand, {
      props: {
        enabled: true,
        title: '会员季精选内容',
        summary: '探索本周精选图库。',
        ctaLabel: '查看推荐',
        url: ' /discover?sort=hot#top ',
      },
      global: { stubs: { NuxtLink: nuxtLinkStub } },
    })

    const note = wrapper.find('[id$="-home-ad-internal-note"]')
    expect(wrapper.text()).toContain('会员季精选内容')
    expect(wrapper.find('a').attributes('href')).toBe('/discover?sort=hot#top')
    expect(wrapper.find('a').attributes('target')).toBeUndefined()
    expect(wrapper.find('a').attributes('aria-label')).toBe('查看推荐，站内推荐，目标页面 探索页，路径 /discover?sort=hot#top')
    expect(wrapper.find('a').attributes('aria-describedby')).toBe(note.attributes('id'))
    expect(wrapper.text()).toContain('站内推荐')
    expect(wrapper.text()).toContain('目标页面 探索页')
  })

  it('https 外链使用新窗口和安全 rel', () => {
    const wrapper = mount(HomeAdBand, {
      props: {
        enabled: true,
        title: '赞助推荐',
        url: 'HTTPS://example.com/campaign?next="x"',
      },
      global: { stubs: { NuxtLink: nuxtLinkStub } },
    })

    const link = wrapper.find('a')
    const note = wrapper.find('[id$="-home-ad-external-note"]')
    expect(link.attributes('href')).toBe('https://example.com/campaign?next=%22x%22')
    expect(link.attributes('target')).toBe('_blank')
    expect(link.attributes('rel')).toBe('noopener noreferrer nofollow sponsored')
    expect(link.attributes('referrerpolicy')).toBe('no-referrer')
    expect(link.attributes('aria-label')).toBe('查看详情，外部链接，目标域名 example.com')
    expect(link.attributes('aria-describedby')).toBe(note.attributes('id'))
    expect(wrapper.text()).toContain('外部链接')
    expect(wrapper.text()).toContain('目标域名 example.com')
    expect(wrapper.text()).toContain('不发送来源页信息')
  })

  it('点击广告 CTA 只上报安全目标信息', async () => {
    const wrapper = mount(HomeAdBand, {
      props: {
        enabled: true,
        ads: [{
          id: 'ad-safe-1',
          title: '赞助推荐',
          targetUrl: 'https://example.com/campaign?utm_source=secret',
        }],
      },
      global: { stubs: { NuxtLink: nuxtLinkStub } },
    })

    await wrapper.get('a').trigger('click')

    expect(track).toHaveBeenCalledWith('home_ad_click', expect.objectContaining({
      entityType: 'ad',
      entityId: 'ad-safe-1',
      props: expect.objectContaining({
        ad_id: 'ad-safe-1',
        target_type: 'external',
        target_path_or_host: 'example.com',
      }),
    }))
    expect(JSON.stringify(track.mock.calls)).not.toContain('utm_source')
  })


  it('预览模式保留外链提示但不渲染可跳转链接', () => {
    const wrapper = mount(HomeAdBand, {
      props: {
        enabled: true,
        preview: true,
        title: '赞助推荐',
        ctaLabel: '查看赞助',
        url: 'https://example.com/campaign',
      },
      global: { stubs: { NuxtLink: nuxtLinkStub } },
    })

    const cta = wrapper.find('[aria-disabled="true"]')
    const note = wrapper.find('[id$="-home-ad-external-note"]')
    expect(wrapper.find('a').exists()).toBe(false)
    expect(cta.text()).toContain('查看赞助')
    expect(cta.attributes('href')).toBeUndefined()
    expect(cta.attributes('aria-describedby')).toBe(note.attributes('id'))
    expect(wrapper.text()).toContain('外部链接')
    expect(wrapper.text()).toContain('目标域名 example.com')
    expect(wrapper.text()).toContain('不发送来源页信息')
  })

  it('预览模式允许本地 blob 大图用于实时查看效果', () => {
    const wrapper = mount(HomeAdBand, {
      props: {
        enabled: true,
        preview: true,
        title: '本地预览广告',
        imageUrl: 'blob:http://localhost/ad-preview',
      },
      global: { stubs: { NuxtLink: nuxtLinkStub } },
    })

    expect(wrapper.get('img').attributes('src')).toBe('blob:http://localhost/ad-preview')
    expect(wrapper.get('img').attributes('referrerpolicy')).toBe('no-referrer')
    expect(wrapper.find('a').exists()).toBe(false)
  })

  it('展示默认文案、推广标识和赞助来源说明', () => {
    const wrapper = mount(HomeAdBand, {
      props: {
        enabled: true,
        sponsor: '运营精选',
      },
      global: { stubs: { NuxtLink: nuxtLinkStub } },
    })

    expect(wrapper.text()).toContain('本周推荐')
    expect(wrapper.text()).toContain('推广')
    expect(wrapper.text()).toContain('会员季精选内容')
    expect(wrapper.text()).toContain('运营精选')
    expect(wrapper.text()).toContain('站内推荐')
    expect(wrapper.find('a').text()).toBe('查看详情')
    expect(wrapper.find('a').attributes('aria-label')).toBe('查看详情，站内推荐，目标页面 探索页，路径 /discover?sort=hot')
    expect(wrapper.find('a').attributes('aria-describedby')).toBe(wrapper.find('[id$="-home-ad-internal-note"]').attributes('id'))
    expect(wrapper.find('[id$="-home-ad-internal-note"]').text()).toContain('目标页面 探索页')
  })

  it('组件边界会清洗异常广告文案并回退默认值', () => {
    const unsafeSponsor = 'x'.repeat(41)
    const wrapper = mount(HomeAdBand, {
      props: {
        enabled: true,
        eyebrow: '  本周   推荐  ',
        title: 'x'.repeat(65),
        summary: '会员\u0001精选',
        ctaLabel: '查看\u0001推荐',
        sponsor: unsafeSponsor,
      },
      global: { stubs: { NuxtLink: nuxtLinkStub } },
    })

    expect(wrapper.text()).toContain('本周 推荐')
    expect(wrapper.text()).toContain('会员季精选内容')
    expect(wrapper.text()).toContain('探索本周精选图库、真实案例和会员可访问内容。')
    expect(wrapper.text()).not.toContain(unsafeSponsor)
    expect(wrapper.find('a').text()).toBe('查看详情')
  })

  it('支持多广告圆点切换和广告大图安全渲染', async () => {
    const wrapper = mount(HomeAdBand, {
      props: {
        enabled: true,
        ads: [
          {
            id: 'ad-1',
            eyebrow: '轮播一',
            title: '第一条广告',
            summary: '第一条摘要',
            ctaLabel: '查看第一条',
            targetUrl: '/discover?sort=hot',
            imageUrl: '/api/media/public/home-ads/ad-1/cover.webp',
          },
          {
            id: 'ad-2',
            eyebrow: '轮播二',
            title: '第二条广告',
            summary: '第二条摘要',
            ctaLabel: '查看第二条',
            targetUrl: '/cases',
            imageUrl: 'https://example.com/ad.webp',
          },
        ],
      },
      global: { stubs: { NuxtLink: nuxtLinkStub } },
    })

    expect(wrapper.text()).toContain('第一条广告')
    const firstImg = wrapper.get('img')
    expect(firstImg.attributes('src')).toBe('/api/media/public/home-ads/ad-1/cover.webp')
    expect(firstImg.attributes('referrerpolicy')).toBe('no-referrer')

    const dots = wrapper.findAll('button[aria-label^="切换到广告"]')
    expect(dots).toHaveLength(2)
    expect(dots[0]?.attributes('aria-current')).toBe('true')

    await dots[1]?.trigger('click')

    expect(wrapper.text()).toContain('第二条广告')
    expect(wrapper.get('img').attributes('src')).toBe('https://example.com/ad.webp')
    expect(wrapper.find('a').attributes('href')).toBe('/cases')
  })

  it('忽略不安全的大图 URL 并回退占位视觉', () => {
    const wrapper = mount(HomeAdBand, {
      props: {
        enabled: true,
        title: '赞助推荐',
        imageUrl: '/api/media/public/site/icon.png',
      },
      global: { stubs: { NuxtLink: nuxtLinkStub } },
    })

    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.text()).toContain('上传广告大图后')
  })

  it('本机和私网外链回退到站内推荐页', () => {
    for (const url of [
      'https://localhost/campaign',
      'https://127.0.0.1/campaign',
      'https://127.1/campaign',
      'https://2130706433/campaign',
      'https://0x7f000001/campaign',
      'https://0177.0.0.1/campaign',
      'https://192.168.1.10/campaign',
      'https://0xc0a8010a/campaign',
      'https://[::1]/campaign',
      'https://[fc00::1]/campaign',
      'https://[2001:db8::1]/campaign',
      'https://preview.local/campaign',
    ]) {
      const wrapper = mount(HomeAdBand, {
        props: {
          enabled: true,
          title: '赞助推荐',
          url,
        },
        global: { stubs: { NuxtLink: nuxtLinkStub } },
      })

      expect(wrapper.find('a').attributes('href')).toBe('/discover?sort=hot')
      expect(wrapper.find('a').attributes('target')).toBeUndefined()
    }
  })

  it('包含用户名或密码的外链回退到站内推荐页', () => {
    for (const url of [
      'https://user@example.com/campaign',
      'https://user:pass@example.com/campaign',
    ]) {
      const wrapper = mount(HomeAdBand, {
        props: {
          enabled: true,
          title: '赞助推荐',
          url,
        },
        global: { stubs: { NuxtLink: nuxtLinkStub } },
      })

      expect(wrapper.find('a').attributes('href')).toBe('/discover?sort=hot')
      expect(wrapper.find('a').attributes('target')).toBeUndefined()
    }
  })

  it('异常链接回退到安全站内链接', () => {
    const wrapper = mount(HomeAdBand, {
      props: {
        enabled: true,
        title: '赞助推荐',
        url: 'javascript:alert(1)',
      },
      global: { stubs: { NuxtLink: nuxtLinkStub } },
    })

    expect(wrapper.find('a').attributes('href')).toBe('/discover?sort=hot')
    expect(wrapper.find('a').attributes('target')).toBeUndefined()
  })

  it('包含编码控制字符或空白的链接回退到安全站内链接', () => {
    for (const url of ['https://example.com/%0Ajavascript:alert(1)', '/discover%20next', '/discover next']) {
      const wrapper = mount(HomeAdBand, {
        props: {
          enabled: true,
          title: '赞助推荐',
          url,
        },
        global: { stubs: { NuxtLink: nuxtLinkStub } },
      })

      expect(wrapper.find('a').attributes('href')).toBe('/discover?sort=hot')
      expect(wrapper.find('a').attributes('target')).toBeUndefined()
    }
  })

  it('包含反斜杠的链接回退到安全站内链接', () => {
    for (const url of ['https:\\\\example.com\\campaign', 'https://example.com\\campaign', '/discover\\next', '/discover%5Cnext']) {
      const wrapper = mount(HomeAdBand, {
        props: {
          enabled: true,
          title: '赞助推荐',
          url,
        },
        global: { stubs: { NuxtLink: nuxtLinkStub } },
      })

      expect(wrapper.find('a').attributes('href')).toBe('/discover?sort=hot')
      expect(wrapper.find('a').attributes('target')).toBeUndefined()
    }
  })

  it('内部后台或 API 路径回退到安全站内链接', () => {
    for (const url of ['/admin/settings', '/api/settings/public', '/api/media/public/site/icon.png', '/_nuxt/entry.js']) {
      const wrapper = mount(HomeAdBand, {
        props: {
          enabled: true,
          title: '赞助推荐',
          url,
        },
        global: { stubs: { NuxtLink: nuxtLinkStub } },
      })

      expect(wrapper.find('a').attributes('href')).toBe('/discover?sort=hot')
      expect(wrapper.find('a').attributes('target')).toBeUndefined()
    }
  })
})
