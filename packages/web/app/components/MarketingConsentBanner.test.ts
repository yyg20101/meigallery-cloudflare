import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import MarketingConsentBanner from './MarketingConsentBanner.vue'

describe('MarketingConsentBanner', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('首次访问显示精简选择和说明入口', async () => {
    const state = ref<'limited' | 'granted' | 'denied'>('limited')
    const grant = vi.fn(() => { state.value = 'granted' })
    const deny = vi.fn(() => { state.value = 'denied' })
    vi.stubGlobal('useMarketingConsent', () => ({ state, pending: ref(false), grant, deny }))

    const wrapper = mountComponent()
    const buttons = wrapper.findAll('button')

    expect(wrapper.text()).toContain('允许营销追踪，用于衡量并优化广告效果。可随时更改。')
    expect(wrapper.text()).toContain('了解详情')
    expect(wrapper.text()).toContain('仅必要功能')

    await buttons[0]?.trigger('click')
    expect(grant).toHaveBeenCalledTimes(1)

    state.value = 'limited'
    await buttons[1]?.trigger('click')
    expect(deny).toHaveBeenCalledTimes(1)
  })

  it('首次保存失败时在授权条内显示错误', async () => {
    const state = ref<'limited' | 'granted' | 'denied'>('limited')
    vi.stubGlobal('useMarketingConsent', () => ({
      state,
      pending: ref(false),
      grant: vi.fn().mockRejectedValue(new Error('unavailable')),
      deny: vi.fn(),
    }))

    const wrapper = mountComponent()
    await wrapper.findAll('button')[0]?.trigger('click')

    expect(wrapper.get('[role="alert"]').text()).toBe('保存失败，请稍后重试。')
  })

  it.each(['granted', 'denied'] as const)('已有 %s 选择时收起为可重新打开的设置入口', async (consent) => {
    const state = ref<'limited' | 'granted' | 'denied'>(consent)
    const grant = vi.fn(() => { state.value = 'granted' })
    const deny = vi.fn(() => { state.value = 'denied' })
    vi.stubGlobal('useMarketingConsent', () => ({ state, pending: ref(false), grant, deny }))

    const wrapper = mountComponent()
    expect(wrapper.find('[aria-label="营销追踪授权"]').exists()).toBe(false)

    await wrapper.get('[aria-label="打开营销追踪设置"]').trigger('click')
    expect(wrapper.get('[role="dialog"]').text()).toContain(consent === 'granted' ? '已允许营销追踪' : '仅使用必要功能')

    const choiceButtons = wrapper.get('[role="dialog"]').findAll('button')
    await choiceButtons[2]?.trigger('click')
    expect(deny).toHaveBeenCalledTimes(1)
  })

  it('营销追踪说明页使用正文内控件，不重复显示全局授权条', () => {
    vi.stubGlobal('useMarketingConsent', () => ({
      state: ref('limited'),
      pending: ref(false),
      grant: vi.fn(),
      deny: vi.fn(),
    }))
    vi.stubGlobal('useRoute', () => ({ path: '/marketing-tracking' }))

    const wrapper = mount(MarketingConsentBanner, {
      global: { stubs: { NuxtLink: true, UIcon: true } },
    })

    expect(wrapper.find('[aria-label="营销追踪授权"]').exists()).toBe(false)
    expect(wrapper.find('[aria-label="打开营销追踪设置"]').exists()).toBe(false)
  })
})

function mountComponent() {
  vi.stubGlobal('useRoute', () => ({ path: '/' }))
  return mount(MarketingConsentBanner, {
    global: {
      stubs: {
        NuxtLink: { template: '<a><slot /></a>' },
        UIcon: { template: '<span />' },
      },
    },
  })
}
