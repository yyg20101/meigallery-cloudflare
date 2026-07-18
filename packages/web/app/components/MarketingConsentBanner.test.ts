import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import MarketingConsentBanner from './MarketingConsentBanner.vue'

describe('MarketingConsentBanner', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('严格地区显示用途清晰且选择对等的授权条', async () => {
    const consent = consentState('limited', 'choice_required', true)
    vi.stubGlobal('useMarketingConsent', () => consent)
    const wrapper = mountComponent()

    expect(wrapper.text()).toContain('帮助我们减少无关推广')
    expect(wrapper.text()).toContain('不会读取聊天内容、密码或联系人内容')
    expect(wrapper.text()).toContain('允许效果分析')
    expect(wrapper.text()).toContain('仅使用必要功能')

    const choices = wrapper.findAll('[data-consent-choice]')
    expect(choices).toHaveLength(2)
    expect(choices[0]?.classes()).toEqual(choices[1]?.classes())

    await wrapper.findAll('button')[0]?.trigger('click')
    expect(consent.grant).toHaveBeenCalledTimes(1)
  })

  it('非严格地区默认启用时不显示全局说明或设置控件', () => {
    const consent = consentState('granted', 'regional_default', false)
    vi.stubGlobal('useMarketingConsent', () => consent)
    const wrapper = mountComponent()

    expect(wrapper.find('[aria-label="营销效果分析选择"]').exists()).toBe(false)
    expect(wrapper.html()).toBe('<!--v-if-->')
  })

  it('明确拒绝后不重复显示全局控件', () => {
    const consent = consentState('denied', 'explicit', false)
    vi.stubGlobal('useMarketingConsent', () => consent)
    const wrapper = mountComponent()

    expect(wrapper.find('[aria-label="营销效果分析选择"]').exists()).toBe(false)
    expect(wrapper.html()).toBe('<!--v-if-->')
  })

  it('GPC 关闭效果分析时不显示全局控件', () => {
    const consent = consentState('denied', 'gpc', false)
    vi.stubGlobal('useMarketingConsent', () => consent)
    const wrapper = mountComponent()

    expect(wrapper.find('[aria-label="营销效果分析选择"]').exists()).toBe(false)
    expect(wrapper.html()).toBe('<!--v-if-->')
  })

  it('说明页不重复显示全局控件', () => {
    vi.stubGlobal('useMarketingConsent', () => consentState('limited', 'choice_required', true))
    vi.stubGlobal('useRoute', () => ({ path: '/marketing-tracking' }))
    const wrapper = mount(MarketingConsentBanner, {
      global: { stubs: { NuxtLink: true, UIcon: true } },
    })

    expect(wrapper.find('[aria-label="营销效果分析选择"]').exists()).toBe(false)
    expect(wrapper.html()).toBe('<!--v-if-->')
  })
})

function consentState(
  initial: 'limited' | 'granted' | 'denied',
  source: 'explicit' | 'regional_default' | 'choice_required' | 'gpc',
  choiceRequired: boolean,
) {
  const state = ref(initial)
  const grant = vi.fn(() => { state.value = 'granted' })
  const deny = vi.fn(() => { state.value = 'denied' })
  return {
    state,
    pending: ref(false),
    decisionSource: ref(source),
    requiresChoice: ref(choiceRequired),
    grant,
    deny,
  }
}

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
