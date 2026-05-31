import { assertSafeExternalUrl } from './external-url'

export function isExternalCoverKey(value: unknown) {
  const coverKey = String(value ?? '').trim()
  if (!coverKey) return false

  try {
    const protocol = new URL(coverKey).protocol.toLowerCase()
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return /^https?:/i.test(coverKey)
  }
}

export function safeExternalCoverUrl(value: unknown) {
  if (!isExternalCoverKey(value)) return null

  try {
    return assertSafeExternalUrl(String(value ?? '').trim())
  } catch {
    return null
  }
}

export function resolvePublicCoverUrl(galleryId: string, coverKey: string | null | undefined) {
  const value = String(coverKey ?? '').trim()
  if (!value) return null

  const externalUrl = safeExternalCoverUrl(value)
  if (externalUrl) return externalUrl
  if (isExternalCoverKey(value)) return null

  return `/api/media/cover/${galleryId}`
}
