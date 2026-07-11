import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MetaConnectionStatusData } from '~/composables/useAdminAttribution'
import MetaConnectionStatus from './MetaConnectionStatus.vue'

function connection(environment: 'dev' | 'production'): MetaConnectionStatusData {
  return {
    state: 'unverified', environment,
    pixelIdConfigured: true, tokenConfigured: true, testEventCodeConfigured: true,
    verifiedAt: null, verifiedCommit: null, graphApiVersion: 'v25.0',
    datasetQualityStatus: 'not_checked', invalidationReason: 'verification_missing',
  }
}

function mountStatus(environment: 'dev' | 'production', api = vi.fn(), sendMetaLiveChallenge = vi.fn(() => true)) {
  vi.stubGlobal('useApi', () => ({ api }))
  vi.stubGlobal('useTracking', () => ({ sendMetaLiveChallenge }))
  vi.stubGlobal('resolveApiErrorMessage', (error: { data?: { message?: string } }, fallback: string) => error?.data?.message || fallback)
  return mount(MetaConnectionStatus, {
    props: { connection: connection(environment), isOwner: true },
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('MetaConnectionStatus', () => {
  it('dev 验证连接与 production 一样只建立 MetaConnection revision', async () => {
    const api = vi.fn().mockResolvedValue({ data: { status: 'verified', eventsReceived: 1 } })
    const sendMetaLiveChallenge = vi.fn(() => true)
    const wrapper = mountStatus('dev', api, sendMetaLiveChallenge)

    await wrapper.get('[data-meta-connection-verify]').trigger('click')

    await vi.waitFor(() => expect(api).toHaveBeenCalledWith('/api/admin/attribution/meta/test-event', { method: 'POST' }))
    expect(api).not.toHaveBeenCalledWith('/api/admin/attribution/meta/live-challenge', expect.anything())
    expect(sendMetaLiveChallenge).not.toHaveBeenCalled()
    expect(wrapper.get('[role="status"]').text()).toBe('MetaConnection 验证成功')
  })

  it('dev 单独显示 Live Evidence 按钮并执行两事件 challenge', async () => {
    const challenge = {
      data: {
        challengeId: 'challenge_1',
        pixelId: '1234567890',
        eventIds: { Contact: `mlv_contact_${'1'.repeat(32)}`, CompleteRegistration: `mlv_registration_${'2'.repeat(32)}` },
      },
    }
    const api = vi.fn()
      .mockResolvedValueOnce(challenge)
      .mockResolvedValueOnce({ data: { status: 'server_sent', eventsReceived: 2 } })
    const sendMetaLiveChallenge = vi.fn(() => true)
    const wrapper = mountStatus('dev', api, sendMetaLiveChallenge)

    await wrapper.get('[data-meta-live-evidence]').trigger('click')

    await vi.waitFor(() => expect(api).toHaveBeenNthCalledWith(1, '/api/admin/attribution/meta/live-challenge', { method: 'POST' }))
    expect(sendMetaLiveChallenge).toHaveBeenCalledWith(challenge.data)
    expect(api).toHaveBeenNthCalledWith(2, '/api/admin/attribution/meta/live-challenge/consume', {
      method: 'POST',
      body: { challengeId: 'challenge_1' },
    })
    expect(wrapper.get('[role="status"]').text()).toContain('Browser 与 Server 测试事件已发送')
  })

  it('production Owner 可见验证按钮并直接调用受后端门禁保护的 Test Event', async () => {
    const api = vi.fn().mockResolvedValue({ data: { status: 'verified', eventsReceived: 1 } })
    const wrapper = mountStatus('production', api)
    await wrapper.get('[data-meta-connection-verify]').trigger('click')

    await vi.waitFor(() => expect(api).toHaveBeenCalledWith('/api/admin/attribution/meta/test-event', { method: 'POST' }))
    expect(wrapper.get('[role="status"]').text()).toBe('MetaConnection 验证成功')
    expect(wrapper.find('[data-meta-live-evidence]').exists()).toBe(false)
  })

  it('production Test Event 的后端 blocker 原文直接展示', async () => {
    const api = vi.fn().mockRejectedValue({ data: { message: 'production 资源验证尚未通过' } })
    const wrapper = mountStatus('production', api)
    await wrapper.get('[data-meta-connection-verify]').trigger('click')

    await vi.waitFor(() => expect(wrapper.get('[role="status"]').text()).toBe('production 资源验证尚未通过'))
  })
})
