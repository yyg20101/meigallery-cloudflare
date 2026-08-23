import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchTelegramImageFile, getExtensionForMime, getTelegramSecretName } from './telegram-file-fetcher'

const VALID_JPEG_BYTES = new Uint8Array([
  0xff, 0xd8,
  0xff, 0xc0, 0x00, 0x11,
  0x08, 0x00, 0x10, 0x00, 0x20, 0x03,
  0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
  0xff, 0xda, 0x00, 0x0c,
  0x03, 0x01, 0x00, 0x02, 0x00, 0x03, 0x00, 0x00, 0x3f, 0x00,
  0x00, 0xff, 0xd9,
])

describe('fetchTelegramImageFile', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('下载并校验 Telegram 图片内容且不暴露文件 URL', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      if (url.includes('/getFile')) return Response.json({ ok: true, result: { file_path: 'photos/file_1.jpg', file_size: VALID_JPEG_BYTES.byteLength } })
      return new Response(VALID_JPEG_BYTES, { headers: { 'Content-Type': 'image/jpeg' } })
    }))

    const result = await fetchTelegramImageFile({ TELEGRAM_BOT_TOKEN_OPS_GALLERY_BOT: '123:secret' }, 'ops_gallery_bot', 'AgACAg1')

    expect(result.mimeType).toBe('image/jpeg')
    expect(result.bytes.byteLength).toBe(VALID_JPEG_BYTES.byteLength)
  })

  it('sourceBotKey 对应 secret 缺失时失败', async () => {
    await expect(fetchTelegramImageFile({}, 'ops_gallery_bot', 'AgACAg1')).rejects.toThrow('未配置 Telegram Bot Token')
  })

  it('拒绝不受支持的下载 Content-Type', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/getFile')) return Response.json({ ok: true, result: { file_path: 'videos/file.mp4', file_size: 4 } })
      return new Response(new Uint8Array([1, 2, 3, 4]), { headers: { 'Content-Type': 'video/mp4' } })
    }))

    await expect(fetchTelegramImageFile({ TELEGRAM_BOT_TOKEN_OPS_GALLERY_BOT: '123:secret' }, 'ops_gallery_bot', 'AgACAg1')).rejects.toThrow('Telegram 文件类型不支持')
  })

  it('拒绝伪装成 JPEG 的非图片内容', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/getFile')) return Response.json({ ok: true, result: { file_path: 'photos/file_1.jpg', file_size: 4 } })
      return new Response(new Uint8Array([1, 2, 3, 4]), { headers: { 'Content-Type': 'image/jpeg' } })
    }))

    await expect(fetchTelegramImageFile(
      { TELEGRAM_BOT_TOKEN_OPS_GALLERY_BOT: '123:secret' },
      'ops_gallery_bot',
      'AgACAg1',
    )).rejects.toMatchObject({ code: 'TELEGRAM_FILE_CONTENT_INVALID' })
  })

  it('在读取响应体前拒绝超过 10MB 的声明长度', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/getFile')) return Response.json({ ok: true, result: { file_path: 'photos/file_1.jpg' } })
      return new Response(VALID_JPEG_BYTES, {
        headers: {
          'Content-Type': 'image/jpeg',
          'Content-Length': String(10 * 1024 * 1024 + 1),
        },
      })
    }))

    await expect(fetchTelegramImageFile(
      { TELEGRAM_BOT_TOKEN_OPS_GALLERY_BOT: '123:secret' },
      'ops_gallery_bot',
      'AgACAg1',
    )).rejects.toMatchObject({ code: 'TELEGRAM_FILE_TOO_LARGE' })
  })

  it('解析 secret 名称和扩展名', () => {
    expect(getTelegramSecretName('ops_gallery_bot')).toBe('TELEGRAM_BOT_TOKEN_OPS_GALLERY_BOT')
    expect(getExtensionForMime('image/webp')).toBe('webp')
  })
})
