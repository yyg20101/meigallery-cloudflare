import { describe, expect, it } from 'vitest'
import { attributionPlannerRolloutBucket, buildAttributionDeliveryPlan } from './planner'

const eventKey = async () => crypto.subtle.importKey(
  'raw', new TextEncoder().encode('a'.repeat(32)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
)

describe('归因投递 Planner', () => {
  it('同一事实为 Browser 与 Server 生成相同的 mg3_ externalEventId', async () => {
    const plan = await buildAttributionDeliveryPlan({
      factId: 'fact_1', provider: 'meta', canonicalEvent: 'Contact', consentGranted: true,
      sourceAvailable: true, stableId: 'user_1', eventKey: await eventKey(),
      connection: readyConnection('meta'),
    })

    expect(plan.deliveries).toHaveLength(2)
    expect(new Set(plan.deliveries.map(item => item.externalEventId))).toEqual(new Set([plan.externalEventId]))
    expect(plan.externalEventId).toMatch(/^mg3_/)
  })

  it.each([
    ['无来源', false, true],
    ['冲突来源', true, false],
    ['拒绝同意', true, true, false],
  ])('%s 时不创建广告 Delivery', async (_label, sourceAvailable, providerSelected, consentGranted = true) => {
    const plan = await buildAttributionDeliveryPlan({
      factId: 'fact_2', provider: providerSelected ? 'tiktok' : null, canonicalEvent: 'Contact',
      consentGranted, sourceAvailable, stableId: 'user_2', eventKey: await eventKey(),
      connection: readyConnection('tiktok'),
    })
    expect(plan.deliveries).toEqual([])
  })

  it('Google 的 Contact 和 CompleteRegistration 使用不同 destination，rollout 保持确定性', async () => {
    const input = {
      factId: 'fact_google', provider: 'google' as const, consentGranted: true, sourceAvailable: true,
      stableId: 'user_3', eventKey: await eventKey(), connection: readyConnection('google'),
    }
    const contact = await buildAttributionDeliveryPlan({ ...input, canonicalEvent: 'Contact' })
    const registration = await buildAttributionDeliveryPlan({ ...input, canonicalEvent: 'CompleteRegistration' })
    const repeated = await buildAttributionDeliveryPlan({ ...input, canonicalEvent: 'Contact' })

    expect(contact.deliveries[0]?.destination).not.toBe(registration.deliveries[0]?.destination)
    expect(contact.rolloutBucket).toBe(repeated.rolloutBucket)
    expect(contact.deliveries.length).toBe(repeated.deliveries.length)
  })

  it('未知 provider fail closed', async () => {
    const plan = await buildAttributionDeliveryPlan({
      factId: 'fact_unknown', provider: 'unknown', canonicalEvent: 'Contact', consentGranted: true,
      sourceAvailable: true, stableId: 'user_4', eventKey: await eventKey(), connection: readyConnection('meta'),
    })
    expect(plan.deliveries).toEqual([])
  })

  it.each([0, 10, 100])('Server rollout 为 %i 时 Browser 仍独立计划', async rolloutEffectivePercentage => {
    const plan = await buildAttributionDeliveryPlan({
      factId: `fact_rollout_${rolloutEffectivePercentage}`, provider: 'meta', canonicalEvent: 'Contact',
      consentGranted: true, sourceAvailable: true, stableId: 'user_5', eventKey: await eventKey(),
      connection: readyConnection('meta', rolloutEffectivePercentage),
    })
    expect(plan.deliveries.filter(item => item.transport === 'browser')).toHaveLength(1)
    if (rolloutEffectivePercentage === 100) expect(plan.deliveries.filter(item => item.transport === 'server')).toHaveLength(1)
    else expect(plan.deliveries.filter(item => item.transport === 'server')).toHaveLength(0)
  })

  it('10% Server rollout 使用稳定 bucket，Browser 在纳入和排除时均保留', async () => {
    expect(await attributionPlannerRolloutBucket('conn_meta:revision_1', 'stable-13')).toBe(1)
    expect(await attributionPlannerRolloutBucket('conn_meta:revision_1', 'rollout-in')).toBe(95)

    const base = {
      provider: 'meta' as const, canonicalEvent: 'Contact' as const, consentGranted: true, sourceAvailable: true,
      eventKey: await eventKey(), connection: readyConnection('meta', 10),
    }
    const included = await buildAttributionDeliveryPlan({ ...base, factId: 'fact_bucket_in', stableId: 'stable-13' })
    const excluded = await buildAttributionDeliveryPlan({ ...base, factId: 'fact_bucket_out', stableId: 'rollout-in' })

    expect(included.deliveries.map(item => item.transport)).toEqual(['browser', 'server'])
    expect(excluded.deliveries.map(item => item.transport)).toEqual(['browser'])
  })
})

function readyConnection(provider: 'meta' | 'tiktok' | 'google', rolloutPercentage = 100) {
  return {
    state: 'ready' as const,
    connection: {
      id: `conn_${provider}`, provider, enabled: true, mode: 'production' as const,
      browserEnabled: true, serverEnabled: true, connectionRevision: 'revision_1',
      credentialRevision: 'credential_1', rolloutTargetPercentage: rolloutPercentage,
      rolloutEffectivePercentage: rolloutPercentage, publicConfig: {},
    },
    bindings: new Map([
      ['Contact', { enabled: true, browserDestination: 'contact', serverDestination: 'contact' }],
      ['CompleteRegistration', { enabled: true, browserDestination: 'registration', serverDestination: 'registration' }],
    ]),
    credential: { type: 'access_token', schemaVersion: 1, credentialRevision: 'credential_1' },
  }
}
