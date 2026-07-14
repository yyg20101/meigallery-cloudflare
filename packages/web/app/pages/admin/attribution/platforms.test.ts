import { flushPromises, shallowMount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computed, defineComponent, ref } from 'vue'
import PlatformsPage from './platforms.vue'

function state(data: unknown) {
  return {
    data: ref(data),
    loading: ref(false),
    error: ref(''),
    usage: ref(null),
    refresh: vi.fn().mockResolvedValue(undefined),
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('归因平台接入页', () => {
  it('TikTok 测试码只进入单次验证请求并在成功后清空', async () => {
    const api = vi.fn().mockResolvedValue({ data: { idempotent: false } })
    const platforms = state([{
      provider: 'tiktok',
      environment: 'production',
      enabled: true,
      browserEnabled: true,
      serverEnabled: true,
      destinationId: 'C123456789ABCDEF',
      debugEnabled: false,
      rolloutPercentage: 10,
      destinationConfigured: true,
      serverCredentialConfigured: true,
      serverQueueConfigured: true,
      serverDataKeyConfigured: true,
      mode: 'test',
      state: 'unverified',
      verifiedAt: '',
      verifiedCommit: '',
    }])
    const metaStatus = state(null)

    vi.stubGlobal('definePageMeta', vi.fn())
    vi.stubGlobal('useAuth', () => ({ isOwner: ref(true) }))
    vi.stubGlobal('useApi', () => ({ api }))
    vi.stubGlobal('useAttributionProvider', () => ref<'meta' | 'tiktok'>('tiktok'))
    vi.stubGlobal('useAdminAttributionRange', () => ({
      range: ref('7d'),
      date: ref('2026-07-14'),
      queryKey: computed(() => '7d'),
    }))
    vi.stubGlobal('useAdminAttribution', (endpoint: string) => endpoint.endsWith('/platforms') ? platforms : metaStatus)

    const editorStub = defineComponent({
      props: ['message'],
      template: '<div data-editor-message>{{ message }}</div>',
    })
    const wrapper = shallowMount(PlatformsPage, {
      global: {
        stubs: {
          AttributionPageShell: { template: '<main><slot /></main>' },
          AttributionPlatformConnectionEditor: editorStub,
          AttributionProviderSwitch: true,
          MetaConnectionStatus: true,
        },
      },
    })
    const input = wrapper.get('input[type="password"]')
    await input.setValue('TEST_TIKTOK_ONCE')
    await wrapper.get('button[type="button"]').trigger('click')
    await flushPromises()

    expect(api).toHaveBeenCalledWith('/api/admin/attribution/platforms/tiktok/verify', {
      method: 'POST',
      body: { testEventCode: 'TEST_TIKTOK_ONCE' },
    })
    expect((input.element as HTMLInputElement).value).toBe('')
    expect(wrapper.get('[data-editor-message]').text()).toBe('TikTok Events API 已验证')
  })
})
