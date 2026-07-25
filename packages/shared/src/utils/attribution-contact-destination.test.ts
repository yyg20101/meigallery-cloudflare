import { describe, expect, it } from 'vitest'
import { digestAttributionContactDestination } from './attribution-contact-destination'

describe('联系人归因目标摘要', () => {
  it('对同一目标稳定生成小写 SHA-256，目标任一字段变化都会失配', async () => {
    const target = {
      value: '@meigallery',
      linkUrl: 'https://telegram.me/meigallery',
    }
    const first = await digestAttributionContactDestination(target)
    const duplicate = await digestAttributionContactDestination(target)
    const changedValue = await digestAttributionContactDestination({
      ...target,
      value: '@other',
    })
    const changedLink = await digestAttributionContactDestination({
      ...target,
      linkUrl: 'https://telegram.me/other',
    })

    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(duplicate).toBe(first)
    expect(changedValue).not.toBe(first)
    expect(changedLink).not.toBe(first)
  })

  it('明确区分无链接与空链接，避免不同目标配置共用 capability', async () => {
    const value = 'contact@example.com'

    expect(await digestAttributionContactDestination({
      value,
      linkUrl: null,
    })).not.toBe(await digestAttributionContactDestination({
      value,
      linkUrl: '',
    }))
  })
})
