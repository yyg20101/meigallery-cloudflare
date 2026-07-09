import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import RegisterPage from './register.vue'

const register = vi.fn()
const sendCode = vi.fn()
const checkUsername = vi.fn()
const api = vi.fn()
const push = vi.fn()
const replace = vi.fn()
const track = vi.fn()
const trackConversion = vi.fn()

describe('register page', () => {
  beforeEach(() => {
    register.mockReset()
    register.mockResolvedValue({ id: 1 })
    sendCode.mockReset()
    checkUsername.mockReset()
    checkUsername.mockResolvedValue({ available: true })
    api.mockReset()
    api.mockResolvedValue({ email_verification_enabled: false })
    push.mockReset()
    replace.mockReset()
    track.mockReset()
    trackConversion.mockReset()
    trackConversion.mockRejectedValue(new Error('conversion api failed'))

    vi.stubGlobal('useAuth', () => ({
      register,
      sendCode,
      checkUsername,
      isLoggedIn: ref(false),
    }))
    vi.stubGlobal('useApi', () => ({ api }))
    vi.stubGlobal('useRouter', () => ({ push, replace }))
    vi.stubGlobal('useRoute', () => ({ fullPath: '/register', query: {} }))
    vi.stubGlobal('useAnalytics', () => ({
      track,
      getContext: () => ({
        visitorId: 'visitor_1',
        sessionId: 'session_1',
      }),
    }))
    vi.stubGlobal('useConversionTracking', () => ({ trackConversion }))
    vi.stubGlobal('useSiteSettings', () => ({ siteName: ref('MeiGallery') }))
    vi.stubGlobal('useTurnstile', () => ({
      turnstileToken: ref(''),
      turnstileExpired: ref(false),
      hasTurnstile: ref(false),
      canSubmit: ref(true),
      mountTurnstile: vi.fn().mockResolvedValue(undefined),
      resetTurnstile: vi.fn(),
      cleanupTurnstile: vi.fn(),
    }))
    vi.stubGlobal('useSeoMeta', vi.fn())
    vi.stubGlobal('definePageMeta', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('注册成功后 conversion reject 不触发 register_failed，仍跳转首页', async () => {
    const wrapper = mount(RegisterPage, {
      global: {
        stubs: {
          NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
        },
      },
    })
    await flushPromises()

    await wrapper.get('input[autocomplete="username"]').setValue('meiuser')
    await wrapper.get('input[autocomplete="email"]').setValue('mei@example.com')
    await wrapper.get('input[autocomplete="new-password"]').setValue('password123')
    const confirmPasswordInput = wrapper.findAll('input[autocomplete="new-password"]').at(1)
    expect(confirmPasswordInput).toBeDefined()
    await confirmPasswordInput!.setValue('password123')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(register).toHaveBeenCalled()
    expect(trackConversion).toHaveBeenCalledWith('complete_registration', { metadata: { method: 'email' } })
    expect(push).toHaveBeenCalledWith('/')
    expect(track).not.toHaveBeenCalledWith('register_failed', expect.anything())
  })
})
