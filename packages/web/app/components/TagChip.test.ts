import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import TagChip from './TagChip.vue'

const nuxtLinkStub = {
  props: ['to'],
  template: '<a :href="to"><slot /></a>',
}

describe('TagChip', () => {
  const tag = { name: '清新', slug: 'fresh', type: 'style' }

  it('默认渲染普通标签文本', () => {
    const wrapper = mount(TagChip, {
      props: { tag },
      global: { stubs: { NuxtLink: nuxtLinkStub } },
    })

    expect(wrapper.text()).toBe('清新')
    expect(wrapper.find('span').exists()).toBe(true)
  })

  it('linkable 时渲染发现页标签链接', () => {
    const wrapper = mount(TagChip, {
      props: { tag, linkable: true },
      global: { stubs: { NuxtLink: nuxtLinkStub } },
    })

    expect(wrapper.find('a').attributes('href')).toBe('/discover?tag=fresh')
    expect(wrapper.find('a').text()).toBe('清新')
  })

  it('removable 时点击按钮发出 remove 事件', async () => {
    const wrapper = mount(TagChip, {
      props: { tag, removable: true },
      global: { stubs: { NuxtLink: nuxtLinkStub } },
    })

    await wrapper.find('button').trigger('click')

    expect(wrapper.emitted('remove')).toHaveLength(1)
  })

  it('selected 和 sm size 使用对应样式', () => {
    const wrapper = mount(TagChip, {
      props: { tag, selected: true, size: 'sm' },
      global: { stubs: { NuxtLink: nuxtLinkStub } },
    })

    const classes = wrapper.find('span').classes()
    expect(classes).toContain('bg-[#111]')
    expect(classes).toContain('px-2.5')
  })
})
