export type ImportPermission = 'gallery:create' | 'testimonial:create'

export function createImportToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  const binary = Array.from(bytes, byte => String.fromCharCode(byte)).join('')
  const base64 = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
  return `mgi_${base64}`
}

export async function hashImportToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export function parseJsonStringArray(value: string | null | undefined): string[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : []
  } catch {
    return []
  }
}

export function hasImportPermission(permissionsJson: string, permission: ImportPermission): boolean {
  return parseJsonStringArray(permissionsJson).includes(permission)
}

export function isSourceBotAllowed(allowedSourceBotKeysJson: string, sourceBotKey: string): boolean {
  return parseJsonStringArray(allowedSourceBotKeysJson).includes(sourceBotKey)
}

export function isImportTokenExpired(expiresAt: string | null, now = new Date()): boolean {
  if (!expiresAt) return false
  const expiresAtTime = new Date(expiresAt).getTime()
  if (Number.isNaN(expiresAtTime)) return true
  return expiresAtTime <= now.getTime()
}
