import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bindings, Variables } from '../index'
import { recordContact } from '../services/conversions'
import { conversionRoutes } from './conversions'

vi.mock('../services/conversions', () => ({
  recordContact: vi.fn(),
}))

const MASTER_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
const recordContactMock = vi.mocked(recordContact)

describe('公开联系转化来源恢复', () => {
  beforeEach(() => {
    recordContactMock.mockReset()
    recordContactMock.mockResolvedValue({
      id: 'fact_contact_1',
      actionType: 'contact',
      created: true,
      duplicateOf: '',
      trackingInstructions: [],
    })
  })

  it('Cookie 缺失时仅从 active 受管链接恢复平台，并忽略客户端 provider', async () => {
    const response = await app().request('/api/conversions/events', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'CF-Connecting-IP': '203.0.113.10',
        'User-Agent': 'unit-test-browser',
      },
      body: JSON.stringify({
        actionType: 'open_link',
        contactMethodId: 'contact_123',
        visitorId: 'visitor_123',
        sessionId: 'session_123',
        trackingSourceSlug: 'ad-meta-team',
        provider: 'tiktok',
      }),
    }, env())

    expect(response.status).toBe(201)
    expect(recordContactMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      attributionContext: expect.objectContaining({
        provider: 'meta',
        source: 'managed_link',
        identifiers: {},
      }),
      attributionSource: 'context',
      adPlatformUserData: {
        clientIpAddress: '203.0.113.10',
        clientUserAgent: 'unit-test-browser',
      },
    }))
  })

  it('跨平台来源信号冲突时保留站内事实但不选择广告平台', async () => {
    const response = await app().request('/api/conversions/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actionType: 'open_link',
        contactMethodId: 'contact_123',
        visitorId: 'visitor_123',
        sessionId: 'session_123',
        trackingSourceSlug: 'ad-meta-team',
        adAttributionSignals: {
          trackingSourceSlug: 'ad-meta-team',
          ttclid: 'tiktok-click',
        },
      }),
    }, env())

    expect(response.status).toBe(201)
    expect(recordContactMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      attributionContext: null,
      attributionSource: 'none',
    }))
  })
})

function app() {
  const instance = new Hono<{ Bindings: Bindings; Variables: Variables }>()
  instance.use('*', async (c, next) => {
    c.set('userId', null)
    c.set('userRole', null)
    await next()
  })
  instance.route('/api/conversions', conversionRoutes)
  return instance
}

function env() {
  return {
    DB: {
      prepare(sql: string) {
        return {
          bind() {
            return {
              async first<T>() {
                if (sql.includes('contact_methods')) {
                  return {
                    id: 'contact_123',
                    platform: 'telegram',
                    value: 'meigallery',
                    link_url: 'https://t.me/meigallery',
                  } as T
                }
                return null
              },
              async all<T>() {
                return {
                  results: sql.includes('analytics_tracking_sources')
                    ? [{ ad_provider: 'meta' } as T]
                    : [],
                }
              },
            }
          },
        }
      },
    } as unknown as D1Database,
    AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT: MASTER_KEY,
  } as unknown as Bindings
}
