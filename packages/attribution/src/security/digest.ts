const encoder = new TextEncoder()

export async function sha256Hex(value: string): Promise<string> {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('ATTRIBUTION_DIGEST_INPUT_INVALID')
  }
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value))
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
}
