import { describe, expect, it } from 'vitest'
import {
  resolveAttributionRoute,
  type AttributionRouteCandidate,
  type AttributionRoutingRepository,
} from './routing'

function repository(input: {
  managed?: Record<string, AttributionRouteCandidate>
  contexts?: Record<string, AttributionRouteCandidate>
  eligible?: Record<string, string[]>
  incidents?: string[]
} = {}): AttributionRoutingRepository {
  return {
    async resolveManagedSource(proof) {
      return input.managed?.[proof] ?? null
    },
    async resolveFirstPartyContext(token) {
      return input.contexts?.[token] ?? null
    },
    async listEligibleConnections(provider) {
      return input.eligible?.[provider] ?? []
    },
    async recordRoutingIncident(incident) {
      input.incidents?.push(incident.code)
    },
  }
}

describe('严格归因路由', () => {
  const routes = repository({
    managed: {
      'proof-a': { provider: 'meta', connectionId: 'conn_meta_a' },
      'proof-b': { provider: 'meta', connectionId: 'conn_meta_b' },
      'proof-tiktok': {
        provider: 'tiktok',
        connectionId: 'conn_tiktok_a',
      },
      'proof-google': {
        provider: 'google',
        connectionId: 'conn_google_a',
      },
    },
  })

  it.each([
    ['meta proof A', { proof: 'proof-a' }, 'conn_meta_a'],
    ['meta proof B', { proof: 'proof-b' }, 'conn_meta_b'],
    ['tiktok proof', { proof: 'proof-tiktok' }, 'conn_tiktok_a'],
    ['google proof', { proof: 'proof-google' }, 'conn_google_a'],
    ['direct', {}, null],
  ])('%s', async (_name, signals, expected) => {
    expect(
      (await resolveAttributionRoute(routes, signals)).connectionId,
    ).toBe(expected)
  })

  it('有效第一方上下文优先于互相冲突的 click ID', async () => {
    const result = await resolveAttributionRoute(repository({
      contexts: {
        context_meta: {
          provider: 'meta',
          connectionId: 'conn_meta_a',
        },
      },
    }), {
      contextToken: 'context_meta',
      identifiers: {
        fbclid: 'fb-click',
        ttclid: 'tt-click',
      },
    })

    expect(result).toEqual({
      resolution: 'resolved',
      provider: 'meta',
      connectionId: 'conn_meta_a',
      incidentCode: null,
    })
  })

  it('多连接只有 click ID 时不猜测', async () => {
    const incidents: string[] = []
    const result = await resolveAttributionRoute(repository({
      eligible: { meta: ['conn_meta_a', 'conn_meta_b'] },
      incidents,
    }), {
      identifiers: { fbclid: 'fb-click' },
    })

    expect(result).toEqual({
      resolution: 'ambiguous',
      provider: 'meta',
      connectionId: null,
      incidentCode: 'ATTRIBUTION_CONNECTION_AMBIGUOUS',
    })
    expect(incidents).toEqual(['ATTRIBUTION_CONNECTION_AMBIGUOUS'])
  })

  it('多个平台 click ID 冲突时零路由', async () => {
    const incidents: string[] = []
    const result = await resolveAttributionRoute(repository({
      eligible: {
        meta: ['conn_meta_a'],
        tiktok: ['conn_tiktok_a'],
      },
      incidents,
    }), {
      identifiers: {
        fbclid: 'fb-click',
        ttclid: 'tt-click',
      },
    })

    expect(result).toEqual({
      resolution: 'conflict',
      provider: null,
      connectionId: null,
      incidentCode: 'ATTRIBUTION_PROVIDER_CONFLICT',
    })
    expect(incidents).toEqual(['ATTRIBUTION_PROVIDER_CONFLICT'])
  })

  it.each(['facebook', 'meta', 'tiktok', 'google'])(
    '普通 utm_source=%s 无权声明 provider',
    async (utmSource) => {
      const result = await resolveAttributionRoute(repository({
        eligible: {
          meta: ['conn_meta_a'],
          tiktok: ['conn_tiktok_a'],
          google: ['conn_google_a'],
        },
      }), { utmSource })

      expect(result).toEqual({
        resolution: 'none',
        provider: null,
        connectionId: null,
        incidentCode: null,
      })
    },
  )
})
