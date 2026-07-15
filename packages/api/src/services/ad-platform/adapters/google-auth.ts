const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/datamanager'
const EARLY_REFRESH_MS = 60_000
const TOKEN_CACHE = new Map<string, { accessToken: string; expiresAt: number }>()

export interface GoogleServiceAccount {
  type: 'service_account'
  client_email: string
  private_key: string
  token_uri: string
}

export class GoogleAuthError extends Error {
  constructor(readonly classification: 'retryable' | 'credential_invalid' | 'rejected') {
    super('google_auth_failed')
    this.name = 'GoogleAuthError'
  }
}

export async function createGoogleServiceAccountJwt(credential: GoogleServiceAccount, now = Date.now()): Promise<string> {
  const serviceAccount = validateServiceAccount(credential)
  const issuedAt = Math.floor(now / 1_000)
  const encodedHeader = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const encodedClaims = base64Url(JSON.stringify({
    iss: serviceAccount.client_email, scope: GOOGLE_SCOPE, aud: serviceAccount.token_uri, iat: issuedAt, exp: issuedAt + 3_600,
  }))
  try {
    const signature = await crypto.subtle.sign(
      { name: 'RSASSA-PKCS1-v1_5' },
      await crypto.subtle.importKey('pkcs8', pemBytes(serviceAccount.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']),
      new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`),
    )
    return `${encodedHeader}.${encodedClaims}.${base64UrlBytes(new Uint8Array(signature))}`
  }
  catch {
    throw new GoogleAuthError('credential_invalid')
  }
}

export async function getGoogleAccessToken(input: { credential: GoogleServiceAccount; fetcher?: typeof fetch; now?: () => number }): Promise<string> {
  const now = input.now ?? Date.now
  const credential = validateServiceAccount(input.credential)
  const cacheKey = await serviceAccountCacheKey(credential)
  const cached = TOKEN_CACHE.get(cacheKey)
  if (cached && now() < cached.expiresAt - EARLY_REFRESH_MS) return cached.accessToken
  const assertion = await createGoogleServiceAccountJwt(credential, now())
  let response: Response
  try {
    response = await (input.fetcher ?? fetch)(credential.token_uri, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
    })
  }
  catch {
    throw new GoogleAuthError('retryable')
  }
  if (!response.ok) throw new GoogleAuthError(response.status === 401 || response.status === 403 || response.status === 400 ? 'credential_invalid' : response.status === 429 || response.status >= 500 ? 'retryable' : 'rejected')
  let parsed: { access_token?: unknown; expires_in?: unknown }
  try { parsed = await response.json() } catch { throw new GoogleAuthError('rejected') }
  if (typeof parsed.access_token !== 'string' || !parsed.access_token.trim() || !Number.isFinite(parsed.expires_in) || Number(parsed.expires_in) <= 60) throw new GoogleAuthError('rejected')
  TOKEN_CACHE.set(cacheKey, { accessToken: parsed.access_token, expiresAt: now() + Number(parsed.expires_in) * 1_000 })
  return parsed.access_token
}

export function parseGoogleServiceAccount(value: string): GoogleServiceAccount {
  try { return validateServiceAccount(JSON.parse(value)) } catch (error) { if (error instanceof GoogleAuthError) throw error; throw new GoogleAuthError('credential_invalid') }
}

export function clearGoogleAccessTokenCacheForTests() { TOKEN_CACHE.clear() }

function validateServiceAccount(value: unknown): GoogleServiceAccount {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GoogleAuthError('credential_invalid')
  const record = value as Record<string, unknown>
  if (record.type !== 'service_account' || !validEmail(record.client_email) || typeof record.private_key !== 'string' || !record.private_key.includes('-----BEGIN PRIVATE KEY-----') || !validTokenUri(record.token_uri)) throw new GoogleAuthError('credential_invalid')
  return { type: 'service_account', client_email: record.client_email, private_key: record.private_key, token_uri: record.token_uri }
}
async function serviceAccountCacheKey(credential: GoogleServiceAccount) { const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${credential.client_email}\n${credential.token_uri}\n${credential.private_key}`))); return base64UrlBytes(digest) }
function validEmail(value: unknown): value is string { return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]*@[a-z0-9][a-z0-9-]*\.iam\.gserviceaccount\.com$/.test(value) }
function validTokenUri(value: unknown): value is string { return value === 'https://oauth2.googleapis.com/token' }
function pemBytes(value: string) { const match = /^-----BEGIN PRIVATE KEY-----\r?\n([A-Za-z0-9+/=\r\n]+)-----END PRIVATE KEY-----\s*$/.exec(value); if (!match?.[1]) throw new GoogleAuthError('credential_invalid'); const body = match[1].replace(/\s/g, ''); try { return Uint8Array.from(atob(body), item => item.charCodeAt(0)) } catch { throw new GoogleAuthError('credential_invalid') } }
function base64Url(value: string) { return base64UrlBytes(new TextEncoder().encode(value)) }
function base64UrlBytes(value: Uint8Array) { return btoa(Array.from(value, item => String.fromCharCode(item)).join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '') }
