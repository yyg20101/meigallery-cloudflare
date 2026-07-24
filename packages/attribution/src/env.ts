export type AttributionAppEnvironment = 'production' | 'dev' | 'local'

export interface AttributionBindings {
  DB: D1Database
  APP_ENV: AttributionAppEnvironment
  ATTRIBUTION_PUBLIC_ORIGINS: string
  ATTRIBUTION_COOKIE_DOMAIN: string
  ATTRIBUTION_CREDENTIAL_MASTER_KEY_CURRENT: string
  ATTRIBUTION_CREDENTIAL_MASTER_KEY_PREVIOUS?: string
  ATTRIBUTION_SIGNING_KEY: string
}

export interface AttributionEnvironment {
  appEnvironment: AttributionAppEnvironment
  publicOrigins: readonly string[]
  cookieDomain: string | null
  credentialMasterKeyCurrent: string
  credentialMasterKeyPrevious: string | null
  signingKey: string
}

const APP_ENVIRONMENTS = new Set<AttributionAppEnvironment>([
  'production',
  'dev',
  'local',
])

function requireValue(value: string | undefined, name: string): string {
  const normalized = value?.trim()
  if (!normalized) {
    throw new Error(`${name}_REQUIRED`)
  }
  return normalized
}

function parsePublicOrigins(value: string): readonly string[] {
  const values = value
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean)

  if (values.length === 0) {
    throw new Error('ATTRIBUTION_PUBLIC_ORIGINS_REQUIRED')
  }

  const origins = values.map((value) => {
    if (value.includes('*')) {
      throw new Error('ATTRIBUTION_PUBLIC_ORIGIN_WILDCARD_FORBIDDEN')
    }

    let url: URL
    try {
      url = new URL(value)
    } catch {
      throw new Error('ATTRIBUTION_PUBLIC_ORIGIN_INVALID')
    }

    if (
      !['http:', 'https:'].includes(url.protocol)
      || url.username
      || url.password
      || url.pathname !== '/'
      || url.search
      || url.hash
    ) {
      throw new Error('ATTRIBUTION_PUBLIC_ORIGIN_INVALID')
    }

    return url.origin
  })

  return [...new Set(origins)]
}

function parseCookieDomain(
  value: string,
  appEnvironment: AttributionAppEnvironment,
): string | null {
  const normalized = value.trim().toLowerCase()
  if (!normalized) {
    if (appEnvironment === 'production') {
      throw new Error('ATTRIBUTION_COOKIE_DOMAIN_REQUIRED')
    }
    return null
  }

  const hostname = normalized.startsWith('.') ? normalized.slice(1) : normalized
  if (
    !hostname.includes('.')
    || hostname.includes('*')
    || hostname.includes('/')
    || hostname.includes(':')
    || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(hostname)
  ) {
    throw new Error('ATTRIBUTION_COOKIE_DOMAIN_INVALID')
  }

  return `.${hostname}`
}

export function parseAttributionEnvironment(
  bindings: AttributionBindings,
): AttributionEnvironment {
  if (!APP_ENVIRONMENTS.has(bindings.APP_ENV)) {
    throw new Error('APP_ENV_INVALID')
  }
  if (!bindings.DB) {
    throw new Error('DB_REQUIRED')
  }

  return {
    appEnvironment: bindings.APP_ENV,
    publicOrigins: parsePublicOrigins(bindings.ATTRIBUTION_PUBLIC_ORIGINS),
    cookieDomain: parseCookieDomain(
      bindings.ATTRIBUTION_COOKIE_DOMAIN,
      bindings.APP_ENV,
    ),
    credentialMasterKeyCurrent: requireValue(
      bindings.ATTRIBUTION_CREDENTIAL_MASTER_KEY_CURRENT,
      'ATTRIBUTION_CREDENTIAL_MASTER_KEY_CURRENT',
    ),
    credentialMasterKeyPrevious:
      bindings.ATTRIBUTION_CREDENTIAL_MASTER_KEY_PREVIOUS?.trim() || null,
    signingKey: requireValue(
      bindings.ATTRIBUTION_SIGNING_KEY,
      'ATTRIBUTION_SIGNING_KEY',
    ),
  }
}
