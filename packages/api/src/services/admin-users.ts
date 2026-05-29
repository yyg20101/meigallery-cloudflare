import { PAGINATION } from '@meigallery/shared/constants'

export interface ListAdminUsersParams {
  page?: string | null
  pageSize?: string | null
  keyword?: string | null
  role?: string | null
  status?: string | null
}

export interface AdminUserListItem {
  id: number
  email: string
  username: string | null
  nickname: string | null
  role: string
  status: string
  createdAt: string
  membershipRank: number
  membershipExpiry: string | null
}

export interface AdminUserListResult {
  data: AdminUserListItem[]
  total: number
  page: number
  pageSize: number
}

interface UserRow {
  id: number
  email: string
  username: string | null
  nickname: string | null
  role: string
  status: string
  created_at: string
}

interface MembershipRow {
  user_id: number
  max_rank: number
  max_expiry: string
}

function parsePage(value: string | null | undefined): number {
  const parsed = Number.parseInt(value || String(PAGINATION.DEFAULT_PAGE), 10)
  return Math.max(1, Number.isNaN(parsed) ? PAGINATION.DEFAULT_PAGE : parsed)
}

function parsePageSize(value: string | null | undefined): number {
  const parsed = Number.parseInt(value || String(PAGINATION.DEFAULT_PAGE_SIZE), 10)
  const pageSize = Number.isNaN(parsed) ? PAGINATION.DEFAULT_PAGE_SIZE : parsed
  return Math.min(PAGINATION.MAX_PAGE_SIZE, Math.max(1, pageSize))
}

function buildUserListFilter(params: ListAdminUsersParams): { whereClause: string; values: unknown[] } {
  const keyword = params.keyword?.trim()
  const whereConditions: string[] = []
  const values: unknown[] = []

  if (keyword) {
    whereConditions.push('(u.email LIKE ? OR u.username LIKE ? OR u.nickname LIKE ?)')
    values.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`)
  }

  if (params.role) {
    whereConditions.push('u.role = ?')
    values.push(params.role)
  }

  if (params.status) {
    whereConditions.push('u.status = ?')
    values.push(params.status)
  }

  return {
    whereClause: whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '',
    values,
  }
}

export async function listAdminUsers(
  db: D1Database,
  params: ListAdminUsersParams,
): Promise<AdminUserListResult> {
  const page = parsePage(params.page)
  const pageSize = parsePageSize(params.pageSize)
  const offset = (page - 1) * pageSize
  const filter = buildUserListFilter(params)

  const countResult = await db
    .prepare(`SELECT COUNT(*) as total FROM users u ${filter.whereClause}`)
    .bind(...filter.values)
    .first<{ total: number }>()
  const total = countResult?.total ?? 0

  const users = await db
    .prepare(`
      SELECT u.id, u.email, u.username, u.nickname, u.role, u.status, u.created_at
      FROM users u
      ${filter.whereClause}
      ORDER BY u.created_at DESC
      LIMIT ? OFFSET ?
    `)
    .bind(...filter.values, pageSize, offset)
    .all<UserRow>()

  const userIds = users.results.map(user => user.id)
  const membershipsMap: Record<number, { rank: number; expiresAt: string }> = {}

  if (userIds.length > 0) {
    const placeholders = userIds.map(() => '?').join(',')
    const memberships = await db
      .prepare(`
        SELECT um.user_id, MAX(ml.rank) as max_rank, MAX(um.expires_at) as max_expiry
        FROM user_memberships um
        JOIN membership_levels ml ON um.level_id = ml.id
        WHERE um.user_id IN (${placeholders})
          AND datetime('now') BETWEEN datetime(um.starts_at) AND datetime(um.expires_at)
        GROUP BY um.user_id
      `)
      .bind(...userIds)
      .all<MembershipRow>()

    for (const membership of memberships.results) {
      membershipsMap[membership.user_id] = {
        rank: membership.max_rank,
        expiresAt: membership.max_expiry,
      }
    }
  }

  return {
    data: users.results.map(user => ({
      id: user.id,
      email: user.email,
      username: user.username,
      nickname: user.nickname,
      role: user.role,
      status: user.status,
      createdAt: user.created_at,
      membershipRank: membershipsMap[user.id]?.rank ?? 0,
      membershipExpiry: membershipsMap[user.id]?.expiresAt ?? null,
    })),
    total,
    page,
    pageSize,
  }
}
