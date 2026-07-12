import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import {
  createMetaResourceAttestation,
  resourceAttestationsAreIsolated,
} from './meta-resource-attestation'

const NONCE = 'nonce_0123456789abcdef0123456789abcdef'
const COMMIT = 'a'.repeat(40)

describe('Meta resource live HMAC attestation', () => {
  it('同一随机 nonce 下隔离的 dev/prod 身份摘要全部不同，且绑定环境、commit 和短 TTL', async () => {
    const dev = await createMetaResourceAttestation(input('dev', 'dev'))
    const production = await createMetaResourceAttestation(input('production', 'production'))

    expect(dev).toMatchObject({ schemaVersion: 1, environment: 'dev', commitSha: COMMIT, nonce: NONCE })
    expect(Date.parse(dev.expiresAt) - Date.parse(dev.issuedAt)).toBe(5 * 60 * 1000)
    expect(resourceAttestationsAreIsolated(dev, production, { nonce: NONCE, commitSha: COMMIT, now: '2026-07-11T00:01:00.000Z' }))
      .toEqual({ pixel: true, token: true, testEventCode: true, dataKey: true })
    expect(JSON.stringify([dev, production])).not.toContain('dev-token')
    expect(JSON.stringify([dev, production])).not.toContain('production-token')
  })

  it('任一身份复用、nonce/commit/env/TTL 篡改都 fail closed', async () => {
    const dev = await createMetaResourceAttestation(input('dev', 'shared'))
    const production = await createMetaResourceAttestation(input('production', 'shared'))
    expect(() => resourceAttestationsAreIsolated(dev, production, {
      nonce: NONCE,
      commitSha: COMMIT,
      now: '2026-07-11T00:01:00.000Z',
    })).toThrow(/隔离/)

    const isolated = await createMetaResourceAttestation(input('production', 'production'))
    expect(() => resourceAttestationsAreIsolated(dev, { ...isolated, commitSha: 'b'.repeat(40) }, {
      nonce: NONCE,
      commitSha: COMMIT,
      now: '2026-07-11T00:01:00.000Z',
    })).toThrow(/commit/)
    expect(() => resourceAttestationsAreIsolated(dev, isolated, {
      nonce: 'nonce_wrong_0123456789abcdef0123456789',
      commitSha: COMMIT,
      now: '2026-07-11T00:01:00.000Z',
    })).toThrow(/nonce/)
    expect(() => resourceAttestationsAreIsolated(dev, isolated, {
      nonce: NONCE,
      commitSha: COMMIT,
      now: '2026-07-11T00:06:00.000Z',
    })).toThrow(/过期/)
  })
})

function input(environment: 'dev' | 'production', identity: string) {
  return {
    environment,
    commitSha: COMMIT,
    nonce: NONCE,
    now: '2026-07-11T00:00:00.000Z',
    pixelId: identity === 'shared' ? '1234567890' : environment === 'dev' ? '1234567890' : '9988776655',
    accessToken: `${identity}-token`,
    testEventCode: `${identity}-test-code`,
    dataKey: Buffer.alloc(32, identity === 'shared' ? 1 : environment === 'dev' ? 2 : 3).toString('base64'),
  }
}
