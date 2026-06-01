import { assertSafeExternalUrl } from './external-url'

export function isExternalMediaKey(value: unknown) {
  const mediaKey = String(value ?? '').trim()
  if (!mediaKey) return false

  try {
    const protocol = new URL(mediaKey).protocol.toLowerCase()
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return /^https?:/i.test(mediaKey)
  }
}

export function safeExternalMediaUrl(value: unknown) {
  if (!isExternalMediaKey(value)) return null

  try {
    return assertSafeExternalUrl(String(value ?? '').trim())
  } catch {
    return null
  }
}

export const isExternalCoverKey = isExternalMediaKey
export const safeExternalCoverUrl = safeExternalMediaUrl

function resolveProxyMediaUrl(proxyPath: string, mediaKey: string | null | undefined) {
  const value = String(mediaKey ?? '').trim()
  if (!value) return null

  const externalUrl = safeExternalMediaUrl(value)
  if (externalUrl) return externalUrl
  if (isExternalMediaKey(value)) return null

  return proxyPath
}

export function resolvePublicCoverUrl(galleryId: string, coverKey: string | null | undefined) {
  return resolveProxyMediaUrl(`/api/media/cover/${galleryId}`, coverKey)
}

export function resolveAdminMediaThumbnailUrl(assetId: string, mediaKey: string | null | undefined) {
  return resolveProxyMediaUrl(`/api/media/${assetId}/thumbnail`, mediaKey)
}
