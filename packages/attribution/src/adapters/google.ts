import type {
  CanonicalConversionEvent,
} from '@meigallery/shared'
import {
  adapterInputInvalid,
  assertBrowserInput,
  assertCandidateBase,
  assertCanonicalBindings,
  assertIdentifierKeys,
  assertProvider,
  assertServerInput,
  deliveryResult,
  exactStringConfig,
  isCanonicalEvent,
  isIdentifier,
  isSafeSecret,
  runtimeFetcher,
  safeRequestId,
  unavailableQuality,
  validationEvidence,
} from './common'
import type {
  AdapterRuntime,
  AttributionProviderAdapter,
  BrowserInstruction,
  BrowserInstructionInput,
  CandidateValidationInput,
  ProviderDeliveryResult,
  QualitySignalInput,
  QualitySignalResult,
  ServerDeliveryInput,
  ValidationEvidence,
} from './types'

const GOOGLE_EVENTS_ENDPOINT =
  'https://datamanager.googleapis.com/v1/events:ingest'
const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/datamanager'
const GOOGLE_IDENTIFIER_KEYS = new Set(['gclid', 'gbraid', 'wbraid'])
const FOREIGN_IDENTIFIER_KEYS = new Set([
  'fbclid',
  'fbc',
  'fbp',
  'ttclid',
  'ttp',
])
const GOOGLE_TAG_PATTERN = /^AW-\d{5,20}$/
const GOOGLE_DESTINATION_PATTERN =
  /^AW-\d{5,20}\/[A-Za-z0-9_-]{1,100}$/
const ACCOUNT_ID_PATTERN = /^\d{1,20}$/
const PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/
const TOKEN_EARLY_REFRESH_MS = 60_000
const tokenCache = new Map<
  string,
  { accessToken: string; expiresAt: number }
>()

interface GoogleServiceAccount {
  type: 'service_account'
  client_email: string
  private_key: string
  token_uri: 'https://oauth2.googleapis.com/token'
}

export type GoogleAccessTokenProvider = (
  credential: string,
  fetcher: typeof fetch,
  now: () => number,
) => Promise<string>

interface GoogleAdapterRuntime extends AdapterRuntime {
  tokenProvider?: GoogleAccessTokenProvider
}

export function createGoogleAdapter(
  runtime: GoogleAdapterRuntime = {},
): AttributionProviderAdapter {
  return {
    provider: 'google',
    eventName,
    activeTarget,
    normalizeTestEventCode,
    validateCandidate,
    buildBrowserInstruction,
    deliverServerEvent,
    readQualitySignal,
  }

  function eventName(event: CanonicalConversionEvent): string {
    if (!isCanonicalEvent(event)) throw adapterInputInvalid()
    return 'conversion'
  }

  function activeTarget(
    publicConfig: Record<string, string>,
  ): string {
    return googleConfig(publicConfig).tagId!
  }

  function normalizeTestEventCode(
    value: unknown,
  ): string | undefined | null {
    return value === undefined || value === null || value === ''
      ? undefined
      : null
  }

  async function validateCandidate(
    input: CandidateValidationInput,
  ): Promise<ValidationEvidence> {
    assertCandidateBase(input, 'google')
    const config = googleConfig(input.publicConfig)
    if (normalizeTestEventCode(input.testEventCode) === null) {
      throw adapterInputInvalid()
    }
    parseServiceAccount(input.credential)
    assertCanonicalBindings(input, binding => {
      return GOOGLE_DESTINATION_PATTERN.test(binding.browserDestination)
        && binding.browserDestination.startsWith(`${config.tagId}/`)
        && ACCOUNT_ID_PATTERN.test(binding.serverDestination)
    })
    if (
      new Set(
        input.bindings.map(binding => binding.browserDestination),
      ).size !== input.bindings.length
      || new Set(
        input.bindings.map(binding => binding.serverDestination),
      ).size !== input.bindings.length
    ) {
      throw adapterInputInvalid()
    }
    return validationEvidence(runtime, input)
  }

  function buildBrowserInstruction(
    input: BrowserInstructionInput,
  ): BrowserInstruction {
    assertBrowserInput(input, 'google')
    if (!GOOGLE_DESTINATION_PATTERN.test(input.destination)) {
      throw adapterInputInvalid()
    }
    return {
      schemaVersion: 1,
      deliveryId: input.deliveryId,
      provider: 'google',
      canonicalEvent: input.canonicalEvent,
      eventName: eventName(input.canonicalEvent),
      destination: input.destination,
      externalEventId: input.externalEventId,
      receiptToken: input.receiptToken,
      payload: {
        send_to: input.destination,
        transaction_id: input.externalEventId,
      },
    }
  }

  async function deliverServerEvent(
    input: ServerDeliveryInput,
  ): Promise<ProviderDeliveryResult> {
    assertServerInput(input, 'google')
    if (normalizeTestEventCode(input.testEventCode) === null) {
      throw adapterInputInvalid()
    }
    const config = googleConfig(input.publicConfig)
    if (!ACCOUNT_ID_PATTERN.test(input.destination)) {
      throw adapterInputInvalid()
    }
    assertIdentifierKeys(
      input.identifiers,
      GOOGLE_IDENTIFIER_KEYS,
      FOREIGN_IDENTIFIER_KEYS,
    )
    if (
      Object.keys(input.identifiers).length === 0
      && !input.hashedEmail
    ) {
      throw adapterInputInvalid()
    }
    const credential = parseServiceAccount(input.credential)
    const fetcher = runtimeFetcher(runtime)

    let accessToken: string
    try {
      accessToken = await (
        runtime.tokenProvider ?? defaultGoogleAccessToken
      )(
        JSON.stringify(credential),
        fetcher,
        () => (runtime.now ?? (() => new Date()))().getTime(),
      )
    } catch (error) {
      return deliveryResult(
        'google',
        googleAuthClassification(error),
      )
    }
    if (!isSafeSecret(accessToken)) {
      return deliveryResult('google', 'credential_invalid')
    }

    const body = googleRequest(input, config)
    let response: Response
    try {
      response = await fetcher(GOOGLE_EVENTS_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'x-goog-user-project': config.cloudProjectId!,
        },
        body: JSON.stringify(body),
      })
    } catch {
      return deliveryResult('google', 'retryable')
    }
    return classifyGoogleResponse(response)
  }

  async function readQualitySignal(
    input: QualitySignalInput,
  ): Promise<QualitySignalResult> {
    assertProvider(input?.provider, 'google')
    if (
      !isIdentifier(input.connectionId)
      || !isIdentifier(input.versionId)
      || !isSafeSecret(input.credential)
    ) {
      throw adapterInputInvalid()
    }
    googleConfig(input.publicConfig)
    parseServiceAccount(input.credential)
    return unavailableQuality(
      runtime,
      'google',
      'delivery_diagnostics_only',
    )
  }
}

export const googleAdapter = createGoogleAdapter()

function googleConfig(value: unknown): Record<string, string> {
  return exactStringConfig(value, {
    tagId: GOOGLE_TAG_PATTERN,
    customerId: ACCOUNT_ID_PATTERN,
    cloudProjectId: PROJECT_ID_PATTERN,
  }, {
    loginCustomerId: ACCOUNT_ID_PATTERN,
  })
}

function googleRequest(
  input: ServerDeliveryInput,
  config: Record<string, string>,
): Record<string, unknown> {
  const event = {
    eventTimestamp: input.occurredAt,
    transactionId: input.externalEventId,
    eventSource: 'WEB',
    adIdentifiers: Object.fromEntries(
      Object.entries(input.identifiers)
        .filter(([key]) => GOOGLE_IDENTIFIER_KEYS.has(key)),
    ),
    ...(input.hashedEmail
      ? {
          userData: {
            userIdentifiers: [{
              emailAddress: input.hashedEmail,
            }],
          },
        }
      : {}),
  }
  return {
    validateOnly: input.validateOnly,
    ...(input.hashedEmail ? { encoding: 'HEX' } : {}),
    consent: {
      adUserData: 'CONSENT_GRANTED',
      adPersonalization: input.consent.adPersonalizationAllowed
        ? 'CONSENT_GRANTED'
        : 'CONSENT_DENIED',
    },
    destinations: [{
      operatingAccount: {
        accountType: 'GOOGLE_ADS',
        accountId: config.customerId,
      },
      ...(config.loginCustomerId
        ? {
            loginAccount: {
              accountType: 'GOOGLE_ADS',
              accountId: config.loginCustomerId,
            },
          }
        : {}),
      productDestinationId: input.destination,
    }],
    events: [event],
  }
}

async function classifyGoogleResponse(
  response: Response,
): Promise<ProviderDeliveryResult> {
  const requestId = await googleRequestId(response)
  const details = { requestId }
  if (response.ok) {
    return requestId
      ? deliveryResult('google', 'accepted', response, details)
      : deliveryResult('google', 'retryable', response)
  }
  if (response.status === 401 || response.status === 403) {
    return deliveryResult(
      'google',
      'credential_invalid',
      response,
      details,
    )
  }
  if (response.status === 429 || response.status >= 500) {
    return deliveryResult('google', 'retryable', response, details)
  }
  if (
    response.status === 400
    || response.status === 404
    || response.status === 422
  ) {
    return deliveryResult(
      'google',
      'destination_invalid',
      response,
      details,
    )
  }
  return deliveryResult('google', 'rejected', response, details)
}

async function googleRequestId(response: Response): Promise<string> {
  try {
    const value = await response.clone().json() as Record<string, unknown>
    return safeRequestId(value.requestId)
  } catch {
    return ''
  }
}

async function defaultGoogleAccessToken(
  credential: string,
  fetcher: typeof fetch,
  now: () => number,
): Promise<string> {
  const serviceAccount = parseServiceAccount(credential)
  const cacheKey = await credentialCacheKey(serviceAccount)
  const current = validNowMilliseconds(now)
  const cached = tokenCache.get(cacheKey)
  if (
    cached
    && current < cached.expiresAt - TOKEN_EARLY_REFRESH_MS
  ) {
    return cached.accessToken
  }

  const assertion = await serviceAccountJwt(serviceAccount, current)
  let response: Response
  try {
    response = await fetcher(serviceAccount.token_uri, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
    })
  } catch {
    throw new GoogleTokenError('retryable')
  }
  if (!response.ok) {
    throw new GoogleTokenError(
      response.status === 400
      || response.status === 401
      || response.status === 403
        ? 'credential_invalid'
        : response.status === 429 || response.status >= 500
          ? 'retryable'
          : 'rejected',
    )
  }

  let body: Record<string, unknown>
  try {
    body = await response.json() as Record<string, unknown>
  } catch {
    throw new GoogleTokenError('rejected')
  }
  if (
    !isSafeSecret(body.access_token)
    || !Number.isFinite(body.expires_in)
    || Number(body.expires_in) <= 60
  ) {
    throw new GoogleTokenError('rejected')
  }
  tokenCache.set(cacheKey, {
    accessToken: body.access_token,
    expiresAt: current + Number(body.expires_in) * 1_000,
  })
  return body.access_token
}

async function serviceAccountJwt(
  credential: GoogleServiceAccount,
  now: number,
): Promise<string> {
  const issuedAt = Math.floor(now / 1_000)
  const header = base64UrlText(JSON.stringify({
    alg: 'RS256',
    typ: 'JWT',
  }))
  const claims = base64UrlText(JSON.stringify({
    iss: credential.client_email,
    scope: GOOGLE_SCOPE,
    aud: credential.token_uri,
    iat: issuedAt,
    exp: issuedAt + 3_600,
  }))
  try {
    const key = await crypto.subtle.importKey(
      'pkcs8',
      pemBytes(credential.private_key),
      {
        name: 'RSASSA-PKCS1-v1_5',
        hash: 'SHA-256',
      },
      false,
      ['sign'],
    )
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      key,
      new TextEncoder().encode(`${header}.${claims}`),
    )
    return `${header}.${claims}.${base64UrlBytes(
      new Uint8Array(signature),
    )}`
  } catch {
    throw new GoogleTokenError('credential_invalid')
  }
}

function parseServiceAccount(value: string): GoogleServiceAccount {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw adapterInputInvalid()
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw adapterInputInvalid()
  }
  const item = parsed as Record<string, unknown>
  if (
    item.type !== 'service_account'
    || typeof item.client_email !== 'string'
    || !/^[a-z0-9][a-z0-9._-]*@[a-z0-9][a-z0-9-]*\.iam\.gserviceaccount\.com$/
      .test(item.client_email)
    || typeof item.private_key !== 'string'
    || !/^-----BEGIN PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PRIVATE KEY-----\s*$/
      .test(item.private_key)
    || item.token_uri !== 'https://oauth2.googleapis.com/token'
  ) {
    throw adapterInputInvalid()
  }
  return {
    type: 'service_account',
    client_email: item.client_email,
    private_key: item.private_key,
    token_uri: item.token_uri,
  }
}

async function credentialCacheKey(
  credential: GoogleServiceAccount,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode([
      credential.client_email,
      credential.token_uri,
      credential.private_key,
    ].join('\n')),
  )
  return base64UrlBytes(new Uint8Array(digest))
}

function pemBytes(value: string): Uint8Array {
  const match = /^-----BEGIN PRIVATE KEY-----\r?\n([A-Za-z0-9+/=\r\n]+)-----END PRIVATE KEY-----\s*$/
    .exec(value)
  if (!match?.[1]) throw new GoogleTokenError('credential_invalid')
  try {
    return Uint8Array.from(
      atob(match[1].replace(/\s/g, '')),
      character => character.charCodeAt(0),
    )
  } catch {
    throw new GoogleTokenError('credential_invalid')
  }
}

function base64UrlText(value: string): string {
  return base64UrlBytes(new TextEncoder().encode(value))
}

function base64UrlBytes(value: Uint8Array): string {
  return btoa(
    Array.from(value, byte => String.fromCharCode(byte)).join(''),
  )
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function validNowMilliseconds(now: () => number): number {
  const value = now()
  if (!Number.isFinite(value) || value <= 0) {
    throw new GoogleTokenError('retryable')
  }
  return value
}

function googleAuthClassification(
  error: unknown,
): 'credential_invalid' | 'retryable' | 'rejected' {
  return error instanceof GoogleTokenError
    ? error.classification
    : 'retryable'
}

class GoogleTokenError extends Error {
  constructor(
    readonly classification:
      | 'credential_invalid'
      | 'retryable'
      | 'rejected',
  ) {
    super('google_token_error')
    this.name = 'GoogleTokenError'
  }
}

export function clearGoogleTokenCacheForTests(): void {
  tokenCache.clear()
}
