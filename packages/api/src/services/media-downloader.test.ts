import { afterEach, describe, expect, it, vi } from 'vitest'
import { downloadImageToR2 } from './media-downloader'

const VALID_PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x04, 0x00, 0x00, 0x00, 0xb5, 0x1c, 0x0c, 0x02, 0x00, 0x00, 0x00,
  0x0b, 0x49, 0x44, 0x41, 0x54, 0x78, 0xda, 0x63, 0x64, 0xf8, 0x0f, 0x00,
  0x01, 0x05, 0x01, 0x01, 0x27, 0x18, 0xe3, 0x66, 0x00, 0x00, 0x00, 0x00,
  0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
])

afterEach(() => {
  vi.restoreAllMocks()
})

describe('旧站图片安全下载', () => {
  it('按内容魔数识别并净化图片后写入确定性 R2 key', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(VALID_PNG_BYTES, {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    }))
    const put = vi.fn().mockResolvedValue(undefined)

    const result = await downloadImageToR2(
      { put } as unknown as R2Bucket,
      'https://legacy.example.com/image-with-wrong-header',
      'gal_1',
      'med_1',
    )

    expect(result).toEqual({
      assetId: 'med_1',
      success: true,
      r2Key: 'originals/gal_1/med_1.png',
    })
    expect(put).toHaveBeenCalledWith(
      'originals/gal_1/med_1.png',
      expect.any(Uint8Array),
      { httpMetadata: { contentType: 'image/png' } },
    )
  })

  it('拒绝伪装为图片的 HTML 响应', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>not image</html>', {
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
    }))
    const put = vi.fn()

    const result = await downloadImageToR2(
      { put } as unknown as R2Bucket,
      'https://legacy.example.com/not-image.jpg',
      'gal_1',
      'med_1',
    )

    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('IMPORT_IMAGE_TYPE_UNSUPPORTED')
    expect(put).not.toHaveBeenCalled()
  })

  it('在读取正文前拒绝声明超过 10 MiB 的响应', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(VALID_PNG_BYTES, {
      status: 200,
      headers: { 'content-length': String(10 * 1024 * 1024 + 1) },
    }))
    const put = vi.fn()

    const result = await downloadImageToR2(
      { put } as unknown as R2Bucket,
      'https://legacy.example.com/oversized.png',
      'gal_1',
      'med_1',
    )

    expect(result).toMatchObject({ success: false, error: '远程图片超过 10 MiB 上限' })
    expect(put).not.toHaveBeenCalled()
  })

  it('R2 异常只返回稳定错误码和安全文案', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(VALID_PNG_BYTES, { status: 200 }))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const put = vi.fn().mockRejectedValue(new Error('bucket binding secret detail'))

    const result = await downloadImageToR2(
      { put } as unknown as R2Bucket,
      'https://legacy.example.com/image.png',
      'gal_1',
      'med_1',
    )

    expect(result).toEqual({
      assetId: 'med_1',
      success: false,
      errorCode: 'LEGACY_MEDIA_REMOTE_DOWNLOAD_FAILED',
      error: '远程图片下载或存储失败，请稍后重试',
    })
    expect(JSON.stringify(result)).not.toContain('bucket binding secret detail')
  })

  it('远程图片请求携带 60 秒截止信号', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(VALID_PNG_BYTES, { status: 200 }),
    )

    await downloadImageToR2(
      { put: vi.fn().mockResolvedValue(undefined) } as unknown as R2Bucket,
      'https://legacy.example.com/image.png',
      'gal_1',
      'med_1',
    )

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      redirect: 'manual',
      signal: expect.any(AbortSignal),
    })
  })
})
