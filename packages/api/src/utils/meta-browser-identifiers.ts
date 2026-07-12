import type { MetaCapiSensitiveContext } from '@meigallery/shared'

const FBP_PATTERN = /^fb\.1\.\d{10,16}\.[A-Za-z0-9._-]{1,128}$/
const FBC_PATTERN = /^fb\.1\.\d{10,16}\.[A-Za-z0-9._-]{1,128}$/
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u
const IP_MAX_LENGTH = 64
const USER_AGENT_MAX_LENGTH = 512
const IDENTIFIER_ERROR = 'META_CAPI_IDENTIFIER_INVALID'

export function normalizeMetaBrowserIdentifiers(value: unknown): Pick<MetaCapiSensitiveContext, 'fbp' | 'fbc'> {
  if (!isPlainRecord(value)) return {}
  const fbp = textValue(value.fbp)
  const fbc = textValue(value.fbc)
  return {
    ...(FBP_PATTERN.test(fbp) ? { fbp } : {}),
    ...(FBC_PATTERN.test(fbc) ? { fbc } : {}),
  }
}

export function normalizeMetaCapiUserData(value: unknown): MetaCapiSensitiveContext {
  if (!isPlainRecord(value)) return {}
  const identifiers = normalizeMetaBrowserIdentifiers(value)
  const clientIpAddress = safeHeaderValue(value.clientIpAddress, IP_MAX_LENGTH)
  const clientUserAgent = safeHeaderValue(value.clientUserAgent, USER_AGENT_MAX_LENGTH)
  return {
    ...identifiers,
    ...(clientIpAddress ? { clientIpAddress } : {}),
    ...(clientUserAgent ? { clientUserAgent } : {}),
  }
}

export function buildMetaCapiUserData(request: Request, bodyIdentifiers: unknown): MetaCapiSensitiveContext {
  return normalizeMetaCapiUserData({
    ...normalizeMetaBrowserIdentifiers(bodyIdentifiers),
    clientIpAddress: request.headers.get('CF-Connecting-IP'),
    clientUserAgent: request.headers.get('User-Agent'),
  })
}

export async function hashMetaEmail(email: string): Promise<string> {
  try {
    if (typeof email !== 'string') throw new Error(IDENTIFIER_ERROR)
    const normalized = email.trim().toLowerCase()
    if (!normalized) throw new Error(IDENTIFIER_ERROR)
    return await sha256Hex(normalized)
  }
  catch {
    throw new Error(IDENTIFIER_ERROR)
  }
}

export const normalizeAndHashEmail = hashMetaEmail

export async function hashMetaExternalId(externalId: string): Promise<string> {
  try {
    if (typeof externalId !== 'string' || !externalId) throw new Error(IDENTIFIER_ERROR)
    return await sha256Hex(externalId)
  }
  catch {
    throw new Error(IDENTIFIER_ERROR)
  }
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

function safeHeaderValue(value: unknown, maxLength: number) {
  const text = textValue(value)
  return text && text.length <= maxLength && !CONTROL_CHARACTER_PATTERN.test(text) ? text : ''
}

function textValue(value: unknown) {
  return typeof value === 'string' ? value : ''
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
