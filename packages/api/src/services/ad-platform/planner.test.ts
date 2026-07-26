import { describe, expect, it } from 'vitest'
import { loadAttributionCryptoKeys } from '../../utils/attribution-crypto'
import { buildAttributionDeliveryPlan } from './planner'

const MASTER_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
const cryptoKeys = () => loadAttributionCryptoKeys({ AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT: MASTER_KEY })

describe('归因投递 Planner', () => {
  it('同一事实为 Browser 与 Server 生成相同的 mg3_ externalEventId', async () => {
    const plan = await buildAttributionDeliveryPlan({
      factId: 'fact_1', provider: 'meta', canonicalEvent: 'Contact', consentGranted: true,
      sourceAvailable: true, cryptoKeys: await cryptoKeys(),
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
      consentGranted, sourceAvailable, cryptoKeys: await cryptoKeys(),
      connection: readyConnection('tiktok'),
    })
    expect(plan.deliveries).toEqual([])
  })

  it('Google 的 Contact 和 CompleteRegistration 使用不同 destination', async () => {
    const input = {
      factId: 'fact_google', provider: 'google' as const, consentGranted: true, sourceAvailable: true,
      cryptoKeys: await cryptoKeys(), connection: readyConnection('google'),
    }
    const contact = await buildAttributionDeliveryPlan({ ...input, canonicalEvent: 'Contact' })
    const registration = await buildAttributionDeliveryPlan({ ...input, canonicalEvent: 'CompleteRegistration' })
    const repeated = await buildAttributionDeliveryPlan({ ...input, canonicalEvent: 'Contact' })

    expect(contact.deliveries[0]?.destination).not.toBe(registration.deliveries[0]?.destination)
    expect(contact.deliveries[0]?.browserInstruction).toMatchObject({
      provider: 'google',
      canonicalEvent: 'Contact',
      descriptor: {
        provider: 'google',
        canonicalEvent: 'Contact',
        browserEventName: 'conversion',
        browserDestination: 'AW-123456789/Contact_Label',
        serverDestination: 'customers/123/conversionActions/456',
      },
      payload: {},
    })
    expect(contact.deliveries.length).toBe(repeated.deliveries.length)
  })

  it('未知 provider fail closed', async () => {
    const plan = await buildAttributionDeliveryPlan({
      factId: 'fact_unknown', provider: 'unknown', canonicalEvent: 'Contact', consentGranted: true,
      sourceAvailable: true, cryptoKeys: await cryptoKeys(), connection: readyConnection('meta'),
    })
    expect(plan.deliveries).toEqual([])
  })

  it.each([false, true])('Server 开关为 %s 时按二元状态计划', async serverEnabled => {
    const plan = await buildAttributionDeliveryPlan({
      factId: `fact_server_${serverEnabled}`, provider: 'meta', canonicalEvent: 'Contact',
      consentGranted: true, sourceAvailable: true, cryptoKeys: await cryptoKeys(),
      connection: readyConnection('meta', serverEnabled),
    })
    expect(plan.deliveries.filter(item => item.transport === 'browser')).toHaveLength(1)
    if (serverEnabled) expect(plan.deliveries.filter(item => item.transport === 'server')).toHaveLength(1)
    else expect(plan.deliveries.filter(item => item.transport === 'server')).toHaveLength(0)
  })
})

function readyConnection(provider: 'meta' | 'tiktok' | 'google', serverEnabled = true) {
  const contactBinding = provider === 'google'
    ? { enabled: true, browserDestination: 'AW-123456789/Contact_Label', serverDestination: 'customers/123/conversionActions/456' }
    : { enabled: true, browserDestination: 'contact', serverDestination: 'contact' }
  const registrationBinding = provider === 'google'
    ? { enabled: true, browserDestination: 'AW-123456789/Registration_Label', serverDestination: 'customers/123/conversionActions/789' }
    : { enabled: true, browserDestination: 'registration', serverDestination: 'registration' }
  return {
    state: 'ready' as const,
    connection: {
      id: `conn_${provider}`, provider, enabled: true,
      browserEnabled: true, serverEnabled, outboxScope: 'connection_scope_1',
      publicConfig: {},
    },
    bindings: new Map([
      ['Contact', contactBinding],
      ['CompleteRegistration', registrationBinding],
    ]),
    credential: { type: 'access_token', schemaVersion: 1, revision: 'credential_1' },
  }
}
