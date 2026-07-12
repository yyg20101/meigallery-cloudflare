const FBP_PATTERN = /^fb\.1\.\d{10,16}\.[A-Za-z0-9._-]{1,128}$/
const FBC_PATTERN = /^fb\.1\.\d{10,16}\.[A-Za-z0-9._-]{1,128}$/
const FBCLID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/

export type MetaBrowserIdentifiers = {
  fbp?: string
  fbc?: string
}

export function readMetaBrowserIdentifiers(cookie: string, fbclid: unknown, now = Date.now()): MetaBrowserIdentifiers {
  const fbp = readCookie(cookie, '_fbp')
  const storedFbc = readCookie(cookie, '_fbc')
  const clickId = firstText(fbclid)
  const generatedFbc = FBCLID_PATTERN.test(clickId) && Number.isFinite(now)
    ? `fb.1.${Math.trunc(now)}.${clickId}`
    : ''

  return {
    ...(FBP_PATTERN.test(fbp) ? { fbp } : {}),
    ...(FBC_PATTERN.test(generatedFbc) ? { fbc: generatedFbc } : FBC_PATTERN.test(storedFbc) ? { fbc: storedFbc } : {}),
  }
}

function readCookie(cookie: string, name: string) {
  for (const item of String(cookie || '').split(';')) {
    const separator = item.indexOf('=')
    if (separator < 0) continue
    if (item.slice(0, separator).trim() === name) return item.slice(separator + 1).trim()
  }
  return ''
}

function firstText(value: unknown) {
  return String(Array.isArray(value) ? value[0] ?? '' : value ?? '')
}
