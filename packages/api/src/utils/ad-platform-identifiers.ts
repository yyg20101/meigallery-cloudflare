import type { AdPlatformSensitiveContext } from '@meigallery/shared'

const FBP_PATTERN = /^fb\.1\.\d{10,16}\.[A-Za-z0-9._-]{1,128}$/
const FBC_PATTERN = /^fb\.1\.\d{10,16}\.[A-Za-z0-9._-]{1,128}$/
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u
const IP_MAX_LENGTH = 45
const USER_AGENT_MAX_LENGTH = 512
const TTCLID_MAX_LENGTH = 1_000
const TTP_MAX_LENGTH = 256
const IDENTIFIER_ERROR = 'AD_PLATFORM_IDENTIFIER_INVALID'

export function normalizeAdPlatformBrowserIdentifiers(
  value: unknown,
): Pick<AdPlatformSensitiveContext, 'fbp' | 'fbc' | 'ttclid' | 'ttp'> {
  if (!isPlainRecord(value)) return {}
  const fbp = textValue(value.fbp)
  const fbc = textValue(value.fbc)
  const ttclid = safeText(value.ttclid, TTCLID_MAX_LENGTH)
  const ttp = safeText(value.ttp, TTP_MAX_LENGTH)
  return {
    ...(FBP_PATTERN.test(fbp) ? { fbp } : {}),
    ...(FBC_PATTERN.test(fbc) ? { fbc } : {}),
    ...(ttclid ? { ttclid } : {}),
    ...(ttp ? { ttp } : {}),
  }
}

export function normalizeAdPlatformUserData(value: unknown): AdPlatformSensitiveContext {
  if (!isPlainRecord(value)) return {}
  const identifiers = normalizeAdPlatformBrowserIdentifiers(value)
  const networkContext = normalizeAdPlatformNetworkContext(value)
  return {
    ...identifiers,
    ...networkContext,
  }
}

export function normalizeAdPlatformNetworkContext(
  value: unknown,
): Pick<AdPlatformSensitiveContext, 'clientIpAddress' | 'clientUserAgent'> {
  if (!isPlainRecord(value)) return {}
  const clientIpAddress = safeText(value.clientIpAddress, IP_MAX_LENGTH)
  const clientUserAgent = safeText(value.clientUserAgent, USER_AGENT_MAX_LENGTH)
  if (!isValidAdPlatformIpAddress(clientIpAddress) || !isValidAdPlatformUserAgent(clientUserAgent)) return {}
  return { clientIpAddress, clientUserAgent }
}

export function buildAdPlatformUserData(request: Request, bodyIdentifiers: unknown): AdPlatformSensitiveContext {
  return normalizeAdPlatformUserData({
    ...normalizeAdPlatformBrowserIdentifiers(bodyIdentifiers),
    clientIpAddress: request.headers.get('CF-Connecting-IP'),
    clientUserAgent: request.headers.get('User-Agent'),
  })
}

/** 请求 Cookie 只在本次归因规划内存中使用，调用方不得写入事实维度。 */
export function readAdPlatformBrowserIdentifiersFromRequest(request: Request) {
  const values = Object.fromEntries(request.headers.get('Cookie')?.split(';').map(item => {
    const separator = item.indexOf('=')
    return separator > 0 ? [item.slice(0, separator).trim(), item.slice(separator + 1).trim()] : []
  }).filter((item): item is [string, string] => item.length === 2) ?? [])
  return normalizeAdPlatformBrowserIdentifiers({
    fbp: values._fbp,
    fbc: values._fbc,
    ttclid: values.ttclid,
    ttp: values._ttp,
  })
}

export async function hashAdPlatformEmail(email: string): Promise<string> {
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

export async function hashAdPlatformExternalId(externalId: string): Promise<string> {
  try {
    if (typeof externalId !== 'string' || !externalId) throw new Error(IDENTIFIER_ERROR)
    return await sha256Hex(externalId)
  }
  catch {
    throw new Error(IDENTIFIER_ERROR)
  }
}

export function isValidAdPlatformIpAddress(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > IP_MAX_LENGTH || CONTROL_CHARACTER_PATTERN.test(value)) return false
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) {
    return value.split('.').every(part => Number(part) >= 0 && Number(part) <= 255)
  }
  if (!value.includes(':') || !/^[0-9A-Fa-f:.]+$/.test(value)) return false
  try {
    return Boolean(new URL(`http://[${value}]/`).hostname)
  }
  catch {
    return false
  }
}

export function isValidAdPlatformUserAgent(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= USER_AGENT_MAX_LENGTH
    && !CONTROL_CHARACTER_PATTERN.test(value)
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

function safeText(value: unknown, maxLength: number) {
  const text = textValue(value)
  return text && text.length <= maxLength && !CONTROL_CHARACTER_PATTERN.test(text) ? text : ''
}

function textValue(value: unknown) {
  return typeof value === 'string' ? value : ''
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
