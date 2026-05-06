import { describe, expect, it } from 'vitest'
import { validateTelegramImportPayload } from './import-validation'

const basePayload = {
  metadata: {
    type: 'gallery',
    source: 'telegram',
    externalMessageId: '-1001234567890:456',
    title: '加拿大-多伦多 172D Lina',
    slug: 'toronto-lina-001',
    summary: '一句话摘要',
    bodyMd: '正文 Markdown',
    requiredLevelRank: 10,
    tags: ['加拿大', '多伦多'],
  },
  telegram: {
    sourceBotKey: 'ops_gallery_bot',
    sourceChatId: '-1001234567890',
    sourceMessageId: '456',
    mediaGroupId: '123456',
  },
  files: [
    { fileId: 'AgACAg1', fileUniqueId: 'AQAD1', filename: '001.jpg', mimeType: 'image/jpeg', sortOrder: 0, isCover: true },
  ],
}

describe('validateTelegramImportPayload', () => {
  it('normalizes a valid gallery import payload', () => {
    const result = validateTelegramImportPayload(basePayload)

    expect(result.metadata.type).toBe('gallery')
    expect(result.metadata.requiredLevelRank).toBe(10)
    expect(result.files[0].isCover).toBe(true)
  })

  it('requires 2-9 images for testimonial_case', () => {
    const result = () => validateTelegramImportPayload({
      ...basePayload,
      metadata: { ...basePayload.metadata, type: 'testimonial_case', requiredLevelRank: undefined },
    })

    expect(result).toThrow('真实案例导入需要 2-9 张图片')
  })

  it('rejects unsupported file MIME declarations', () => {
    const result = () => validateTelegramImportPayload({
      ...basePayload,
      files: [{ ...basePayload.files[0], mimeType: 'video/mp4' }],
    })

    expect(result).toThrow('仅支持 JPEG、PNG、WebP 图片')
  })

  it('rejects duplicate sortOrder values', () => {
    const result = () => validateTelegramImportPayload({
      ...basePayload,
      files: [basePayload.files[0], { ...basePayload.files[0], fileId: 'AgACAg2' }],
    })

    expect(result).toThrow('文件 sortOrder 不能重复')
  })

  it('rejects invalid sourceBotKey characters', () => {
    const result = () => validateTelegramImportPayload({
      ...basePayload,
      telegram: { ...basePayload.telegram, sourceBotKey: 'Ops-Gallery-Bot' },
    })

    expect(result).toThrow('sourceBotKey 只能包含小写字母、数字和下划线')
  })
})
