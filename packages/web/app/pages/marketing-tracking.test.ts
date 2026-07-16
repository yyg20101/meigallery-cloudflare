import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import MarketingTrackingPage from './marketing-tracking.vue'

describe('隐私设置页', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('只展示面向访客的隐私说明，不泄露归因平台或实现细节', () => {
    vi.stubGlobal('definePageMeta', vi.fn())
    vi.stubGlobal('useSeoMeta', vi.fn())
    vi.stubGlobal('useSiteSettings', () => ({ siteName: ref('MeiGallery') }))
    vi.stubGlobal('useMarketingConsent', () => ({
      state: ref('limited'),
      pending: ref(false),
      decisionSource: ref('choice_required'),
      requiresChoice: ref(true),
      grant: vi.fn(),
      deny: vi.fn(),
    }))

    const wrapper = mount(MarketingTrackingPage)
    const text = wrapper.text()

    expect(text).toContain('数据与隐私')
    expect(text).toContain('必要功能')
    expect(text).toContain('效果分析')
    expect(text).toContain('我们如何保护信息')
    expect(text).toContain('受托的分析与推广服务提供方')
    expect(text).toContain('不会读取聊天内容、密码、通讯录、联系人内容或受保护媒体内容')
    expect(text).toContain('无论如何选择，都不会影响你浏览网站、注册账号或使用联系方式')
    expect(text).not.toMatch(/Meta|TikTok|Google|Pixel|Server API|PageView|Contact|CompleteRegistration/)

    const choices = wrapper.findAll('[data-privacy-choice]')
    expect(choices).toHaveLength(2)
    expect(choices[0]?.classes()).toEqual(choices[1]?.classes())
  })
})
