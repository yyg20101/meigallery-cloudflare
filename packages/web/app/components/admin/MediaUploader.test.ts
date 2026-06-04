import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import MediaUploader from './MediaUploader.vue'

function mountUploader() {
  vi.stubGlobal('useApi', () => ({ baseURL: 'https://api.example.com' }))
  vi.stubGlobal('crypto', { randomUUID: () => 'upload-1' })

  return mount(MediaUploader, {
    props: { galleryId: 'gallery-1' },
  })
}

async function selectFiles(wrapper: ReturnType<typeof mountUploader>, files: File[]) {
  const input = wrapper.get('input[type="file"]').element as HTMLInputElement
  Object.defineProperty(input, 'files', {
    configurable: true,
    value: files,
  })
  await wrapper.get('input[type="file"]').trigger('change')
}

describe('MediaUploader', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('上传失败时优先展示统一错误体 message', async () => {
    const message = '媒体 R2 key 与当前图库/媒体不匹配，请先人工核查'
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: vi.fn().mockResolvedValue({ statusCode: 400, message }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mountUploader()
    const file = new File(['image'], 'cover.jpg', { type: 'image/jpeg' })

    await selectFiles(wrapper, [file])
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/api/admin/galleries/gallery-1/media/upload',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
      }),
    )
    expect(wrapper.text()).toContain(message)
    expect(wrapper.emitted('uploaded')).toBeUndefined()
  })

  it('上传失败时兼容历史错误体 error 字段', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: vi.fn().mockResolvedValue({ error: '旧格式上传错误' }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mountUploader()
    const file = new File(['image'], 'cover.jpg', { type: 'image/jpeg' })

    await selectFiles(wrapper, [file])
    await flushPromises()

    expect(wrapper.text()).toContain('旧格式上传错误')
    expect(wrapper.emitted('uploaded')).toBeUndefined()
  })

  it('本地拒绝不支持格式且不会发起上传请求', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mountUploader()
    const file = new File(['image'], 'cover.gif', { type: 'image/gif' })

    await selectFiles(wrapper, [file])
    await flushPromises()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('不支持的格式: .gif')
    expect(wrapper.emitted('uploaded')).toBeUndefined()
  })
})
