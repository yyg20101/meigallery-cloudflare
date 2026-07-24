import { describe, expect, it } from 'vitest'
import {
  ATTRIBUTION_CONTRACT_VERSION,
  isAttributionBusinessEventV1,
  type AttributionBusinessEventV1,
} from './attribution-runtime'

describe('归因运行时共享契约', () => {
  it('只接受版本 1 的两个 Canonical Event', () => {
    const contact: AttributionBusinessEventV1 = {
      schemaVersion: 1,
      eventId: 'evt_01',
      eventName: 'Contact',
      occurredAt: '2026-07-24T00:00:00.000Z',
      dedupeKey: 'contact:s1:telegram:c1',
      sourceContextToken: 'ctx_token',
      consent: {
        marketingAllowed: true,
        adUserDataAllowed: true,
        adPersonalizationAllowed: false,
      },
      payload: {
        contactMethodId: 'c1',
        contactPlatform: 'telegram',
        contactAction: 'open_link',
      },
    }

    expect(ATTRIBUTION_CONTRACT_VERSION).toBe(1)
    expect(isAttributionBusinessEventV1(contact)).toBe(true)
    expect(isAttributionBusinessEventV1({ ...contact, sourceContextToken: null })).toBe(true)
    expect(isAttributionBusinessEventV1({ ...contact, sourceContextToken: 123 })).toBe(false)
    expect(isAttributionBusinessEventV1({ ...contact, eventName: 'PageView' })).toBe(false)
    expect(isAttributionBusinessEventV1({ ...contact, schemaVersion: 2 })).toBe(false)
  })

  it('严格校验 Contact 与 CompleteRegistration 的业务载荷', () => {
    const base = {
      schemaVersion: 1,
      eventId: 'evt_02',
      occurredAt: '2026-07-24T00:00:00.000Z',
      dedupeKey: 'registration:user:1',
      sourceContextToken: null,
      consent: {
        marketingAllowed: true,
        adUserDataAllowed: true,
        adPersonalizationAllowed: true,
      },
    } as const

    expect(isAttributionBusinessEventV1({
      ...base,
      eventName: 'CompleteRegistration',
      payload: { userId: 1, hashedEmail: 'a'.repeat(64) },
    })).toBe(true)
    expect(isAttributionBusinessEventV1({
      ...base,
      eventName: 'CompleteRegistration',
      payload: { userId: 0 },
    })).toBe(false)
    expect(isAttributionBusinessEventV1({
      ...base,
      eventName: 'Contact',
      payload: {
        contactMethodId: 'c1',
        contactPlatform: 'telegram',
        contactAction: 'submit',
      },
    })).toBe(false)
  })
})
