import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import HomeAdBand from './HomeAdBand.vue'

const nuxtLinkStub = {
  props: ['to'],
  template: '<a :href="to"><slot /></a>',
}

describe('HomeAdBand', () => {
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
        url: '/discover?sort=hot',
      },
      global: { stubs: { NuxtLink: nuxtLinkStub } },
    })

    expect(wrapper.text()).toContain('会员季精选内容')
    expect(wrapper.find('a').attributes('href')).toBe('/discover?sort=hot')
    expect(wrapper.find('a').attributes('target')).toBeUndefined()
  })

  it('https 外链使用新窗口和安全 rel', () => {
    const wrapper = mount(HomeAdBand, {
      props: {
        enabled: true,
        title: '赞助推荐',
        url: 'https://example.com/campaign',
      },
      global: { stubs: { NuxtLink: nuxtLinkStub } },
    })

    const link = wrapper.find('a')
    expect(link.attributes('href')).toBe('https://example.com/campaign')
    expect(link.attributes('target')).toBe('_blank')
    expect(link.attributes('rel')).toBe('noopener noreferrer')
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
})
