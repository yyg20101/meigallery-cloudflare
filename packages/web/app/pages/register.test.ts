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
const executeBrowserInstructions = vi.fn()
const buildRegistrationAttributionContext = vi.fn()

describe('register page', () => {
  beforeEach(() => {
    register.mockReset()
    register.mockResolvedValue({
      id: 1,
      trackingInstructions: [{
        deliveryId: 'delivery_meta_registration',
        provider: 'meta',
        canonicalEvent: 'CompleteRegistration',
        externalEventId: 'mg3_registration_1',
        receiptToken: `v1.${'a'.repeat(16)}.${'b'.repeat(43)}`,
        descriptor: {
          provider: 'meta',
          canonicalEvent: 'CompleteRegistration',
          browserEventName: 'CompleteRegistration',
          browserDestination: 'meta_pixel',
          serverDestination: 'meta_capi',
        },
        payload: { method: 'email' },
      }],
    })
    sendCode.mockReset()
    checkUsername.mockReset()
    checkUsername.mockResolvedValue({ available: true })
    api.mockReset()
    api.mockResolvedValue({ email_verification_enabled: false })
    push.mockReset()
    replace.mockReset()
    track.mockReset()
    executeBrowserInstructions.mockReset()
    executeBrowserInstructions.mockResolvedValue(undefined)
    buildRegistrationAttributionContext.mockReset()
    buildRegistrationAttributionContext.mockReturnValue({
      visitorId: 'visitor_1',
      sessionId: 'session_1',
      occurredAt: '2026-07-10T08:00:00.000Z',
      routeName: 'register',
      path: '/register',
      sourceChannel: 'ad',
      sourceName: 'meta',
      trackingSourceSlug: 'meta-summer',
      utmSource: 'meta',
      utmMedium: 'paid_social',
      utmCampaign: 'summer',
      utmContent: 'hero',
      consentState: 'granted',
      browserIdentifiers: { fbp: 'fb.1.1700000000000.123456789' },
    })

    vi.stubGlobal('useAuth', () => ({
      register,
      sendCode,
      checkUsername,
      isLoggedIn: ref(false),
    }))
    vi.stubGlobal('useApi', () => ({ api }))
    vi.stubGlobal('useRouter', () => ({ push, replace }))
    vi.stubGlobal('useRoute', () => ({ name: 'register', path: '/register', fullPath: '/register?utm_content=hero', query: { utm_content: 'hero', fbclid: 'click_1' } }))
    vi.stubGlobal('useAnalytics', () => ({
      track,
      getContext: () => ({
        visitorId: 'visitor_1',
        sessionId: 'session_1',
        consentState: 'limited',
        sourceChannel: 'ad',
        sourceContext: {
          sourceName: 'meta',
          trackingSourceSlug: 'meta-summer',
          utmSource: 'meta',
          utmMedium: 'paid_social',
          utmCampaign: 'summer',
        },
      }),
    }))
    vi.stubGlobal('useTracking', () => ({ executeBrowserInstructions, buildRegistrationAttributionContext }))
    vi.stubGlobal('useMarketingConsent', () => ({
      state: ref('granted'),
      canTrackMarketing: ref(true),
    }))
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

  it('注册请求携带脱敏归因且成功后只执行响应中的 Pixel 指令', async () => {
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

    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      attribution: {
        visitorId: 'visitor_1',
        sessionId: 'session_1',
        occurredAt: '2026-07-10T08:00:00.000Z',
        routeName: 'register',
        path: '/register',
        sourceChannel: 'ad',
        sourceName: 'meta',
        trackingSourceSlug: 'meta-summer',
        utmSource: 'meta',
        utmMedium: 'paid_social',
        utmCampaign: 'summer',
        utmContent: 'hero',
        consentState: 'granted',
        browserIdentifiers: { fbp: 'fb.1.1700000000000.123456789' },
      },
    }))
    expect(buildRegistrationAttributionContext).toHaveBeenCalledOnce()
    expect(register.mock.calls[0]?.[0]).not.toHaveProperty('actionType')
    expect(register.mock.calls[0]?.[0]).not.toHaveProperty('userId')
    expect(executeBrowserInstructions).toHaveBeenCalledWith([
      expect.objectContaining({ canonicalEvent: 'CompleteRegistration', externalEventId: 'mg3_registration_1' }),
    ])
    expect(track).toHaveBeenCalledWith('register_success', expect.objectContaining({ eventId: 'mg3_registration_1' }))
    expect(push).toHaveBeenCalledWith('/')
    expect(track).not.toHaveBeenCalledWith('register_failed', expect.anything())
  })

  it('Pixel 指令执行失败不误记注册失败且仍跳转首页', async () => {
    executeBrowserInstructions.mockRejectedValueOnce(new Error('pixel failed'))
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
    await wrapper.findAll('input[autocomplete="new-password"]').at(1)!.setValue('password123')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(push).toHaveBeenCalledWith('/')
    expect(track).not.toHaveBeenCalledWith('register_failed', expect.anything())
  })
})
