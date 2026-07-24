import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Miniflare } from 'miniflare'
import { clearAttributionRuntimeDatabase } from '../test/attribution-schema'
import {
  readPrivacyPolicy,
  savePrivacyPolicy,
} from './privacy-policy'

const MIGRATION = [
  '../../migrations/0001_attribution_runtime.sql',
  '../../migrations/0002_event_delivery.sql',
].map(path => readFileSync(new URL(path, import.meta.url), 'utf8')).join('\n')

let miniflare: Miniflare
let db: D1Database
let sequence = 0

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-05-26',
    d1Databases: { DB: 'privacy-policy' },
  })
  db = (await miniflare.getBindings<{ DB: D1Database }>()).DB
  await db.exec(MIGRATION.replace(/\s*\r?\n\s*/g, ' '))
})

afterAll(async () => {
  await miniflare.dispose()
})

beforeEach(async () => {
  await clearAttributionRuntimeDatabase(db)
  await db.prepare(`
    INSERT INTO attribution_privacy_policy (
      id, default_mode, prior_consent_country_codes_json, policy_version
    ) VALUES ('global', 'prior_consent', '[]', 1)
  `).run()
  sequence = 0
})

describe('归因隐私策略命令', () => {
  it('国家代码标准化且同一幂等请求只写一次', async () => {
    const input = {
      defaultMode: 'notice_opt_out',
      priorConsentCountryCodes: ['gb', 'FR', 'GB'],
      actorId: 7,
      idempotencyKey: 'privacy-policy-1',
    } as const
    const first = await savePrivacyPolicy(environment(), input)
    const second = await savePrivacyPolicy(environment(), input)

    expect(first).toEqual(second)
    expect(first).toMatchObject({
      defaultMode: 'notice_opt_out',
      priorConsentCountryCodes: ['FR', 'GB'],
      policyVersion: 2,
      updatedAt: '2026-07-24T06:00:00.000Z',
    })
    expect(await count('attribution_command_receipts')).toBe(1)
    expect(await count('attribution_audit_logs')).toBe(1)
    expect(await readPrivacyPolicy(db)).toEqual(first)
  })

  it('复用幂等键但修改请求时拒绝', async () => {
    await savePrivacyPolicy(environment(), {
      defaultMode: 'notice_opt_out',
      priorConsentCountryCodes: ['GB'],
      actorId: 7,
      idempotencyKey: 'privacy-policy-conflict',
    })

    await expect(savePrivacyPolicy(environment(), {
      defaultMode: 'disabled',
      priorConsentCountryCodes: [],
      actorId: 7,
      idempotencyKey: 'privacy-policy-conflict',
    })).rejects.toThrow('ATTRIBUTION_IDEMPOTENCY_CONFLICT')
  })

  it('并发提交相同幂等命令时只更新一次', async () => {
    const input = {
      defaultMode: 'notice_opt_out',
      priorConsentCountryCodes: ['US'],
      actorId: 7,
      idempotencyKey: 'privacy-policy-concurrent',
    } as const

    const [first, second] = await Promise.all([
      savePrivacyPolicy(environment(), input),
      savePrivacyPolicy(environment(), input),
    ])

    expect(first).toEqual(second)
    expect(first.policyVersion).toBe(2)
    expect(await count('attribution_command_receipts')).toBe(1)
    expect(await count('attribution_audit_logs')).toBe(1)
  })

  it.each([
    ['ZZ'],
    ['UNITED-KINGDOM'],
  ])('拒绝非 ISO 3166-1 alpha-2 国家代码 %s', async (countryCode) => {
    await expect(savePrivacyPolicy(environment(), {
      defaultMode: 'notice_opt_out',
      priorConsentCountryCodes: [countryCode],
      actorId: 7,
      idempotencyKey: `invalid-${countryCode}`,
    })).rejects.toThrow('ATTRIBUTION_PRIVACY_POLICY_INVALID')
  })
})

function environment() {
  return {
    db,
    now: () => new Date('2026-07-24T06:00:00.000Z'),
    idFactory: (prefix: string) => `${prefix}_${++sequence}`,
  }
}

async function count(table: string): Promise<number> {
  const result = await db.prepare(
    `SELECT COUNT(*) AS count FROM ${table}`,
  ).first<{ count: number }>()
  return Number(result?.count ?? 0)
}
