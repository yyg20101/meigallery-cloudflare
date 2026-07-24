import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useMarketingConsent } from './useMarketingConsent'

const stateStore = new Map<string, ReturnType<typeof ref>>()
const fetchMock = vi.fn()

beforeEach(() => {
  stateStore.clear()
  fetchMock.mockReset()
  vi.stubGlobal('useState', <T>(key: string, init: () => T) => {
    if (!stateStore.has(key)) stateStore.set(key, ref(init()))
    return stateStore.get(key)
  })
  vi.stubGlobal('useRuntimeConfig', () => ({
    public: { attributionBaseUrl: 'https://track.example.com' },
  }))
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('useSiteSettings', () => { throw new Error('营销授权禁止读取公开广告连接') })
})

afterEach(() => vi.unstubAllGlobals())

describe('useMarketingConsent', () => {
  it('不创建可读授权 cookie，并从服务端 receipt 状态初始化', async () => {
    const useCookie = vi.fn()
    vi.stubGlobal('useCookie', useCookie)
    fetchMock.mockResolvedValueOnce(response({
      state: 'granted',
      reason: 'regional_default',
      policyMode: 'notice_opt_out',
      requiresChoice: false,
      policyVersion: 3,
    }))
    const consent = useMarketingConsent()

    await consent.refresh()

    expect(fetchMock).toHaveBeenCalledWith(
      'https://track.example.com/v1/privacy-decision',
      expect.objectContaining({ credentials: 'include', method: 'GET' }),
    )
    expect(consent.state.value).toBe('granted')
    expect(consent.policyMode.value).toBe('notice_opt_out')
    expect(consent.decisionSource.value).toBe('regional_default')
    expect(consent.policyVersion.value).toBe(3)
    expect(useCookie).not.toHaveBeenCalled()
  })

  it('授权和撤销只在服务端成功后更新浏览器 Pixel 语义', async () => {
    const consent = useMarketingConsent()
    fetchMock.mockResolvedValueOnce(response({
      state: 'granted',
      reason: 'explicit',
      policyMode: 'prior_consent',
      requiresChoice: false,
      policyVersion: 2,
    }))
    await consent.grant()
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://track.example.com/v1/privacy-decision',
      expect.objectContaining({
        method: 'PUT',
        credentials: 'include',
      }),
    )
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body)).toMatchObject({
      choice: 'granted',
    })
    expect(consent.canTrackMarketing.value).toBe(true)

    fetchMock.mockResolvedValueOnce(response({
      state: 'denied',
      reason: 'explicit',
      policyMode: 'notice_opt_out',
      requiresChoice: false,
      policyVersion: 2,
    }))
    await consent.deny()
    expect(consent.state.value).toBe('denied')
    expect(consent.canTrackMarketing.value).toBe(false)
  })

  it('服务端拒绝授权时保持 limited，不能乐观加载 Pixel', async () => {
    const consent = useMarketingConsent()
    fetchMock.mockRejectedValueOnce(new Error('network'))

    await expect(consent.grant()).rejects.toThrow('network')
    expect(consent.state.value).toBe('limited')
    expect(consent.canTrackMarketing.value).toBe(false)
  })

  it('严格地区只在服务端明确要求时显示选择并保持 Pixel 关闭', async () => {
    fetchMock.mockResolvedValueOnce(response({
      state: 'choice_required',
      reason: 'prior_consent_region',
      policyMode: 'prior_consent',
      requiresChoice: true,
      policyVersion: 4,
    }))
    const consent = useMarketingConsent()

    await consent.refresh()

    expect(consent.requiresChoice.value).toBe(true)
    expect(consent.canTrackMarketing.value).toBe(false)
  })

  it('历史 granted 后 refresh 失败时先强制降级 limited 再抛错', async () => {
    const consent = useMarketingConsent()
    fetchMock.mockResolvedValueOnce(response({
      state: 'granted',
      reason: 'regional_default',
      policyMode: 'notice_opt_out',
      requiresChoice: false,
      policyVersion: 3,
    }))
    await consent.refresh()
    expect(consent.state.value).toBe('granted')

    fetchMock.mockRejectedValueOnce(new Error('refresh failed'))
    await expect(consent.refresh()).rejects.toThrow('refresh failed')
    expect(consent.state.value).toBe('limited')
    expect(consent.canTrackMarketing.value).toBe(false)
    expect(consent.policyMode.value).toBe('prior_consent')
    expect(consent.decisionSource.value).toBe('choice_required')
    expect(consent.requiresChoice.value).toBe(false)
    expect(consent.policyVersion.value).toBe(0)
  })
})

function response(data: Record<string, unknown>) {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}
