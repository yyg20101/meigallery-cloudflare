import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useMarketingConsent } from './useMarketingConsent'

const stateStore = new Map<string, ReturnType<typeof ref>>()
const api = vi.fn()

beforeEach(() => {
  stateStore.clear()
  api.mockReset()
  vi.stubGlobal('useState', <T>(key: string, init: () => T) => {
    if (!stateStore.has(key)) stateStore.set(key, ref(init()))
    return stateStore.get(key)
  })
  vi.stubGlobal('useApi', () => ({ api }))
  vi.stubGlobal('useSiteSettings', () => { throw new Error('营销授权禁止读取公开广告连接') })
})

afterEach(() => vi.unstubAllGlobals())

describe('useMarketingConsent', () => {
  it('不创建可读授权 cookie，并从服务端 receipt 状态初始化', async () => {
    const useCookie = vi.fn()
    vi.stubGlobal('useCookie', useCookie)
    api.mockResolvedValueOnce({ state: 'granted', policyMode: 'notice_opt_out', decisionSource: 'regional_default', requiresChoice: false, policyVersion: 3 })
    const consent = useMarketingConsent()

    await consent.refresh()

    expect(api).toHaveBeenCalledWith('/api/marketing-consent')
    expect(consent.state.value).toBe('granted')
    expect(consent.policyMode.value).toBe('notice_opt_out')
    expect(consent.decisionSource.value).toBe('regional_default')
    expect(consent.policyVersion.value).toBe(3)
    expect(useCookie).not.toHaveBeenCalled()
  })

  it('授权和撤销只在服务端成功后更新浏览器 Pixel 语义', async () => {
    const consent = useMarketingConsent()
    api.mockResolvedValueOnce({ state: 'granted', policyMode: 'prior_consent', decisionSource: 'explicit', requiresChoice: false, policyVersion: 2 })
    await consent.grant()
    expect(api).toHaveBeenNthCalledWith(1, '/api/marketing-consent', {
      method: 'PUT',
      body: { state: 'granted' },
    })
    expect(consent.canTrackMarketing.value).toBe(true)

    api.mockResolvedValueOnce({ state: 'denied', policyMode: 'notice_opt_out', decisionSource: 'explicit', requiresChoice: false, policyVersion: 2 })
    await consent.deny()
    expect(consent.state.value).toBe('denied')
    expect(consent.canTrackMarketing.value).toBe(false)
  })

  it('服务端拒绝授权时保持 limited，不能乐观加载 Pixel', async () => {
    const consent = useMarketingConsent()
    api.mockRejectedValueOnce(new Error('network'))

    await expect(consent.grant()).rejects.toThrow('network')
    expect(consent.state.value).toBe('limited')
    expect(consent.canTrackMarketing.value).toBe(false)
  })

  it('严格地区只在服务端明确要求时显示选择并保持 Pixel 关闭', async () => {
    api.mockResolvedValueOnce({ state: 'limited', policyMode: 'prior_consent', decisionSource: 'choice_required', requiresChoice: true, policyVersion: 4 })
    const consent = useMarketingConsent()

    await consent.refresh()

    expect(consent.requiresChoice.value).toBe(true)
    expect(consent.canTrackMarketing.value).toBe(false)
  })

  it('历史 granted 后 refresh 失败时先强制降级 limited 再抛错', async () => {
    const consent = useMarketingConsent()
    api.mockResolvedValueOnce({ state: 'granted' })
    await consent.refresh()
    expect(consent.state.value).toBe('granted')

    api.mockRejectedValueOnce(new Error('refresh failed'))
    await expect(consent.refresh()).rejects.toThrow('refresh failed')
    expect(consent.state.value).toBe('limited')
    expect(consent.canTrackMarketing.value).toBe(false)
  })
})
