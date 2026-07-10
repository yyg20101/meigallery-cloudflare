import type { MetaCapiUserData } from '@meigallery/shared'

const FBP_PATTERN = /^fb\.1\.\d{10,16}\.[A-Za-z0-9._-]{1,128}$/
const FBC_PATTERN = /^fb\.1\.\d{10,16}\.[A-Za-z0-9._-]{1,128}$/
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u
const IP_MAX_LENGTH = 64
const USER_AGENT_MAX_LENGTH = 512

export function normalizeMetaBrowserIdentifiers(value: unknown): Pick<MetaCapiUserData, 'fbp' | 'fbc'> {
  if (!isPlainRecord(value)) return {}
  const fbp = textValue(value.fbp)
  const fbc = textValue(value.fbc)
  return {
    ...(FBP_PATTERN.test(fbp) ? { fbp } : {}),
    ...(FBC_PATTERN.test(fbc) ? { fbc } : {}),
  }
}

export function normalizeMetaCapiUserData(value: unknown): MetaCapiUserData {
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

export function buildMetaCapiUserData(request: Request, bodyIdentifiers: unknown): MetaCapiUserData {
  return normalizeMetaCapiUserData({
    ...normalizeMetaBrowserIdentifiers(bodyIdentifiers),
    clientIpAddress: request.headers.get('CF-Connecting-IP'),
    clientUserAgent: request.headers.get('User-Agent'),
  })
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
