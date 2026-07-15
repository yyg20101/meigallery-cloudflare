import { describe, expect, it, vi } from 'vitest'
import { clearGoogleAccessTokenCacheForTests, createGoogleServiceAccountJwt, getGoogleAccessToken } from './google-auth'

describe('Google Service Account 鉴权', () => {
  it('使用 RS256 签发 aud=token_uri 且 scope 固定的 JWT', async () => {
    const credential = await serviceAccount()
    const jwt = await createGoogleServiceAccountJwt(credential, 1_784_256_123_000)
    const [header, claims, signature] = jwt.split('.')
    expect(JSON.parse(decode(header!))).toEqual({ alg: 'RS256', typ: 'JWT' })
    expect(JSON.parse(decode(claims!))).toEqual({ iss: credential.client_email, scope: 'https://www.googleapis.com/auth/datamanager', aud: credential.token_uri, iat: 1_784_256_123, exp: 1_784_259_723 })
    const publicKey = await crypto.subtle.importKey('spki', pemBytes(credential.public_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
    expect(await crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, publicKey, base64UrlBytes(signature!), new TextEncoder().encode(`${header}.${claims}`))).toBe(true)
  })

  it('仅在隔离内存缓存 access token，并提前 60 秒刷新', async () => {
    clearGoogleAccessTokenCacheForTests()
    const credential = await serviceAccount()
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ access_token: 'token-not-logged', expires_in: 120 }), { status: 200 }))
    await expect(getGoogleAccessToken({ credential, fetcher, now: () => 1_000_000 })).resolves.toBe('token-not-logged')
    await expect(getGoogleAccessToken({ credential, fetcher, now: () => 1_050_000 })).resolves.toBe('token-not-logged')
    await expect(getGoogleAccessToken({ credential, fetcher, now: () => 1_061_000 })).resolves.toBe('token-not-logged')
    expect(fetcher).toHaveBeenCalledTimes(2)
    const [url, init] = fetcher.mock.calls[0]!
    expect(url).toBe(credential.token_uri)
    expect(String(init?.body)).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer')
    expect(String(init?.body)).toContain('assertion=')
  })
})

async function serviceAccount() {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])
  return {
    type: 'service_account', client_email: 'adapter-test@project.iam.gserviceaccount.com', token_uri: 'https://oauth2.googleapis.com/token',
    private_key: pem('PRIVATE KEY', new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))),
    public_key: pem('PUBLIC KEY', new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey))),
  }
}
function pem(label: string, bytes: Uint8Array) { return `-----BEGIN ${label}-----\n${btoa(String.fromCharCode(...bytes)).replace(/(.{64})/g, '$1\n')}\n-----END ${label}-----\n` }
function pemBytes(value: string) { return Uint8Array.from(atob(value.replace(/-----(?:BEGIN|END) PUBLIC KEY-----|\s/g, '')), item => item.charCodeAt(0)) }
function base64UrlBytes(value: string) { return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')), item => item.charCodeAt(0)) }
function decode(value: string) { return new TextDecoder().decode(base64UrlBytes(value)) }
