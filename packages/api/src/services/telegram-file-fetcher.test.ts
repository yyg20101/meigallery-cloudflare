import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchTelegramImageFile, getExtensionForMime, getTelegramSecretName } from './telegram-file-fetcher'

describe('fetchTelegramImageFile', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('downloads a Telegram image without exposing the file URL', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/getFile')) return Response.json({ ok: true, result: { file_path: 'photos/file_1.jpg', file_size: 4 } })
      return new Response(new Uint8Array([1, 2, 3, 4]), { headers: { 'Content-Type': 'image/jpeg' } })
    }))

    const result = await fetchTelegramImageFile({ TELEGRAM_BOT_TOKEN_OPS_GALLERY_BOT: '123:secret' }, 'ops_gallery_bot', 'AgACAg1')

    expect(result.mimeType).toBe('image/jpeg')
    expect(result.bytes.byteLength).toBe(4)
  })

  it('fails when sourceBotKey secret is missing', async () => {
    await expect(fetchTelegramImageFile({}, 'ops_gallery_bot', 'AgACAg1')).rejects.toThrow('未配置 Telegram Bot Token')
  })

  it('rejects unsupported downloaded content type', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/getFile')) return Response.json({ ok: true, result: { file_path: 'videos/file.mp4', file_size: 4 } })
      return new Response(new Uint8Array([1, 2, 3, 4]), { headers: { 'Content-Type': 'video/mp4' } })
    }))

    await expect(fetchTelegramImageFile({ TELEGRAM_BOT_TOKEN_OPS_GALLERY_BOT: '123:secret' }, 'ops_gallery_bot', 'AgACAg1')).rejects.toThrow('Telegram 文件类型不支持')
  })

  it('resolves secret names and extensions', () => {
    expect(getTelegramSecretName('ops_gallery_bot')).toBe('TELEGRAM_BOT_TOKEN_OPS_GALLERY_BOT')
    expect(getExtensionForMime('image/webp')).toBe('webp')
  })
})
