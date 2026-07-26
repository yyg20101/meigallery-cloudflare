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

  it('展示统一归因后台六个标签', () => {
    const wrapper = mount(AttributionPageShell, {
      props: {
        title: '归因中心',
        range: '30d',
      },
      global: { stubs: { NuxtLink: nuxtLinkStub } },
    })

    for (const label of ['总览', '平台连接', '事件绑定', '投递质量', '连接诊断', '审计日志']) {
      expect(wrapper.text()).toContain(label)
    }
    expect(wrapper.text()).not.toContain('投放链接')
    expect(wrapper.text()).not.toContain('发布与诊断')
    expect(wrapper.text()).not.toContain('Meta 运维')
    expect(wrapper.text()).not.toContain('重复诊断')
  })

  it('只在需要范围和平台上下文的标签保留对应 query', () => {
    const wrapper = mount(AttributionPageShell, {
      props: {
        title: '归因中心',
        range: 'day',
        date: '2026-07-09',
      },
      global: { stubs: { NuxtLink: nuxtLinkStub } },
    })

    const delivery = wrapper.findAll('a').find(item => item.text() === '投递质量')
    expect(delivery?.attributes('data-to')).toBe(JSON.stringify({
      path: '/admin/attribution/deliveries',
      query: { range: 'day', date: '2026-07-09', provider: 'meta' },
    }))
    const platform = wrapper.findAll('a').find(item => item.text() === '平台连接')
    expect(platform?.attributes('data-to')).toBe(JSON.stringify({
      path: '/admin/attribution/platforms',
      query: { provider: 'meta' },
    }))
    const audit = wrapper.findAll('a').find(item => item.text() === '审计日志')
    expect(audit?.attributes('data-to')).toBe(JSON.stringify({
      path: '/admin/attribution/audit',
      query: { range: 'day', date: '2026-07-09' },
    }))
  })
})
