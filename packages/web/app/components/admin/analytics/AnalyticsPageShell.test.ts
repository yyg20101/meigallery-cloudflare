import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import AnalyticsPageShell from './AnalyticsPageShell.vue'

vi.stubGlobal('useRoute', () => ({ path: '/admin/analytics' }))
vi.stubGlobal('formatAnalyticsNumber', (value: unknown) => String(value ?? 0))

const nuxtLinkStub = {
  props: ['to'],
  template: '<a :href="to"><slot /></a>',
}

describe('AnalyticsPageShell', () => {
  it('切换日期范围时发出 update 事件', async () => {
    const wrapper = mount(AnalyticsPageShell, {
      props: {
        title: '数据分析',
        range: '30d',
      },
      global: { stubs: { NuxtLink: nuxtLinkStub } },
    })

    await wrapper.findAll('button').find(button => button.text() === '7 天')!.trigger('click')

    expect(wrapper.emitted('update:range')?.[0]).toEqual(['7d'])
  })

  it('单日范围显示日期选择器并发出 update 事件', async () => {
    const wrapper = mount(AnalyticsPageShell, {
      props: {
        title: '数据分析',
        range: 'day',
        date: '2026-06-07',
      },
      global: { stubs: { NuxtLink: nuxtLinkStub } },
    })

    const input = wrapper.get('input[type="date"]')
    expect((input.element as HTMLInputElement).value).toBe('2026-06-07')

    await input.setValue('2026-06-08')

    expect(wrapper.emitted('update:date')?.[0]).toEqual(['2026-06-08'])
  })

  it('非 owner 不显示导出按钮，错误信息可见', () => {
    const wrapper = mount(AnalyticsPageShell, {
      props: {
        title: '数据分析',
        range: '30d',
        showExport: false,
        error: '分析数据加载失败',
      },
      global: { stubs: { NuxtLink: nuxtLinkStub } },
    })

    expect(wrapper.text()).not.toContain('导出 CSV')
    expect(wrapper.text()).toContain('分析数据加载失败')
  })

  it('owner 可以看到导出按钮', () => {
    const wrapper = mount(AnalyticsPageShell, {
      props: {
        title: '数据分析',
        range: '30d',
        showExport: true,
      },
      global: { stubs: { NuxtLink: nuxtLinkStub } },
    })

    expect(wrapper.text()).toContain('导出 CSV')
  })
})
