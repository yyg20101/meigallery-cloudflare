import { describe, expect, it } from 'vitest'
import {
  createImportToken,
  hashImportToken,
  hasImportPermission,
  isImportTokenExpired,
  isSourceBotAllowed,
  parseJsonStringArray,
} from './import-token'

describe('import token utilities', () => {
  it('generates a one-time token with mgi prefix', () => {
    const token = createImportToken()

    expect(token).toMatch(/^mgi_[A-Za-z0-9_-]{43}$/)
  })

  it('hashes tokens with stable SHA-256 hex', async () => {
    const hash = await hashImportToken('mgi_test_token')

    expect(hash).toBe(await hashImportToken('mgi_test_token'))
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('checks permissions from JSON array strings', () => {
    expect(hasImportPermission('["gallery:create"]', 'gallery:create')).toBe(true)
    expect(hasImportPermission('["gallery:create"]', 'testimonial:create')).toBe(false)
  })

  it('treats invalid JSON permissions as empty', () => {
    expect(parseJsonStringArray('{bad json')).toEqual([])
    expect(hasImportPermission('{bad json', 'gallery:create')).toBe(false)
  })

  it('checks sourceBotKey allowlist exactly', () => {
    expect(isSourceBotAllowed('["ops_gallery_bot"]', 'ops_gallery_bot')).toBe(true)
    expect(isSourceBotAllowed('["ops_gallery_bot"]', 'other_bot')).toBe(false)
    expect(isSourceBotAllowed('[]', 'ops_gallery_bot')).toBe(false)
  })

  it('detects expired token timestamps', () => {
    expect(isImportTokenExpired(null, new Date('2026-05-06T10:00:00.000Z'))).toBe(false)
    expect(isImportTokenExpired('2026-05-06T09:59:59.000Z', new Date('2026-05-06T10:00:00.000Z'))).toBe(true)
    expect(isImportTokenExpired('2026-05-06T10:01:00.000Z', new Date('2026-05-06T10:00:00.000Z'))).toBe(false)
  })
})
