import { describe, it, expect } from 'vitest'
import { ADMIN_ROLES } from '@meigallery/shared/constants'

/**
 * 测试权限判断纯逻辑（与中间件中使用的逻辑一致）
 */

function isAuthenticated(userId: string | null): boolean {
  return userId !== null && userId !== ''
}

function isAdmin(role: string | null): boolean {
  if (!role) return false
  return ADMIN_ROLES.includes(role as typeof ADMIN_ROLES[number])
}

function isOwner(role: string | null): boolean {
  return role === 'owner'
}

describe('认证状态判断', () => {
  it('有 userId 视为已认证', () => {
    expect(isAuthenticated('usr_123')).toBe(true)
  })

  it('null 视为未认证', () => {
    expect(isAuthenticated(null)).toBe(false)
  })

  it('空字符串视为未认证', () => {
    expect(isAuthenticated('')).toBe(false)
  })
})

describe('管理员角色判断', () => {
  it('admin 是管理员', () => {
    expect(isAdmin('admin')).toBe(true)
  })

  it('owner 是管理员', () => {
    expect(isAdmin('owner')).toBe(true)
  })

  it('user 不是管理员', () => {
    expect(isAdmin('user')).toBe(false)
  })

  it('visitor 不是管理员', () => {
    expect(isAdmin('visitor')).toBe(false)
  })

  it('null 不是管理员', () => {
    expect(isAdmin(null)).toBe(false)
  })
})

describe('站长角色判断', () => {
  it('owner 是站长', () => {
    expect(isOwner('owner')).toBe(true)
  })

  it('admin 不是站长', () => {
    expect(isOwner('admin')).toBe(false)
  })

  it('null 不是站长', () => {
    expect(isOwner(null)).toBe(false)
  })
})
