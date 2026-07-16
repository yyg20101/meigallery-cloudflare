import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { Bindings, Variables } from '../../index'
import { adminAttributionPrivacyPolicyRoutes } from './attribution-privacy-policy'

describe('后台地区归因策略 API', () => {
  it('管理员可读取策略，站长可修改并写入审计日志', async () => {
    const fixture = policyDb()
    const read = await app('admin').request('/api/admin/attribution/privacy-policy', {}, {
      DB: fixture.db,
    } as unknown as Bindings)
    expect(await read.json()).toMatchObject({
      data: { defaultMode: 'notice_opt_out', priorConsentCountryCodes: ['GB'], policyVersion: 1 },
    })

    const updated = await app('owner').request('/api/admin/attribution/privacy-policy', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ defaultMode: 'notice_opt_out', priorConsentCountryCodes: ['GB', 'FR', 'GB'] }),
    }, { DB: fixture.db } as unknown as Bindings)

    expect(updated.status).toBe(200)
    expect(await updated.json()).toMatchObject({
      data: { priorConsentCountryCodes: ['FR', 'GB'], policyVersion: 2 },
    })
    expect(fixture.auditActions).toContain('attribution.privacy_policy.update')
  })

  it('非站长不能修改策略', async () => {
    const response = await app('admin').request('/api/admin/attribution/privacy-policy', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ defaultMode: 'disabled', priorConsentCountryCodes: [] }),
    }, { DB: policyDb().db } as unknown as Bindings)

    expect(response.status).toBe(403)
    expect((await response.json()).code).toBe('OWNER_REQUIRED')
  })

  it.each([
    { defaultMode: 'unknown', priorConsentCountryCodes: ['GB'] },
    { defaultMode: 'notice_opt_out', priorConsentCountryCodes: ['UNITED-KINGDOM'] },
    { defaultMode: 'notice_opt_out', priorConsentCountryCodes: 'GB' },
    { defaultMode: 'notice_opt_out', priorConsentCountryCodes: ['GB'], unexpected: true },
  ])('拒绝非法策略 %#', async (body) => {
    const response = await app('owner').request('/api/admin/attribution/privacy-policy', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, { DB: policyDb().db } as unknown as Bindings)

    expect(response.status).toBe(400)
    expect((await response.json()).code).toBe('ATTRIBUTION_PRIVACY_POLICY_INVALID')
  })
})

function app(role: 'admin' | 'owner') {
  const instance = new Hono<{ Bindings: Bindings; Variables: Variables }>()
  instance.use('*', async (c, next) => {
    c.set('userId', 1)
    c.set('userRole', role)
    await next()
  })
  instance.route('/api/admin/attribution/privacy-policy', adminAttributionPrivacyPolicyRoutes)
  return instance
}

function policyDb() {
  const auditActions: string[] = []
  const row = {
    default_mode: 'notice_opt_out',
    prior_consent_country_codes_json: JSON.stringify(['GB']),
    policy_version: 1,
    updated_at: '2026-07-16 00:00:00',
  }
  const db = {
    prepare(sql: string) {
      const params: unknown[] = []
      return {
        bind(...values: unknown[]) { params.push(...values); return this },
        async first() { return sql.includes('FROM attribution_privacy_policy') ? { ...row } : null },
        async run() {
          if (sql.includes('UPDATE attribution_privacy_policy')) {
            row.default_mode = String(params[0])
            row.prior_consent_country_codes_json = String(params[1])
            row.policy_version += 1
            row.updated_at = '2026-07-16 00:01:00'
          }
          if (sql.includes('INSERT INTO admin_audit_logs')) auditActions.push(String(params[2]))
          return { success: true, meta: { changes: 1 } }
        },
      }
    },
  } as unknown as D1Database
  return { db, auditActions }
}
