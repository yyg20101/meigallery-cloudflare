import { describe, it, expect } from 'vitest'
import { hashPassword, verifyPassword } from './password'

describe('password', () => {
  it('哈希后可验证通过', async () => {
    const hash = await hashPassword('Test1234!')
    const valid = await verifyPassword('Test1234!', hash)
    expect(valid).toBe(true)
  })

  it('错误密码验证失败', async () => {
    const hash = await hashPassword('Test1234!')
    const valid = await verifyPassword('Wrong1234!', hash)
    expect(valid).toBe(false)
  })

  it('哈希格式正确', async () => {
    const hash = await hashPassword('Test1234!')
    expect(hash).toMatch(/^\$pbkdf2\$\d+\$.+\$.+$/)
  })

  it('相同密码生成不同哈希', async () => {
    const h1 = await hashPassword('Test1234!')
    const h2 = await hashPassword('Test1234!')
    expect(h1).not.toBe(h2)
  })

  it('非法哈希格式返回 false', async () => {
    expect(await verifyPassword('test', 'invalid_hash')).toBe(false)
    expect(await verifyPassword('test', '$argon2$xxx$yyy$zzz')).toBe(false)
  })
})
