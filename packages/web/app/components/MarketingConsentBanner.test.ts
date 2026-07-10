import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import MarketingConsentBanner from './MarketingConsentBanner.vue'

describe('MarketingConsentBanner', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('默认显示同意和仅必要功能入口，并分别更新授权状态', async () => {
    const state = ref<'limited' | 'granted' | 'denied'>('limited')
    const grant = vi.fn(() => { state.value = 'granted' })
    const deny = vi.fn(() => { state.value = 'denied' })
    vi.stubGlobal('useMarketingConsent', () => ({ state, grant, deny }))

    const wrapper = mount(MarketingConsentBanner)
    const buttons = wrapper.findAll('button')

    expect(wrapper.text()).toContain('同意营销追踪')
    expect(wrapper.text()).toContain('仅必要功能')

    await buttons[0]?.trigger('click')
    expect(grant).toHaveBeenCalledTimes(1)

    state.value = 'limited'
    await buttons[1]?.trigger('click')
    expect(deny).toHaveBeenCalledTimes(1)
  })

  it.each(['granted', 'denied'] as const)('已有 %s 选择时不显示', (consent) => {
    vi.stubGlobal('useMarketingConsent', () => ({
      state: ref(consent),
      grant: vi.fn(),
      deny: vi.fn(),
    }))

    const wrapper = mount(MarketingConsentBanner)

    expect(wrapper.find('section').exists()).toBe(false)
  })
})
