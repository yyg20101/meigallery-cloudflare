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

function expectValidationError(payload: unknown) {
  try {
    validateTelegramImportPayload(payload)
  } catch (error) {
    expect(error).toMatchObject({ code: 'IMPORT_VALIDATION_FAILED', status: 400 })
    return
  }
  throw new Error('预期 payload 被导入校验拒绝')
}

describe('validateTelegramImportPayload', () => {
  it('标准化有效图库导入 payload', () => {
    const result = validateTelegramImportPayload(basePayload)

    expect(result.metadata.type).toBe('gallery')
    expect(result.metadata.requiredLevelRank).toBe(10)
    expect(result.files[0].isCover).toBe(true)
  })

  it('案例导入需要 2-9 张图片', () => {
    const result = () => validateTelegramImportPayload({
      ...basePayload,
      metadata: { ...basePayload.metadata, type: 'case', requiredLevelRank: undefined },
    })

    expect(result).toThrow('案例导入需要 2-9 张图片')
  })

  it('接受有效 case 导入 payload 并按 sortOrder 排序', () => {
    const result = validateTelegramImportPayload({
      ...basePayload,
      metadata: {
        ...basePayload.metadata,
        type: 'case',
        requiredLevelRank: undefined,
        featured: true,
      },
      files: [
        { fileId: 'AgACAg2', fileUniqueId: 'AQAD2', filename: '002.jpg', mimeType: 'image/png', sortOrder: 1 },
        { fileId: 'AgACAg1', fileUniqueId: 'AQAD1', filename: '001.jpg', mimeType: 'image/jpeg', sortOrder: 0 },
      ],
    })

    expect(result.metadata.type).toBe('case')
    expect(result.metadata.featured).toBe(true)
    expect(result.files.map(file => file.fileId)).toEqual(['AgACAg1', 'AgACAg2'])
  })

  it('拒绝 case 超过 9 张图片和 gallery 超过 30 张图片', () => {
    expect(() => validateTelegramImportPayload({
      ...basePayload,
      metadata: { ...basePayload.metadata, type: 'case', requiredLevelRank: undefined },
      files: Array.from({ length: 10 }, (_, index) => ({
        fileId: `AgACAgCase${index}`,
        mimeType: 'image/jpeg',
        sortOrder: index,
      })),
    })).toThrow('案例导入需要 2-9 张图片')

    expect(() => validateTelegramImportPayload({
      ...basePayload,
      files: Array.from({ length: 31 }, (_, index) => ({
        fileId: `AgACAgGallery${index}`,
        mimeType: 'image/jpeg',
        sortOrder: index,
      })),
    })).toThrow('图库导入需要 1-30 张图片')
  })

  it('接受 requiredLevelRank=20 并拒绝非法等级', () => {
    expect(validateTelegramImportPayload({
      ...basePayload,
      metadata: { ...basePayload.metadata, requiredLevelRank: 20 },
    }).metadata.requiredLevelRank).toBe(20)

    expect(() => validateTelegramImportPayload({
      ...basePayload,
      metadata: { ...basePayload.metadata, requiredLevelRank: 15 },
    })).toThrow('requiredLevelRank 只能是 0、10 或 20')
  })

  it('拒绝旧 testimonial_case 导入类型', () => {
    const result = () => validateTelegramImportPayload({
      ...basePayload,
      metadata: { ...basePayload.metadata, type: 'testimonial_case' },
    })

    expect(result).toThrow('metadata.type 必须是 gallery 或 case')
  })

  it('拒绝不支持的文件 MIME 声明', () => {
    const result = () => validateTelegramImportPayload({
      ...basePayload,
      files: [{ ...basePayload.files[0], mimeType: 'video/mp4' }],
    })

    expect(result).toThrow('仅支持 JPEG、PNG、WebP 图片')
  })

  it('拒绝重复 sortOrder', () => {
    const result = () => validateTelegramImportPayload({
      ...basePayload,
      files: [basePayload.files[0], { ...basePayload.files[0], fileId: 'AgACAg2' }],
    })

    expect(result).toThrow('文件 sortOrder 不能重复')
  })

  it('拒绝非法 sourceBotKey 字符', () => {
    const result = () => validateTelegramImportPayload({
      ...basePayload,
      telegram: { ...basePayload.telegram, sourceBotKey: 'Ops-Gallery-Bot' },
    })

    expect(result).toThrow('sourceBotKey 只能包含小写字母、数字和下划线')
  })

  it('把畸形字段稳定拒绝为校验错误，而不是触发运行时类型异常', () => {
    for (const payload of [
      { ...basePayload, metadata: { ...basePayload.metadata, title: 42 } },
      { ...basePayload, metadata: { ...basePayload.metadata, tags: '多伦多' } },
      { ...basePayload, telegram: { ...basePayload.telegram, sourceChatId: 10001 } },
      { ...basePayload, files: [null] },
      { ...basePayload, files: [{ ...basePayload.files[0], filename: { path: '001.jpg' } }] },
    ]) {
      expectValidationError(payload)
    }
  })

  it('拒绝空白必填字段、超长 Telegram 标识和多个封面', () => {
    expect(() => validateTelegramImportPayload({
      ...basePayload,
      metadata: { ...basePayload.metadata, title: '   ' },
    })).toThrow('标题长度必须为 1-80 字符')

    expect(() => validateTelegramImportPayload({
      ...basePayload,
      telegram: { ...basePayload.telegram, sourceMessageId: 'x'.repeat(129) },
    })).toThrow('sourceMessageId长度必须为 1-128 字符')

    expect(() => validateTelegramImportPayload({
      ...basePayload,
      files: [
        basePayload.files[0],
        { ...basePayload.files[0], fileId: 'AgACAg2', sortOrder: 1 },
      ],
    })).toThrow('最多只能指定一张封面图片')
  })

  it('只返回白名单字段并规范化外部标识与标签', () => {
    const result = validateTelegramImportPayload({
      ...basePayload,
      unexpected: 'drop-me',
      metadata: {
        ...basePayload.metadata,
        externalMessageId: '  -1001234567890:456  ',
        tags: ['  多伦多  城区  ', '多伦多 城区'],
        unexpected: 'drop-me',
      },
      telegram: { ...basePayload.telegram, unexpected: 'drop-me' },
      files: [{ ...basePayload.files[0], unexpected: 'drop-me' }],
    }) as unknown as Record<string, unknown>

    expect(result).not.toHaveProperty('unexpected')
    expect(result.metadata).not.toHaveProperty('unexpected')
    expect(result.telegram).not.toHaveProperty('unexpected')
    expect(result.files).toEqual([
      expect.not.objectContaining({ unexpected: 'drop-me' }),
    ])
    expect((result.metadata as Record<string, unknown>).externalMessageId).toBe('-1001234567890:456')
    expect((result.metadata as Record<string, unknown>).tags).toEqual(['多伦多 城区'])
  })
})
