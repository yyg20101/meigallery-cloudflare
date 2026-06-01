import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import MembershipBadge from './MembershipBadge.vue'

describe('MembershipBadge', () => {
  it('free rank 不渲染徽章', () => {
    const wrapper = mount(MembershipBadge, {
      props: { rank: 0 },
    })

    expect(wrapper.text()).toBe('')
    expect(wrapper.find('span').exists()).toBe(false)
  })

  it('VIP rank 渲染 VIP 文案和样式', () => {
    const wrapper = mount(MembershipBadge, {
      props: { rank: 10 },
    })

    expect(wrapper.text()).toBe('VIP')
    expect(wrapper.classes()).toContain('bg-amber-500')
  })

  it('SVIP rank 渲染 SVIP 文案和样式', () => {
    const wrapper = mount(MembershipBadge, {
      props: { rank: 20 },
    })

    expect(wrapper.text()).toBe('SVIP')
    expect(wrapper.classes()).toContain('bg-violet-600')
  })
})
