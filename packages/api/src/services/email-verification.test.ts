import { describe, expect, it, vi } from 'vitest'
import {
  VERIFICATION_CODE_TTL_MS,
  createVerificationCode,
  generateVerificationCode,
  hasRecentVerificationCode,
  isEmailVerificationEnabled,
  verifyCode,
} from './email-verification'

function createDb(options: {
  settingValue?: string | null
  recentCode?: boolean
  codeRecord?: { id: string; code: string; attempts: number; expires_at: string } | null
} = {}) {
  const runs: Array<{ sql: string; params: unknown[] }> = []

  return {
    runs,
    prepare(sql: string) {
      const params: unknown[] = []
      return {
        bind(...values: unknown[]) {
          params.push(...values)
          return this
        },
        async first<T>() {
          if (sql.includes("FROM site_settings WHERE key = 'email_verification_enabled'")) {
            return options.settingValue === undefined || options.settingValue === null
              ? null as T
              : { value: options.settingValue } as T
          }
          if (sql.includes("created_at > datetime('now', '-60 seconds')")) {
            return options.recentCode ? { id: 'evc_recent' } as T : null as T
          }
          if (sql.includes('FROM email_verification_codes') && sql.includes('ORDER BY created_at DESC')) {
            return (options.codeRecord ?? null) as T
          }
          return null as T
        },
        async run() {
          runs.push({ sql, params: [...params] })
          return { success: true }
        },
      }
    },
  }
}

describe('邮箱验证码服务', () => {
  it('生成 6 位数字验证码', () => {
    vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
      const bytes = array as Uint8Array
      bytes.set([0, 0, 0, 42])
      return array
    })

    expect(generateVerificationCode()).toBe('000042')
  })

  it('从站点设置解析邮箱验证开关', async () => {
    await expect(isEmailVerificationEnabled(createDb({ settingValue: 'true' }) as unknown as D1Database)).resolves.toBe(true)
    await expect(isEmailVerificationEnabled(createDb({ settingValue: '"true"' }) as unknown as D1Database)).resolves.toBe(true)
    await expect(isEmailVerificationEnabled(createDb({ settingValue: 'false' }) as unknown as D1Database)).resolves.toBe(false)
    await expect(isEmailVerificationEnabled(createDb({ settingValue: '{bad json' }) as unknown as D1Database)).resolves.toBe(false)
  })

  it('检查 60 秒冷却窗口内是否已有验证码', async () => {
    await expect(hasRecentVerificationCode(createDb({ recentCode: true }) as unknown as D1Database, 'u@example.com', 'register')).resolves.toBe(true)
    await expect(hasRecentVerificationCode(createDb({ recentCode: false }) as unknown as D1Database, 'u@example.com', 'register')).resolves.toBe(false)
  })

  it('创建新验证码前作废同邮箱同用途旧验证码', async () => {
    vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
      const bytes = array as Uint8Array
      bytes.set([0, 0, 0, 7])
      return array
    })
    const db = createDb()
    const now = new Date('2026-05-29T00:00:00.000Z')

    const code = await createVerificationCode(db as unknown as D1Database, 'u@example.com', 'register', now)

    expect(code).toBe('000007')
    expect(db.runs[0].sql).toContain('UPDATE email_verification_codes SET used = 1')
    expect(db.runs[0].params).toEqual(['u@example.com', 'register'])
    expect(db.runs[1].sql).toContain('INSERT INTO email_verification_codes')
    expect(db.runs[1].params.slice(1)).toEqual([
      'u@example.com',
      '000007',
      'register',
      new Date(now.getTime() + VERIFICATION_CODE_TTL_MS).toISOString(),
    ])
  })

  it('验证码不存在时返回失效提示', async () => {
    const result = await verifyCode(createDb({ codeRecord: null }) as unknown as D1Database, 'u@example.com', '123456', 'register')

    expect(result).toEqual({ success: false, error: '验证码不存在或已失效，请重新发送' })
  })

  it('验证码过期时作废记录', async () => {
    const db = createDb({
      codeRecord: { id: 'evc_1', code: '123456', attempts: 0, expires_at: '2026-05-28T00:00:00.000Z' },
    })

    const result = await verifyCode(db as unknown as D1Database, 'u@example.com', '123456', 'register', new Date('2026-05-29T00:00:00.000Z'))

    expect(result).toEqual({ success: false, error: '验证码已过期，请重新发送' })
    expect(db.runs[0]).toMatchObject({ params: ['evc_1'] })
  })

  it('错误次数过多时作废记录', async () => {
    const db = createDb({
      codeRecord: { id: 'evc_1', code: '123456', attempts: 3, expires_at: '2026-05-30T00:00:00.000Z' },
    })

    const result = await verifyCode(db as unknown as D1Database, 'u@example.com', '123456', 'register', new Date('2026-05-29T00:00:00.000Z'))

    expect(result).toEqual({ success: false, error: '验证码错误次数过多，请重新发送' })
    expect(db.runs[0]).toMatchObject({ params: ['evc_1'] })
  })

  it('验证码错误时增加尝试次数并返回剩余次数', async () => {
    const db = createDb({
      codeRecord: { id: 'evc_1', code: '123456', attempts: 1, expires_at: '2026-05-30T00:00:00.000Z' },
    })

    const result = await verifyCode(db as unknown as D1Database, 'u@example.com', '000000', 'register', new Date('2026-05-29T00:00:00.000Z'))

    expect(result).toEqual({ success: false, error: '验证码错误，还可尝试 1 次' })
    expect(db.runs[0].sql).toContain('SET attempts = attempts + 1')
    expect(db.runs[0].params).toEqual(['evc_1'])
  })

  it('验证码正确时作废记录并返回成功', async () => {
    const db = createDb({
      codeRecord: { id: 'evc_1', code: '123456', attempts: 0, expires_at: '2026-05-30T00:00:00.000Z' },
    })

    const result = await verifyCode(db as unknown as D1Database, 'u@example.com', '123456', 'register', new Date('2026-05-29T00:00:00.000Z'))

    expect(result).toEqual({ success: true })
    expect(db.runs[0].sql).toContain('SET used = 1')
    expect(db.runs[0].params).toEqual(['evc_1'])
  })
})
