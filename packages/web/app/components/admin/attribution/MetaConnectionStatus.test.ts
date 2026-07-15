import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MetaConnectionStatusData } from '~/composables/useAdminAttribution'
import MetaConnectionStatus from './MetaConnectionStatus.vue'

function connection(environment: 'dev' | 'production'): MetaConnectionStatusData {
  return {
    state: 'unverified', environment,
    pixelIdConfigured: true, tokenConfigured: true,
    verifiedAt: null, verifiedCommit: null, graphApiVersion: 'v25.0',
    datasetQualityStatus: 'not_checked', invalidationReason: 'verification_missing',
  }
}

function mountStatus(environment: 'dev' | 'production', api = vi.fn()) {
  vi.stubGlobal('useApi', () => ({ api }))
  vi.stubGlobal('useTracking', () => { throw new Error('旧 Meta live 浏览器入口必须删除') })
  vi.stubGlobal('resolveApiErrorMessage', (error: { data?: { message?: string } }, fallback: string) => error?.data?.message || fallback)
  return mount(MetaConnectionStatus, {
    props: { connection: connection(environment), isOwner: true },
  })
}

async function enterTestEventCode(wrapper: ReturnType<typeof mountStatus>, value = ' test25401 ') {
  await wrapper.get('[data-meta-test-event-code]').setValue(value)
}

afterEach(() => vi.unstubAllGlobals())

describe('MetaConnectionStatus', () => {
  it('程序化重复调用 verifyConnection 时 busy guard 只允许一个请求', async () => {
    let release!: () => void
    const pending = new Promise(resolve => { release = () => resolve({ data: { status: 'verified', eventsReceived: 1 } }) })
    const api = vi.fn(() => pending)
    const wrapper = mountStatus('production', api)
    await enterTestEventCode(wrapper)
    const verifyConnection = (wrapper.vm as unknown as { verifyConnection: () => Promise<void> }).verifyConnection

    const first = verifyConnection()
    const second = verifyConnection()
    expect(api).toHaveBeenCalledOnce()
    release()
    await Promise.all([first, second])
  })

  it('dev 验证连接与 production 一样只建立 MetaConnection revision', async () => {
    const api = vi.fn().mockResolvedValue({ data: { status: 'verified', eventsReceived: 1 } })
    const wrapper = mountStatus('dev', api)
    await enterTestEventCode(wrapper)

    await wrapper.get('[data-meta-connection-verify]').trigger('click')

    await vi.waitFor(() => expect(api).toHaveBeenCalledWith('/api/admin/attribution/meta/test-event', {
      method: 'POST',
      body: { testEventCode: 'TEST25401' },
    }))
    expect(api).not.toHaveBeenCalledWith('/api/admin/attribution/meta/live-challenge', expect.anything())
    expect(wrapper.get('[role="status"]').text()).toBe('MetaConnection 验证成功')
  })

  it('production 不保留旧 Meta live 浏览器 challenge 入口', () => {
    const wrapper = mountStatus('production')

    expect(wrapper.find('[data-meta-live-evidence]').exists()).toBe(false)
  })

  it('production Owner 可见验证按钮并直接调用受后端门禁保护的 Test Event', async () => {
    const api = vi.fn().mockResolvedValue({ data: { status: 'verified', eventsReceived: 1 } })
    const wrapper = mountStatus('production', api)
    await enterTestEventCode(wrapper)
    await wrapper.get('[data-meta-connection-verify]').trigger('click')

    await vi.waitFor(() => expect(api).toHaveBeenCalledWith('/api/admin/attribution/meta/test-event', {
      method: 'POST',
      body: { testEventCode: 'TEST25401' },
    }))
    expect(wrapper.get('[role="status"]').text()).toBe('MetaConnection 验证成功')
    expect(wrapper.find('[data-meta-live-evidence]').exists()).toBe(false)
  })

  it('production Test Event 的后端 blocker 原文直接展示', async () => {
    const api = vi.fn().mockRejectedValue({ data: { message: 'production 资源验证尚未通过' } })
    const wrapper = mountStatus('production', api)
    await enterTestEventCode(wrapper)
    await wrapper.get('[data-meta-connection-verify]').trigger('click')

    await vi.waitFor(() => expect(wrapper.get('[role="status"]').text()).toBe('production 资源验证尚未通过'))
  })

  it('Test Event Code 未填写或格式非法时禁用验证操作，失焦后统一大写', async () => {
    const wrapper = mountStatus('production')
    const verify = wrapper.get('[data-meta-connection-verify]')

    expect(verify.attributes('disabled')).toBeDefined()
    await enterTestEventCode(wrapper, ' test25401 ')
    await wrapper.get('[data-meta-test-event-code]').trigger('blur')
    expect((wrapper.get('[data-meta-test-event-code]').element as HTMLInputElement).value).toBe('TEST25401')
    expect(verify.attributes('disabled')).toBeUndefined()
  })
})
