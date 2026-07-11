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

function mountStatus(environment: 'dev' | 'production', api = vi.fn()) {
  vi.stubGlobal('useApi', () => ({ api }))
  vi.stubGlobal('useTracking', () => ({ sendMetaLiveChallenge: vi.fn(() => true) }))
  vi.stubGlobal('resolveApiErrorMessage', (error: { data?: { message?: string } }, fallback: string) => error?.data?.message || fallback)
  return mount(MetaConnectionStatus, {
    props: { connection: connection(environment), isOwner: true },
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('MetaConnectionStatus', () => {
  it('production Owner 可见验证按钮并直接调用受后端门禁保护的 Test Event', async () => {
    const api = vi.fn().mockResolvedValue({ data: { status: 'verified', eventsReceived: 1 } })
    const wrapper = mountStatus('production', api)
    await wrapper.get('[data-meta-connection-verify]').trigger('click')

    await vi.waitFor(() => expect(api).toHaveBeenCalledWith('/api/admin/attribution/meta/test-event', { method: 'POST' }))
    expect(wrapper.get('[role="status"]').text()).toBe('MetaConnection 验证成功')
  })

  it('production Test Event 的后端 blocker 原文直接展示', async () => {
    const api = vi.fn().mockRejectedValue({ data: { message: 'production 资源验证尚未通过' } })
    const wrapper = mountStatus('production', api)
    await wrapper.get('[data-meta-connection-verify]').trigger('click')

    await vi.waitFor(() => expect(wrapper.get('[role="status"]').text()).toBe('production 资源验证尚未通过'))
  })
})
