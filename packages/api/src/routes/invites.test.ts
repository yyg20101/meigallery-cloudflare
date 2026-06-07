import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { Bindings, Variables } from '../index'
import { hashInviteCode } from '../services/invite-codes'
import { inviteRoutes } from './invites'

function createApp() {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()
  app.route('/api/invites', inviteRoutes)
  return app
}

function createDb(activeHash: string) {
  return {
    prepare() {
      const params: unknown[] = []
      return {
        bind(...values: unknown[]) {
          params.push(...values)
          return this
        },
        async first() {
          if (params[0] !== activeHash) return null
          return { id: 'inv_1', name: '夏季活动', channel: 'telegram', status: 'active', max_uses: null, used_count: 0, expires_at: null }
        },
      }
    },
  }
}

describe('公开邀请码 API', () => {
  it('只返回公开状态字段，不返回 code_hash', async () => {
    const activeHash = await hashInviteCode('ACTIVE1')
    const res = await createApp().request('/api/invites/ACTIVE1/status', {}, { DB: createDb(activeHash) } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({
      valid: true,
      inviteCodeId: 'inv_1',
      name: '夏季活动',
      channel: 'telegram',
      expiresAt: null,
    })
    expect(JSON.stringify(body)).not.toContain('code_hash')
  })

  it('不存在的邀请码返回失败原因', async () => {
    const res = await createApp().request('/api/invites/MISSING1/status', {}, { DB: createDb('other') } as unknown as Bindings)
    expect(await res.json()).toEqual({ valid: false, reason: 'NOT_FOUND' })
  })
})
