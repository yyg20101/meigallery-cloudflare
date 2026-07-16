import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import MarketingConsentBanner from './MarketingConsentBanner.vue'

describe('MarketingConsentBanner', () => {
  beforeEach(() => window.localStorage.clear())
  afterEach(() => vi.unstubAllGlobals())

  it('严格地区显示用途清晰且选择对等的授权条', async () => {
    const consent = consentState('limited', 'choice_required', true)
    vi.stubGlobal('useMarketingConsent', () => consent)
    const wrapper = mountComponent()

    expect(wrapper.text()).toContain('帮助我们减少无关推广')
    expect(wrapper.text()).toContain('不会读取聊天内容、密码或联系人内容')
    expect(wrapper.text()).toContain('允许效果分析')
    expect(wrapper.text()).toContain('暂不使用')

    await wrapper.findAll('button')[0]?.trigger('click')
    expect(consent.grant).toHaveBeenCalledTimes(1)
  })

  it('非严格地区显示一次告知但不阻断效果分析', async () => {
    const consent = consentState('granted', 'regional_default', false)
    vi.stubGlobal('useMarketingConsent', () => consent)
    const wrapper = mountComponent()

    expect(wrapper.get('[aria-label="营销效果分析说明"]').text()).toContain('减少无关推广')
    expect(wrapper.find('[aria-label="营销效果分析选择"]').exists()).toBe(false)

    await wrapper.get('[aria-label="关闭效果分析说明"]').trigger('click')
    expect(window.localStorage.getItem('mei_marketing_notice_dismissed_v1')).toBe('1')
    expect(wrapper.find('[aria-label="打开效果分析设置"]').exists()).toBe(true)
  })

  it('明确选择后收起为可重新打开的设置入口', async () => {
    const consent = consentState('denied', 'explicit', false)
    vi.stubGlobal('useMarketingConsent', () => consent)
    const wrapper = mountComponent()

    await wrapper.get('[aria-label="打开效果分析设置"]').trigger('click')
    expect(wrapper.get('[role="dialog"]').text()).toContain('仅使用必要功能')

    const buttons = wrapper.get('[role="dialog"]').findAll('button')
    await buttons[2]?.trigger('click')
    expect(consent.deny).toHaveBeenCalledTimes(1)
  })

  it('GPC 状态明确说明由浏览器隐私偏好关闭', async () => {
    const consent = consentState('denied', 'gpc', false)
    vi.stubGlobal('useMarketingConsent', () => consent)
    const wrapper = mountComponent()

    await wrapper.get('[aria-label="打开效果分析设置"]').trigger('click')
    expect(wrapper.get('[role="dialog"]').text()).toContain('浏览器隐私偏好已关闭效果分析')
  })

  it('说明页不重复显示全局控件', () => {
    vi.stubGlobal('useMarketingConsent', () => consentState('limited', 'choice_required', true))
    vi.stubGlobal('useRoute', () => ({ path: '/marketing-tracking' }))
    const wrapper = mount(MarketingConsentBanner, {
      global: { stubs: { NuxtLink: true, UIcon: true } },
    })

    expect(wrapper.find('[aria-label="营销效果分析选择"]').exists()).toBe(false)
    expect(wrapper.find('[aria-label="打开效果分析设置"]').exists()).toBe(false)
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
