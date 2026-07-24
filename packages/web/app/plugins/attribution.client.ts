import type {
  AdAttributionProvider,
  AdBrowserPublicConfig,
  AdBrowserSignal,
  AdConsentSnapshot,
  AttributionBrowserInstructionV1,
  AttributionBusinessEventV1,
} from '@meigallery/shared'
import { digestAttributionContactDestination } from '@meigallery/shared/utils'
import {
  executeBrowserTrackingInstruction,
  initializeBrowserTrackingProvider,
  trackBrowserTrackingSignal,
  teardownBrowserTrackingProviders,
} from '~/adapters/registry.client'
import { hasSensitiveAnalyticsUrl, isAdminPath } from '~/utils/trackingSanitizer'

type BrowserPayload = Record<string, string | number | boolean>
type AttributionEndpoint = '/v1/events/contact' | '/v1/browser-receipts'

export interface AttributionRouteLike {
  path: string
  fullPath: string
  query: Record<string, unknown>
}

export interface AttributionContactInput {
  contactMethodId: string
  methodType: string
  actionType: 'open_link' | 'copy'
  linkUrl: string | null
  value: string
  attributionCapability: string | null
  pagePath: string
}

export interface AttributionActionResult {
  eventId: string
  externalEventId: string
}

export interface PendingAttributionEvent {
  eventId: string
  endpoint: AttributionEndpoint
  body: string
  occurredAt: string
  expiresAt: string
  attemptCount: number
}

interface RuntimeConfig {
  provider: AdAttributionProvider
  publicConfig: AdBrowserPublicConfig
  runtimeLeaseToken: string
  expiresAt: number
}

interface RegistryPort {
  initialize(
    config: AdBrowserPublicConfig,
    consent: AdConsentSnapshot,
  ): Promise<boolean>
  execute(instruction: AttributionBrowserInstructionV1): Promise<boolean>
  signal(
    provider: AdAttributionProvider,
    signal: AdBrowserSignal,
    payload: BrowserPayload,
  ): Promise<boolean>
  teardown(): Promise<void>
}

interface StoragePort {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface AttributionClientDependencies {
  baseUrl: string
  fetch: typeof globalThis.fetch
  registry: RegistryPort
  storage?: StoragePort
  now?: () => Date
  eventId?: () => string
}

const PENDING_STORAGE_KEY = 'meigallery:attribution:pending:v1'
const PENDING_LIFETIME_MS = 24 * 60 * 60 * 1_000
const MAX_PENDING_ATTEMPTS = 5
const MAX_PENDING_EVENTS = 20
const MAX_BODY_LENGTH = 16_384
const PROVIDERS = new Set<AdAttributionProvider>([
  'meta',
  'tiktok',
  'google',
])
const EVENT_ID_PATTERN = /^[A-Za-z0-9:_-]{1,160}$/
const SIGNED_TOKEN_PART_PATTERN = /^[A-Za-z0-9_-]+$/

export function createAttributionBrowserClient(
  dependencies: AttributionClientDependencies,
) {
  const baseUrl = normalizeBaseUrl(dependencies.baseUrl)
  const request = dependencies.fetch
  const registry = dependencies.registry
  const storage = dependencies.storage
  const now = dependencies.now ?? (() => new Date())
  const makeEventId = dependencies.eventId ?? (() => (
    `evt_contact_${crypto.randomUUID().replaceAll('-', '')}`
  ))
  const consumedInstructionTokens = new Set<string>()
  const consumedDeliveryIds = new Set<string>()
  let runtimeConfig: RuntimeConfig | null = null
  let activeConsent: AdConsentSnapshot = deniedConsent()
  let lifecycleQueue: Promise<void> = Promise.resolve()
  let lifecycleVersion = 0
  let lastPageViewKey = ''

  async function start(
    route: AttributionRouteLike,
    consent: AdConsentSnapshot,
  ): Promise<void> {
    activeConsent = consent
    const version = ++lifecycleVersion
    await serializeLifecycle(async () => {
      await flushPending()
      if (
        version !== lifecycleVersion
        || !isAllowedRoute(route.fullPath)
        || consent.marketingAllowed !== true
      ) {
        await resetRuntime()
        return
      }

      const signals = contextSignals(route.query)
      if (signals) {
        const contextResponse = await safeFetch('/v1/context', {
          method: 'PUT',
          body: JSON.stringify({
            ...signals,
            idempotencyKey: makeContextId(),
          }),
        })
        if (!contextResponse?.ok) {
          await resetRuntime()
          return
        }
        // 上下文只通过 HttpOnly Cookie 建立，客户端不得读取或缓存响应体。
      }

      const response = await safeFetch('/v1/runtime-config')
      const config = response?.ok
        ? normalizeRuntimeConfig(await safeJson(response))
        : null
      if (
        version !== lifecycleVersion
        || !config
        || !await registry.initialize(config.publicConfig, consent)
      ) {
        await resetRuntime()
        return
      }

      runtimeConfig = config
      const pageViewKey = `${config.provider}:${route.fullPath}`
      if (lastPageViewKey !== pageViewKey) {
        if (await registry.signal(config.provider, 'PageView', {})) {
          lastPageViewKey = pageViewKey
        }
      }
    })
  }

  async function stop(): Promise<void> {
    lifecycleVersion += 1
    activeConsent = deniedConsent()
    await serializeLifecycle(resetRuntime)
  }

  async function trackSignal(
    signal: AdBrowserSignal,
    payload: BrowserPayload,
  ): Promise<boolean> {
    const config = currentRuntime()
    if (!config) return false
    return registry.signal(config.provider, signal, payload)
  }

  async function trackContact(
    input: AttributionContactInput,
  ): Promise<AttributionActionResult | null> {
    const normalized = normalizeContactInput(input)
    if (!normalized) return null
    const eventId = makeEventId()
    if (!EVENT_ID_PATTERN.test(eventId)) return null
    const occurredAt = trustedNow(now).toISOString()
    const destination = {
      value: normalized.value,
      linkUrl: normalized.linkUrl,
    }
    const destinationDigest = await digestAttributionContactDestination(
      destination,
    )
    const event: AttributionBusinessEventV1 = {
      schemaVersion: 1,
      eventId,
      eventName: 'Contact',
      occurredAt,
      pagePath: normalized.pagePath,
      dedupeKey: `contact:${eventId}`,
      sourceContextToken: null,
      consent: {
        marketingAllowed: activeConsent.marketingAllowed,
        adUserDataAllowed: activeConsent.adUserDataAllowed,
        adPersonalizationAllowed:
          activeConsent.adPersonalizationAllowed,
      },
      payload: {
        contactMethodId: normalized.contactMethodId,
        contactPlatform: normalized.methodType,
        contactAction: normalized.actionType,
      },
    }
    const body = JSON.stringify({
      event,
      attributionCapability: normalized.attributionCapability,
      destination,
      destinationDigest,
      runtimeLeaseToken: currentRuntime()?.runtimeLeaseToken ?? null,
    })
    if (body.length > MAX_BODY_LENGTH) return null

    try {
      const response = await fetchEndpoint('/v1/events/contact', body)
      if (!response.ok) throw new Error('ATTRIBUTION_CONTACT_REJECTED')
      const responseBody = await safeJson(response)
      const instruction = instructionFromContactResponse(responseBody)
      const instructionResult = instruction
        ? await executeInstruction(eventId, instruction)
        : null
      if (instruction && !instructionResult) {
        throw new Error('ATTRIBUTION_BROWSER_INSTRUCTION_REJECTED')
      }
      return {
        eventId,
        externalEventId: instructionResult?.externalEventId ?? '',
      }
    }
    catch {
      savePending({
        eventId,
        endpoint: '/v1/events/contact',
        body,
        occurredAt,
        expiresAt: new Date(
          new Date(occurredAt).getTime() + PENDING_LIFETIME_MS,
        ).toISOString(),
        attemptCount: 1,
      })
      return null
    }
  }

  async function consumeInstructionToken(
    token: string | null | undefined,
  ): Promise<AttributionActionResult | null> {
    if (
      typeof token !== 'string'
      || consumedInstructionTokens.has(token)
    ) {
      return null
    }
    const envelope = decodeInstructionToken(token, trustedNow(now))
    const config = currentRuntime()
    if (
      !envelope
      || !config
      || envelope.instruction.provider !== config.provider
    ) {
      return null
    }

    const result = await executeInstruction(
      envelope.eventId,
      envelope.instruction,
    )
    if (!result) return null
    consumedInstructionTokens.add(token)
    trimSet(consumedInstructionTokens)
    return result
  }

  function exposedState() {
    return {
      provider: currentRuntime()?.provider ?? null,
      active: currentRuntime() !== null,
    }
  }

  async function flushPending(): Promise<void> {
    const pending = readPending()
    if (pending.length === 0) return
    const timestamp = trustedNow(now).getTime()
    const retained: PendingAttributionEvent[] = []
    for (const item of pending) {
      if (
        new Date(item.expiresAt).getTime() <= timestamp
        || item.attemptCount >= MAX_PENDING_ATTEMPTS
      ) {
        continue
      }
      try {
        const response = await fetchEndpoint(item.endpoint, item.body)
        if (!response.ok) throw new Error('ATTRIBUTION_RETRY_REJECTED')
        if (item.endpoint === '/v1/events/contact') {
          const instruction = instructionFromContactResponse(
            await safeJson(response),
          )
          if (
            instruction
            && !await executeInstruction(item.eventId, instruction)
          ) {
            throw new Error('ATTRIBUTION_BROWSER_INSTRUCTION_REJECTED')
          }
        }
      }
      catch {
        retained.push({
          ...item,
          attemptCount: item.attemptCount + 1,
        })
      }
    }
    writePending(retained)
  }

  function savePending(item: PendingAttributionEvent): void {
    if (!storage || !validPendingEvent(item)) return
    const pending = readPending()
      .filter(existing => existing.eventId !== item.eventId
        || existing.endpoint !== item.endpoint)
    pending.push(item)
    writePending(pending.slice(-MAX_PENDING_EVENTS))
  }

  function readPending(): PendingAttributionEvent[] {
    if (!storage) return []
    try {
      const value: unknown = JSON.parse(
        storage.getItem(PENDING_STORAGE_KEY) ?? '[]',
      )
      return Array.isArray(value)
        ? value.filter(validPendingEvent)
        : []
    }
    catch {
      storage.removeItem(PENDING_STORAGE_KEY)
      return []
    }
  }

  function writePending(pending: PendingAttributionEvent[]): void {
    if (!storage) return
    if (pending.length === 0) {
      storage.removeItem(PENDING_STORAGE_KEY)
      return
    }
    storage.setItem(PENDING_STORAGE_KEY, JSON.stringify(pending))
  }

  async function fetchEndpoint(
    endpoint: AttributionEndpoint,
    body: string,
  ): Promise<Response> {
    return request(`${baseUrl}${endpoint}`, {
      method: 'POST',
      credentials: 'include',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body,
    })
  }

  async function executeInstruction(
    eventId: string,
    instruction: AttributionBrowserInstructionV1,
  ): Promise<AttributionActionResult | null> {
    const config = currentRuntime()
    if (
      !config
      || instruction.provider !== config.provider
      || consumedDeliveryIds.has(instruction.deliveryId)
      || !await registry.execute(instruction)
    ) {
      return null
    }
    consumedDeliveryIds.add(instruction.deliveryId)
    trimSet(consumedDeliveryIds)

    const attemptedAt = trustedNow(now).toISOString()
    const receiptBody = JSON.stringify({
      receiptToken: instruction.receiptToken,
      attemptedAt,
    })
    try {
      const response = await fetchEndpoint(
        '/v1/browser-receipts',
        receiptBody,
      )
      if (!response.ok) throw new Error('ATTRIBUTION_RECEIPT_REJECTED')
    }
    catch {
      savePending({
        eventId,
        endpoint: '/v1/browser-receipts',
        body: receiptBody,
        occurredAt: attemptedAt,
        expiresAt: new Date(
          new Date(attemptedAt).getTime() + PENDING_LIFETIME_MS,
        ).toISOString(),
        attemptCount: 1,
      })
    }
    return {
      eventId,
      externalEventId: instruction.externalEventId,
    }
  }

  async function safeFetch(
    endpoint: '/v1/context' | '/v1/runtime-config',
    input: { method?: 'PUT'; body?: string } = {},
  ): Promise<Response | null> {
    try {
      return await request(`${baseUrl}${endpoint}`, {
        method: input.method ?? 'GET',
        credentials: 'include',
        headers: input.body
          ? { 'Content-Type': 'application/json' }
          : undefined,
        body: input.body,
      })
    }
    catch {
      return null
    }
  }

  async function resetRuntime(): Promise<void> {
    runtimeConfig = null
    lastPageViewKey = ''
    await registry.teardown()
  }

  function currentRuntime(): RuntimeConfig | null {
    if (
      !runtimeConfig
      || runtimeConfig.expiresAt <= Math.floor(
        trustedNow(now).getTime() / 1_000,
      )
    ) {
      return null
    }
    return runtimeConfig
  }

  function serializeLifecycle(operation: () => Promise<void>) {
    const task = lifecycleQueue.then(operation, operation)
    lifecycleQueue = task.then(() => undefined, () => undefined)
    return task
  }

  return {
    start,
    stop,
    trackSignal,
    trackContact,
    consumeInstructionToken,
    flushPending,
    exposedState,
  }
}

export type AttributionBrowserClient =
  ReturnType<typeof createAttributionBrowserClient>

export default defineNuxtPlugin((nuxtApp) => {
  const config = useRuntimeConfig()
  const router = useRouter()
  const route = useRoute()
  const consent = useMarketingConsent()
  const client = createAttributionBrowserClient({
    baseUrl: String(config.public.attributionBaseUrl ?? ''),
    fetch: globalThis.fetch.bind(globalThis),
    registry: {
      initialize: initializeBrowserTrackingProvider,
      execute: executeBrowserTrackingInstruction,
      signal: trackBrowserTrackingSignal,
      teardown: teardownBrowserTrackingProviders,
    },
    storage: globalThis.localStorage,
  })

  async function sync(nextRoute: AttributionRouteLike = route) {
    try {
      await consent.refresh()
      await client.start(nextRoute, {
        consentVersion: consent.policyVersion.value || 1,
        marketingAllowed: consent.canTrackMarketing.value,
        adUserDataAllowed: consent.canTrackMarketing.value,
        adPersonalizationAllowed: false,
        decidedAt: new Date().toISOString(),
      })
    }
    catch {
      await client.stop()
    }
  }

  void sync()
  router.afterEach(to => void sync(to as AttributionRouteLike))
  watch(consent.canTrackMarketing, () => void sync())
  globalThis.addEventListener('pagehide', () => {
    void client.stop()
  })

  return {
    provide: {
      attribution: client,
    },
  }
})

function normalizeBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/u, '')
  if (!normalized) return ''
  try {
    const url = new URL(normalized)
    if (
      url.username
      || url.password
      || url.pathname !== '/'
      || url.search
      || url.hash
      || (
        url.protocol !== 'https:'
        && !(
          url.protocol === 'http:'
          && (url.hostname === 'localhost'
            || url.hostname === '127.0.0.1'
            || url.hostname === '[::1]')
        )
      )
    ) {
      return ''
    }
    return url.origin
  }
  catch {
    return ''
  }
}

function contextSignals(query: Record<string, unknown>) {
  const proof = queryValue(query.mg_proof)
  const identifiers = Object.fromEntries(Object.entries({
    fbclid: queryValue(query.fbclid),
    ttclid: queryValue(query.ttclid),
    gclid: queryValue(query.gclid),
    gbraid: queryValue(query.gbraid),
    wbraid: queryValue(query.wbraid),
  }).filter((entry): entry is [string, string] => Boolean(entry[1])))
  if (!proof && !Object.values(identifiers).some(Boolean)) return null
  return {
    ...(proof ? { proof } : {}),
    identifiers,
  }
}

function queryValue(value: unknown): string {
  const raw = Array.isArray(value) ? value[0] : value
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 4_096) {
    return ''
  }
  return raw
}

function makeContextId(): string {
  return `context_request_${crypto.randomUUID().replaceAll('-', '')}`
}

function normalizeRuntimeConfig(value: unknown): RuntimeConfig | null {
  const data = unwrapData(value)
  if (
    !isPlainRecord(data)
    || !hasExactKeys(data, [
      'provider',
      'connectionId',
      'versionId',
      'publicConfig',
      'runtimeLeaseToken',
      'expiresAt',
    ])
    || !PROVIDERS.has(data.provider as AdAttributionProvider)
    || !EVENT_ID_PATTERN.test(String(data.connectionId ?? ''))
    || !EVENT_ID_PATTERN.test(String(data.versionId ?? ''))
    || typeof data.runtimeLeaseToken !== 'string'
    || data.runtimeLeaseToken.length < 16
    || data.runtimeLeaseToken.length > 8_192
    || !Number.isSafeInteger(data.expiresAt)
  ) {
    return null
  }
  const publicConfig = normalizePublicConfig(data.publicConfig)
  if (!publicConfig || publicConfig.provider !== data.provider) return null
  return {
    provider: data.provider as AdAttributionProvider,
    publicConfig,
    runtimeLeaseToken: data.runtimeLeaseToken,
    expiresAt: Number(data.expiresAt),
  }
}

function normalizePublicConfig(value: unknown): AdBrowserPublicConfig | null {
  if (!isPlainRecord(value)) return null
  if (
    value.provider === 'meta'
    && hasExactKeys(value, ['provider', 'pixelId'])
    && typeof value.pixelId === 'string'
    && /^\d{5,30}$/.test(value.pixelId)
  ) {
    return { provider: 'meta', pixelId: value.pixelId }
  }
  if (
    value.provider === 'tiktok'
    && hasExactKeys(value, ['provider', 'pixelCode'])
    && typeof value.pixelCode === 'string'
    && /^[A-Z0-9]{10,30}$/.test(value.pixelCode)
  ) {
    return { provider: 'tiktok', pixelCode: value.pixelCode }
  }
  if (
    value.provider === 'google'
    && hasExactKeys(value, ['provider', 'tagId'])
    && typeof value.tagId === 'string'
    && /^AW-\d{5,20}$/.test(value.tagId)
  ) {
    return { provider: 'google', tagId: value.tagId }
  }
  return null
}

function normalizeContactInput(
  value: AttributionContactInput,
): (
  AttributionContactInput
  & { attributionCapability: string }
) | null {
  if (
    !value
    || !EVENT_ID_PATTERN.test(value.contactMethodId)
    || !safeText(value.methodType, 80)
    || (value.actionType !== 'open_link' && value.actionType !== 'copy')
    || !safeText(value.value, 1_024)
    || (
      value.linkUrl !== null
      && !safeText(value.linkUrl, 2_048)
    )
    || !safePagePath(value.pagePath)
    || typeof value.attributionCapability !== 'string'
    || value.attributionCapability.length < 16
    || value.attributionCapability.length > 4_096
  ) {
    return null
  }
  return {
    ...value,
    attributionCapability: value.attributionCapability,
  }
}

function decodeInstructionToken(
  token: string,
  now: Date,
): {
  eventId: string
  instruction: AttributionBrowserInstructionV1
} | null {
  try {
    if (token.length > 16_384) return null
    const parts = token.split('.')
    if (
      parts.length !== 4
      || parts[0] !== 'v1'
      || !/^[0-9a-f]{32}$/.test(parts[1] ?? '')
      || !SIGNED_TOKEN_PART_PATTERN.test(parts[2] ?? '')
      || !SIGNED_TOKEN_PART_PATTERN.test(parts[3] ?? '')
    ) {
      return null
    }
    const parsed: unknown = JSON.parse(
      decodeBase64Url(parts[2] ?? ''),
    )
    if (
      !isPlainRecord(parsed)
      || !hasExactKeys(parsed, [
        'schemaVersion',
        'eventId',
        'issuedAt',
        'expiresAt',
        'instruction',
      ])
      || parsed.schemaVersion !== 1
      || !EVENT_ID_PATTERN.test(String(parsed.eventId ?? ''))
      || !Number.isSafeInteger(parsed.issuedAt)
      || !Number.isSafeInteger(parsed.expiresAt)
      || Number(parsed.issuedAt) > Math.floor(now.getTime() / 1_000)
      || Number(parsed.expiresAt) <= Math.floor(now.getTime() / 1_000)
    ) {
      return null
    }
    const instruction = normalizeInstruction(parsed.instruction)
    if (!instruction) return null
    return {
      eventId: parsed.eventId as string,
      instruction,
    }
  }
  catch {
    return null
  }
}

function normalizeInstruction(
  value: unknown,
): AttributionBrowserInstructionV1 | null {
  if (
    !isPlainRecord(value)
    || !hasExactKeys(value, [
      'deliveryId',
      'provider',
      'canonicalEvent',
      'schemaVersion',
      'eventName',
      'destination',
      'externalEventId',
      'receiptToken',
      'payload',
    ])
    || value.schemaVersion !== 1
    || !EVENT_ID_PATTERN.test(String(value.deliveryId ?? ''))
    || !PROVIDERS.has(value.provider as AdAttributionProvider)
    || (
      value.canonicalEvent !== 'Contact'
      && value.canonicalEvent !== 'CompleteRegistration'
    )
    || !EVENT_ID_PATTERN.test(String(value.externalEventId ?? ''))
    || typeof value.receiptToken !== 'string'
    || value.receiptToken.length < 16
    || value.receiptToken.length > 8_192
    || !isPlainRecord(value.payload)
    || !safePayload(value.payload)
    || !safeText(value.eventName, 120)
    || !safeText(value.destination, 200)
  ) {
    return null
  }
  return value as unknown as AttributionBrowserInstructionV1
}

function safePayload(value: Record<string, unknown>): boolean {
  return Object.entries(value).every(([key, item]) => (
    key.length > 0
    && key.length <= 80
    && !/(?:email|phone|click|gclid|gbraid|wbraid|fbp|fbc|ttclid|ttp|token)/iu.test(
      key,
    )
    && (
      typeof item === 'boolean'
      || typeof item === 'number'
      || (
        typeof item === 'string'
        && item.length <= 200
        && !/[@\r\n]/u.test(item)
      )
    )
  ))
}

function instructionFromContactResponse(
  value: unknown,
): AttributionBrowserInstructionV1 | null {
  if (!isPlainRecord(value) || value.accepted !== true) return null
  if (value.instruction === null) return null
  return normalizeInstruction(value.instruction)
}

function unwrapData(value: unknown): unknown {
  return isPlainRecord(value) && 'data' in value ? value.data : value
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  }
  catch {
    return null
  }
}

function decodeBase64Url(value: string): string {
  const binary = atob(
    value
      .replaceAll('-', '+')
      .replaceAll('_', '/')
      .padEnd(Math.ceil(value.length / 4) * 4, '='),
  )
  return new TextDecoder('utf-8', { fatal: true }).decode(
    Uint8Array.from(binary, character => character.charCodeAt(0)),
  )
}

function validPendingEvent(value: unknown): value is PendingAttributionEvent {
  if (
    !isPlainRecord(value)
    || !hasExactKeys(value, [
      'eventId',
      'endpoint',
      'body',
      'occurredAt',
      'expiresAt',
      'attemptCount',
    ])
    || !EVENT_ID_PATTERN.test(String(value.eventId ?? ''))
    || (
      value.endpoint !== '/v1/events/contact'
      && value.endpoint !== '/v1/browser-receipts'
    )
    || typeof value.body !== 'string'
    || value.body.length === 0
    || value.body.length > MAX_BODY_LENGTH
    || !canonicalTimestamp(value.occurredAt)
    || !canonicalTimestamp(value.expiresAt)
    || !Number.isSafeInteger(value.attemptCount)
    || Number(value.attemptCount) < 1
    || Number(value.attemptCount) > MAX_PENDING_ATTEMPTS
  ) {
    return false
  }
  const lifetime = new Date(value.expiresAt).getTime()
    - new Date(value.occurredAt).getTime()
  return lifetime > 0 && lifetime <= PENDING_LIFETIME_MS
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64) return false
  const date = new Date(value)
  return Number.isFinite(date.getTime()) && date.toISOString() === value
}

function trustedNow(now: () => Date): Date {
  const value = now()
  if (!Number.isFinite(value.getTime())) {
    throw new Error('ATTRIBUTION_BROWSER_TIME_INVALID')
  }
  return value
}

function isAllowedRoute(fullPath: string): boolean {
  let pathname = fullPath
  try {
    pathname = new URL(fullPath, 'https://site.invalid').pathname
  }
  catch {
    pathname = fullPath.split(/[?#]/u)[0] || fullPath
  }
  return !isAdminPath(pathname) && !hasSensitiveAnalyticsUrl(fullPath)
}

function safePagePath(value: unknown): value is string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 2_048
    || !value.startsWith('/')
    || value.startsWith('//')
    || value.includes('\\')
    || value.includes('#')
    || /\p{Cc}/u.test(value)
  ) {
    return false
  }
  try {
    const base = new URL('https://page.invalid/')
    const resolved = new URL(value, base)
    return resolved.origin === base.origin
      && `${resolved.pathname}${resolved.search}` === value
  }
  catch {
    return false
  }
}

function safeText(value: unknown, maximum: number): value is string {
  return typeof value === 'string'
    && value.trim() === value
    && value.length > 0
    && value.length <= maximum
    && !/\p{Cc}/u.test(value)
}

function deniedConsent(): AdConsentSnapshot {
  return {
    consentVersion: 1,
    marketingAllowed: false,
    adUserDataAllowed: false,
    adPersonalizationAllowed: false,
    decidedAt: new Date(0).toISOString(),
  }
}

function trimSet(values: Set<string>): void {
  while (values.size > 128) {
    const oldest = values.values().next().value
    if (!oldest) return
    values.delete(oldest)
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length
    && keys.every(key => key in value)
}
