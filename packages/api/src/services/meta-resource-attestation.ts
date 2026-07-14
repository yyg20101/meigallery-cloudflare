import type { Bindings } from '../index'

const COMMIT_PATTERN = /^[0-9a-f]{40}$/i
const NONCE_PATTERN = /^nonce_[0-9a-f]{32,128}$/
const IDENTITY_PATTERN = /^hmac-sha256:[0-9a-f]{64}$/
const ATTESTATION_TTL_MS = 5 * 60 * 1000
const RESOURCE_FIELDS = ['pixel', 'token', 'dataKey'] as const

type AttestationEnvironment = 'dev' | 'production'
type ResourceField = typeof RESOURCE_FIELDS[number]

export type MetaResourceAttestation = {
  schemaVersion: 2
  environment: AttestationEnvironment
  commitSha: string
  nonce: string
  issuedAt: string
  expiresAt: string
  identities: Record<ResourceField, string>
}

export async function createMetaResourceAttestation(input: {
  environment: AttestationEnvironment
  commitSha: string
  nonce: string
  now?: string | number | Date
  pixelId: string
  accessToken: string
  dataKey: string
}): Promise<MetaResourceAttestation> {
  const commitSha = normalizeCommit(input.commitSha)
  const nonce = String(input.nonce || '')
  const issuedAt = new Date(input.now ?? Date.now())
  if (!commitSha) throw new Error('Meta resource attestation commit 非法')
  if (!NONCE_PATTERN.test(nonce)) throw new Error('Meta resource attestation nonce 非法')
  if (!Number.isFinite(issuedAt.getTime())) throw new Error('Meta resource attestation 时间非法')
  if (input.environment !== 'dev' && input.environment !== 'production') throw new Error('Meta resource attestation 环境非法')

  const rawIdentities: Record<ResourceField, string> = {
    pixel: requiredIdentity(input.pixelId, 'Pixel'),
    token: requiredIdentity(input.accessToken, 'token'),
    dataKey: requiredIdentity(input.dataKey, 'data key'),
  }
  const entries = await Promise.all(RESOURCE_FIELDS.map(async field => [
    field,
    await hmacIdentity(rawIdentities[field], field, nonce),
  ] as const))

  return {
    schemaVersion: 2,
    environment: input.environment,
    commitSha,
    nonce,
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + ATTESTATION_TTL_MS).toISOString(),
    identities: Object.fromEntries(entries) as Record<ResourceField, string>,
  }
}

export async function createRuntimeMetaResourceAttestation(
  env: Pick<Bindings, 'DB' | 'APP_ENV' | 'RELEASE_COMMIT' | 'META_CAPI_ACCESS_TOKEN' | 'META_CAPI_DATA_KEY_CURRENT'>,
  nonce: string,
  now?: string | number | Date,
) {
  if (env.APP_ENV !== 'dev' && env.APP_ENV !== 'production') throw new Error('Meta resource attestation 环境非法')
  const connection = await env.DB.prepare("SELECT destination_id FROM ad_platform_connections WHERE provider = 'meta' LIMIT 1")
    .first<{ destination_id: string }>()
  return createMetaResourceAttestation({
    environment: env.APP_ENV,
    commitSha: String(env.RELEASE_COMMIT || ''),
    nonce,
    now,
    pixelId: String(connection?.destination_id || ''),
    accessToken: String(env.META_CAPI_ACCESS_TOKEN || ''),
    dataKey: String(env.META_CAPI_DATA_KEY_CURRENT || ''),
  })
}

export function resourceAttestationsAreIsolated(
  dev: MetaResourceAttestation,
  production: MetaResourceAttestation,
  expected: { nonce: string; commitSha: string; now?: string | number | Date },
) {
  const commitSha = normalizeCommit(expected.commitSha)
  if (!commitSha) throw new Error('Meta resource attestation expected commit 非法')
  assertAttestation(dev, 'dev', expected.nonce, commitSha, expected.now)
  assertAttestation(production, 'production', expected.nonce, commitSha, expected.now)

  const result = Object.fromEntries(RESOURCE_FIELDS.map(field => [
    field,
    dev.identities[field] !== production.identities[field],
  ])) as Record<ResourceField, boolean>
  if (!Object.values(result).every(Boolean)) throw new Error('Meta resource 环境隔离证明失败')
  return result
}

function assertAttestation(
  value: MetaResourceAttestation,
  environment: AttestationEnvironment,
  nonce: string,
  commitSha: string,
  nowValue?: string | number | Date,
) {
  if (!value || value.schemaVersion !== 2 || value.environment !== environment) {
    throw new Error(`Meta resource attestation ${environment} 环境非法`)
  }
  if (value.commitSha !== commitSha) throw new Error(`Meta resource attestation ${environment} commit 不一致`)
  if (value.nonce !== nonce || !NONCE_PATTERN.test(value.nonce)) throw new Error(`Meta resource attestation ${environment} nonce 不一致`)
  const issuedAt = Date.parse(value.issuedAt)
  const expiresAt = Date.parse(value.expiresAt)
  const now = new Date(nowValue ?? Date.now()).getTime()
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt - issuedAt !== ATTESTATION_TTL_MS) {
    throw new Error(`Meta resource attestation ${environment} TTL 非法`)
  }
  if (now < issuedAt || now >= expiresAt) throw new Error(`Meta resource attestation ${environment} 已过期`)
  if (!value.identities || !RESOURCE_FIELDS.every(field => IDENTITY_PATTERN.test(value.identities[field]))) {
    throw new Error(`Meta resource attestation ${environment} 身份摘要非法`)
  }
}

async function hmacIdentity(secret: string, field: ResourceField, nonce: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`meigallery-meta-resource-identity:v1:${field}:${nonce}`),
  )
  return `hmac-sha256:${Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, '0')).join('')}`
}

function requiredIdentity(value: unknown, label: string) {
  const normalized = String(value ?? '')
  if (!normalized || normalized.trim() !== normalized) throw new Error(`Meta resource ${label} 未配置`)
  return normalized
}

function normalizeCommit(value: unknown) {
  const normalized = String(value ?? '').trim().toLowerCase()
  return COMMIT_PATTERN.test(normalized) ? normalized : ''
}
