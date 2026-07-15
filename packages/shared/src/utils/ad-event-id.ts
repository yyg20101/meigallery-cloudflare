import type { CanonicalConversionEvent } from '../types/ad-attribution'

export async function buildAdExternalEventId(
  secret: string,
  factId: string,
  event: CanonicalConversionEvent,
) {
  if (!secret.trim() || !factId.trim()) throw new Error('AD_EVENT_ID_INPUT_INVALID')

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return buildAdExternalEventIdFromKey(key, factId, event)
}

/** 仅接受不可导出的 HMAC key，供归因派生密钥生成稳定事件 ID。 */
export async function buildAdExternalEventIdFromKey(
  key: CryptoKey,
  factId: string,
  event: CanonicalConversionEvent,
) {
  if (!factId.trim()) throw new Error('AD_EVENT_ID_INPUT_INVALID')
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`v3:${event}:${factId}`))
  return `mg3_${base64Url(new Uint8Array(digest)).slice(0, 43)}`
}

function base64Url(bytes: Uint8Array) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}
