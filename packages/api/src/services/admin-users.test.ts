import { describe, expect, it } from 'vitest'
import { listAdminUsers } from './admin-users'

interface PreparedCall {
  sql: string
  params: unknown[]
}

function createDb(options: {
  total?: number
  users?: Array<{
    id: number
    email: string
    username: string | null
    nickname: string | null
    role: string
    status: string
    created_at: string
  }>
  memberships?: Array<{ user_id: number; max_rank: number; max_expiry: string }>
} = {}) {
  const calls: PreparedCall[] = []

  return {
    calls,
    prepare(sql: string) {
      const call: PreparedCall = { sql, params: [] }
      calls.push(call)
      return {
        bind(...values: unknown[]) {
          call.params = values
          return this
        },
        async first<T>() {
          if (sql.includes('COUNT(*) as total')) {
            return { total: options.total ?? options.users?.length ?? 0 } as T
          }
          return null as T
        },
        async all<T>() {
          if (sql.includes('FROM users u')) {
            return { results: options.users ?? [] } as { results: T[] }
          }
          if (sql.includes('FROM user_memberships um')) {
            return { results: options.memberships ?? [] } as { results: T[] }
          }
          return { results: [] } as { results: T[] }
        },
      }
    },
  }
}

describe('后台用户列表服务', () => {
  it('规范化分页参数并为无筛选查询绑定 LIMIT/OFFSET', async () => {
    const db = createDb()

    const result = await listAdminUsers(db as unknown as D1Database, {
      page: '0',
      pageSize: '500',
    })

    expect(result.page).toBe(1)
    expect(result.pageSize).toBe(100)
    expect(db.calls[0].sql).not.toContain('WHERE')
    expect(db.calls[0].params).toEqual([])
    expect(db.calls[1].params).toEqual([100, 0])
  })

  it('按关键词、角色和状态构建筛选条件', async () => {
    const db = createDb()

    await listAdminUsers(db as unknown as D1Database, {
      page: '2',
      pageSize: '10',
      keyword: '  mei  ',
      role: 'admin',
      status: 'active',
    })

    expect(db.calls[0].sql).toContain('u.email LIKE ? OR u.username LIKE ? OR u.nickname LIKE ?')
    expect(db.calls[0].sql).toContain('u.role = ?')
    expect(db.calls[0].sql).toContain('u.status = ?')
    expect(db.calls[0].params).toEqual(['%mei%', '%mei%', '%mei%', 'admin', 'active'])
    expect(db.calls[1].params).toEqual(['%mei%', '%mei%', '%mei%', 'admin', 'active', 10, 10])
  })

  it('没有用户结果时不查询会员记录', async () => {
    const db = createDb({ users: [] })

    const result = await listAdminUsers(db as unknown as D1Database, {})

    expect(result.data).toEqual([])
    expect(db.calls).toHaveLength(2)
    expect(db.calls.some(call => call.sql.includes('FROM user_memberships um'))).toBe(false)
  })

  it('聚合有效会员 rank 和到期时间到用户列表项', async () => {
    const db = createDb({
      total: 2,
      users: [
        {
          id: 1,
          email: 'owner@example.com',
          username: 'owner',
          nickname: '站长',
          role: 'owner',
          status: 'active',
          created_at: '2026-05-01 00:00:00',
        },
        {
          id: 2,
          email: 'user@example.com',
          username: null,
          nickname: null,
          role: 'user',
          status: 'active',
          created_at: '2026-05-02 00:00:00',
        },
      ],
      memberships: [
        { user_id: 1, max_rank: 20, max_expiry: '2026-12-31 23:59:59' },
      ],
    })

    const result = await listAdminUsers(db as unknown as D1Database, {})

    expect(db.calls[2].sql).toContain('WHERE um.user_id IN (?,?)')
    expect(db.calls[2].params).toEqual([1, 2])
    expect(result).toEqual({
      data: [
        {
          id: 1,
          email: 'owner@example.com',
          username: 'owner',
          nickname: '站长',
          role: 'owner',
          status: 'active',
          createdAt: '2026-05-01 00:00:00',
          membershipRank: 20,
          membershipExpiry: '2026-12-31 23:59:59',
        },
        {
          id: 2,
          email: 'user@example.com',
          username: null,
          nickname: null,
          role: 'user',
          status: 'active',
          createdAt: '2026-05-02 00:00:00',
          membershipRank: 0,
          membershipExpiry: null,
        },
      ],
      total: 2,
      page: 1,
      pageSize: 20,
    })
  })
})
