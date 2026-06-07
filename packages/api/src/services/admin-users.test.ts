import { describe, expect, it, vi } from 'vitest'
import {
  AdminUserError,
  changeAdminUserRole,
  changeAdminUserStatus,
  getAdminUserActivity,
  getAdminUserDetail,
  grantAdminUserMembership,
  listAdminUsers,
  resetAdminUserPassword,
  updateAdminUserProfile,
} from './admin-users'

interface PreparedCall {
  sql: string
  params: unknown[]
}

function createStatement<T>(call: PreparedCall, handlers: {
  first?: (sql: string, params: unknown[]) => unknown
  all?: (sql: string, params: unknown[]) => unknown[]
  run?: (sql: string, params: unknown[]) => unknown
}) {
  return {
    bind(...values: unknown[]) {
      call.params = values
      return this
    },
    async first<R>() {
      return (handlers.first?.(call.sql, call.params) ?? null) as R | null
    },
    async all<R>() {
      return { results: (handlers.all?.(call.sql, call.params) ?? []) as R[] }
    },
    async run() {
      return handlers.run?.(call.sql, call.params) ?? { success: true }
    },
  } as T
}

function createDb(handlers: {
  first?: (sql: string, params: unknown[]) => unknown
  all?: (sql: string, params: unknown[]) => unknown[]
  run?: (sql: string, params: unknown[]) => unknown
} = {}) {
  const calls: PreparedCall[] = []
  return {
    calls,
    prepare(sql: string) {
      const call: PreparedCall = { sql, params: [] }
      calls.push(call)
      return createStatement<D1PreparedStatement>(call, handlers)
    },
  }
}

describe('后台用户服务', () => {
  it('列表查询会规范分页并构建筛选条件', async () => {
    const db = createDb({
      first: () => ({ total: 1 }),
      all: () => [
        { id: 1, email: 'user@example.com', username: 'user', nickname: 'User', role: 'user', status: 'active', created_at: '2026-06-01T00:00:00Z' },
      ],
    })

    const result = await listAdminUsers(db as unknown as D1Database, { page: '0', pageSize: '999', keyword: 'user', role: 'user', status: 'active' })

    expect(result.page).toBe(1)
    expect(result.pageSize).toBe(100)
    expect(result.total).toBe(1)
    expect(db.calls[0].sql).toContain('u.email LIKE ?')
  })

  it('详情查询会返回会员历史并拒绝不存在用户', async () => {
    const db = createDb({
      first: (sql) => {
        if (sql.includes('FROM users WHERE id = ?')) {
          return {
            id: 1,
            email: 'user@example.com',
            username: 'user',
            nickname: 'User',
            avatar_key: null,
            role: 'user',
            status: 'active',
            email_verified: 1,
            notification_enabled: 0,
            created_at: '2026-06-01T00:00:00Z',
            updated_at: '2026-06-01T00:00:00Z',
          }
        }
        return null
      },
      all: (sql) => sql.includes('FROM user_memberships')
        ? [{ id: 'mem_1', level_name: 'vip', rank: 10, starts_at: '2026-06-01 00:00:00', expires_at: '2026-07-01 00:00:00', granted_by: '1', note: null, created_at: '2026-06-01T00:00:00Z' }]
        : [],
    })

    const detail = await getAdminUserDetail(db as unknown as D1Database, 1)
    expect(detail.emailVerified).toBe(true)
    expect(detail.memberships).toHaveLength(1)

    const missingDb = createDb({ first: () => null })
    await expect(getAdminUserDetail(missingDb as unknown as D1Database, 1))
      .rejects.toMatchObject(new AdminUserError(404, '用户不存在'))
  })

  it('修改资料和密码时会执行权限与唯一性校验', async () => {
    const db = createDb({
      first: (sql) => {
        if (sql.includes('SELECT id, email, username, role FROM users WHERE id = ?')) {
          return { id: 1, email: 'old@example.com', username: 'old', role: 'user' }
        }
        if (sql.includes('SELECT id FROM users WHERE username = ? AND id != ?')) return null
        if (sql.includes('SELECT id FROM users WHERE email = ? AND id != ?')) return null
        if (sql.includes('SELECT id, role FROM users WHERE id = ?')) return { id: 1, role: 'user' }
        return null
      },
    })
    const hashSpy = vi.fn().mockResolvedValue('hash')

    await updateAdminUserProfile(db as unknown as D1Database, 9, 1, { username: 'NewUser', email: 'new@example.com' })
    expect(db.calls.some(call => call.sql.includes('UPDATE users SET'))).toBe(true)

    await expect(resetAdminUserPassword(db as unknown as D1Database, 9, 1, 'short'))
      .rejects.toMatchObject(new AdminUserError(400, '密码长度至少 8 位'))
    expect(hashSpy).not.toHaveBeenCalled()
  })

  it('发放会员、改角色和改状态会保留安全约束', async () => {
    const db = createDb({
      first: (sql) => {
        if (sql.includes('SELECT id FROM users WHERE id = ?')) return { id: 1 }
        if (sql.includes('SELECT id, name, rank FROM membership_levels WHERE id = ?')) return { id: 'level_1', name: 'vip', rank: 10 }
        if (sql.includes('SELECT id, role FROM users WHERE id = ?')) return { id: 1, role: 'user' }
        if (sql.includes('SELECT id, role, status FROM users WHERE id = ?')) return { id: 1, role: 'user', status: 'active' }
        return null
      },
    })

    const grant = await grantAdminUserMembership(db as unknown as D1Database, 1, 1, {
      levelId: 'level_1',
      expiresAt: '2026-07-01T00:00:00Z',
      note: '  test  ',
    })
    expect(grant.note).toBe('test')

    await expect(changeAdminUserRole(db as unknown as D1Database, 1, 1, 'owner'))
      .rejects.toMatchObject(new AdminUserError(400, 'role 必须为 user 或 admin'))
    await expect(changeAdminUserStatus(db as unknown as D1Database, 1, 1, 'disabled'))
      .rejects.toMatchObject(new AdminUserError(400, 'status 必须为 active 或 banned'))
  })

  it('活动日志会返回审计和 session 列表并拒绝不存在用户', async () => {
    const db = createDb({
      first: () => ({ id: 1 }),
      all: (sql) => {
        if (sql.includes('FROM admin_audit_logs')) {
          return [{
            id: 'log_1',
            admin_id: 1,
            action: 'edit_user',
            target_type: 'user',
            target_id: '1',
            before_value: '{"username":"old"}',
            after_value: '{"username":"new"}',
            created_at: '2026-06-01T00:00:00Z',
          }]
        }
        if (sql.includes('FROM sessions')) {
          return [{ id: 'sess_1', created_at: '2026-06-01T00:00:00Z' }]
        }
        return []
      },
    })

    const activity = await getAdminUserActivity(db as unknown as D1Database, 1)
    expect(activity.auditLogs).toHaveLength(1)
    expect(activity.recentSessions).toHaveLength(1)
    expect(db.calls.find(call => call.sql.includes('FROM admin_audit_logs'))?.sql).toContain('json_valid(after_value)')

    const missingDb = createDb({ first: () => null })
    await expect(getAdminUserActivity(missingDb as unknown as D1Database, 1))
      .rejects.toMatchObject(new AdminUserError(404, '用户不存在'))
  })

  it('活动日志遇到历史损坏审计 JSON 时不会中断详情页', async () => {
    const db = createDb({
      first: () => ({ id: 1 }),
      all: (sql) => {
        if (sql.includes('FROM admin_audit_logs')) {
          return [{
            id: 'log_1',
            admin_id: 1,
            action: 'edit_user',
            target_type: 'user',
            target_id: '1',
            before_value: '{"username":"old"}',
            after_value: '{broken',
            created_at: '2026-06-01T00:00:00Z',
          }]
        }
        return []
      },
    })

    const activity = await getAdminUserActivity(db as unknown as D1Database, 1)

    expect(activity.auditLogs[0]?.beforeValue).toEqual({ username: 'old' })
    expect(activity.auditLogs[0]?.afterValue).toEqual({ message: '历史审计内容格式异常' })
  })

  it('发放会员会校验日期格式和起止顺序', async () => {
    const db = createDb()

    await expect(grantAdminUserMembership(db as unknown as D1Database, 1, 1, {
      levelId: 'level_1',
      expiresAt: 'not-a-date',
    })).rejects.toMatchObject(new AdminUserError(400, '会员到期时间格式无效'))

    await expect(grantAdminUserMembership(db as unknown as D1Database, 1, 1, {
      levelId: 'level_1',
      startsAt: '2026-07-02T00:00:00Z',
      expiresAt: '2026-07-01T00:00:00Z',
    })).rejects.toMatchObject(new AdminUserError(400, '会员到期时间必须晚于开始时间'))

    expect(db.calls).toHaveLength(0)
  })

  it('发放会员会写入规范化时间和清理后的审计备注', async () => {
    const db = createDb({
      first: (sql) => {
        if (sql.includes('SELECT id FROM users WHERE id = ?')) return { id: 1 }
        if (sql.includes('SELECT id, name, rank FROM membership_levels WHERE id = ?')) return { id: 'level_1', name: 'vip', rank: 10 }
        return null
      },
    })

    const result = await grantAdminUserMembership(db as unknown as D1Database, 7, 1, {
      levelId: 'level_1',
      startsAt: '2026-07-01T08:30:00+08:00',
      expiresAt: '2026-08-01T08:30:00+08:00',
      note: '  已线下确认  ',
    })

    expect(result.startsAt).toBe('2026-07-01 00:30:00')
    expect(result.expiresAt).toBe('2026-08-01 00:30:00')
    expect(result.note).toBe('已线下确认')

    const insertCall = db.calls.find(call => call.sql.includes('INSERT INTO user_memberships'))
    expect(insertCall?.params).toContain('2026-07-01 00:30:00')
    expect(insertCall?.params).toContain('2026-08-01 00:30:00')
    expect(insertCall?.params).toContain('已线下确认')

    const auditCall = db.calls.find(call => call.sql.includes('INSERT INTO admin_audit_logs'))
    expect(auditCall?.params[6]).toContain('"note":"已线下确认"')

    const inviteConversionCall = db.calls.find(call => call.sql.includes('UPDATE invite_registrations'))
    expect(inviteConversionCall?.params).toEqual(['2026-07-01T00:30:00.000Z', 10, 1])
  })
})
