import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import MediaLock from './MediaLock.vue'

const nuxtLinkStub = {
  props: ['to'],
  template: '<a :href="to"><slot /></a>',
}

describe('MediaLock', () => {
  it('按 requiredRank 显示会员等级名称', () => {
    expect(mount(MediaLock, {
      props: { requiredRank: 10 },
      global: { stubs: { NuxtLink: nuxtLinkStub } },
    }).text()).toContain('需要 VIP 会员')

    expect(mount(MediaLock, {
      props: { requiredRank: 20 },
      global: { stubs: { NuxtLink: nuxtLinkStub } },
    }).text()).toContain('需要 SVIP 会员')
  })

  it('免费 rank 回退显示会员文案并渲染提示消息', () => {
    const wrapper = mount(MediaLock, {
      props: { requiredRank: 0, message: '升级后可查看完整内容' },
      global: { stubs: { NuxtLink: nuxtLinkStub } },
    })

    expect(wrapper.text()).toContain('需要 会员')
    expect(wrapper.text()).toContain('升级后可查看完整内容')
  })

  it('渲染预览 slot 和会员权益入口', () => {
    const wrapper = mount(MediaLock, {
      props: { requiredRank: 10 },
      slots: {
        preview: '<span class="preview-item">预览图</span>',
      },
      global: { stubs: { NuxtLink: nuxtLinkStub } },
    })

    expect(wrapper.find('.preview-item').exists()).toBe(true)
    expect(wrapper.find('a').attributes('href')).toBe('/user')
    expect(wrapper.find('a').text()).toBe('了解会员权益')
  })
})
