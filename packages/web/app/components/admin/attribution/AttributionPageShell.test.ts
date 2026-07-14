import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import AttributionPageShell from './AttributionPageShell.vue'

vi.stubGlobal('useRoute', () => ({ path: '/admin/attribution', query: { provider: 'meta' } }))
vi.stubGlobal('formatAnalyticsNumber', (value: unknown) => String(value ?? 0))

const nuxtLinkStub = defineComponent({
  props: ['to'],
  computed: {
    encodedTo() {
      return JSON.stringify(this.to)
    },
  },
  template: '<a :data-to="encodedTo"><slot /></a>',
})

describe('AttributionPageShell', () => {
  it('单日范围显示归因日期输入', () => {
    const wrapper = mount(AttributionPageShell, {
      props: {
        title: '归因中心',
        range: 'day',
        date: '2026-07-09',
      },
      global: { stubs: { NuxtLink: nuxtLinkStub } },
    })

    const input = wrapper.get('input[type="date"]')
    expect(input.attributes('aria-label')).toBe('选择归因日期')
    expect((input.element as HTMLInputElement).value).toBe('2026-07-09')
  })

  it('展示平台接入和发布诊断标签', () => {
    const wrapper = mount(AttributionPageShell, {
      props: {
        title: '归因中心',
        range: '30d',
      },
      global: { stubs: { NuxtLink: nuxtLinkStub } },
    })

    expect(wrapper.text()).toContain('投放链接')
    expect(wrapper.text()).toContain('平台接入')
    expect(wrapper.text()).toContain('发布与诊断')
    expect(wrapper.text()).not.toContain('Meta 运维')
    expect(wrapper.text()).not.toContain('重复诊断')
  })

  it('标签链接携带当前归因日期口径', () => {
    const wrapper = mount(AttributionPageShell, {
      props: {
        title: '归因中心',
        range: 'day',
        date: '2026-07-09',
      },
      global: { stubs: { NuxtLink: nuxtLinkStub } },
    })

    const link = wrapper.findAll('a').find(item => item.text() === '投放链接')
    expect(link?.attributes('data-to')).toBe(JSON.stringify({
      path: '/admin/attribution/links',
      query: { range: 'day', date: '2026-07-09', provider: 'meta' },
    }))
  })
})
