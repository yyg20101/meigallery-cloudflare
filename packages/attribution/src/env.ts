import type { AttributionProvider } from '@meigallery/shared'
import type { AttributionQueueMessage } from './domain/queue'
import { isAllowedAttributionOrigin } from './domain/origin-policy'
import type { AttributionEncryptionKeys } from './security/data-envelope'
import type { AttributionSigningKeys } from './security/signed-token'

export type AttributionAppEnvironment = 'production' | 'dev' | 'local'

export interface AttributionBindings {
  DB: D1Database
  APP_ENV: AttributionAppEnvironment
  ATTRIBUTION_PUBLIC_ORIGINS: string
  ATTRIBUTION_COOKIE_DOMAIN: string
  ATTRIBUTION_CREDENTIAL_MASTER_KEY_CURRENT: string
  ATTRIBUTION_CREDENTIAL_MASTER_KEY_PREVIOUS?: string
  ATTRIBUTION_SIGNING_KEY_CURRENT: string
  ATTRIBUTION_SIGNING_KEY_PREVIOUS?: string
  ATTRIBUTION_DATA_ENCRYPTION_KEY_CURRENT: string
  ATTRIBUTION_DATA_ENCRYPTION_KEY_PREVIOUS?: string
  META_QUEUE: Queue<AttributionQueueMessage>
  TIKTOK_QUEUE: Queue<AttributionQueueMessage>
  GOOGLE_QUEUE: Queue<AttributionQueueMessage>
}

export interface AttributionEnvironment {
  appEnvironment: AttributionAppEnvironment
  publicOrigins: readonly string[]
  cookieDomain: string | null
  credentialMasterKeys: AttributionEncryptionKeys
  signingKeys: AttributionSigningKeys
  dataEncryptionKeys: AttributionEncryptionKeys
  queues: Readonly<
    Record<AttributionProvider, Queue<AttributionQueueMessage>>
  >
}

const APP_ENVIRONMENTS = new Set<AttributionAppEnvironment>([
  'production',
  'dev',
  'local',
])

const encoder = new TextEncoder()

function requireSecret(value: string | undefined, name: string): string {
  const normalized = value?.trim()
  if (!normalized) {
    throw new Error(`${name}_REQUIRED`)
  }
  if (encoder.encode(normalized).byteLength < 32 || normalized.length > 4096) {
    throw new Error(`${name}_INVALID`)
  }
  return normalized
}

function optionalSecret(
  value: string | undefined,
  name: string,
): string | undefined {
  const normalized = value?.trim()
  if (!normalized) return undefined
  if (encoder.encode(normalized).byteLength < 32 || normalized.length > 4096) {
    throw new Error(`${name}_INVALID`)
  }
  return normalized
}

function parsePublicOrigins(
  value: string,
  appEnvironment: AttributionAppEnvironment,
): readonly string[] {
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
      !isAllowedAttributionOrigin(url, appEnvironment)
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

function requireQueue(
  value: Queue<AttributionQueueMessage> | undefined,
  name: string,
): Queue<AttributionQueueMessage> {
  if (!value || typeof value.send !== 'function') {
    throw new Error(`${name}_REQUIRED`)
  }
  return value
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
    publicOrigins: parsePublicOrigins(
      bindings.ATTRIBUTION_PUBLIC_ORIGINS,
      bindings.APP_ENV,
    ),
    cookieDomain: parseCookieDomain(
      bindings.ATTRIBUTION_COOKIE_DOMAIN,
      bindings.APP_ENV,
    ),
    credentialMasterKeys: {
      current: requireSecret(
        bindings.ATTRIBUTION_CREDENTIAL_MASTER_KEY_CURRENT,
        'ATTRIBUTION_CREDENTIAL_MASTER_KEY_CURRENT',
      ),
      previous: optionalSecret(
        bindings.ATTRIBUTION_CREDENTIAL_MASTER_KEY_PREVIOUS,
        'ATTRIBUTION_CREDENTIAL_MASTER_KEY_PREVIOUS',
      ),
    },
    signingKeys: {
      current: requireSecret(
        bindings.ATTRIBUTION_SIGNING_KEY_CURRENT,
        'ATTRIBUTION_SIGNING_KEY_CURRENT',
      ),
      previous: optionalSecret(
        bindings.ATTRIBUTION_SIGNING_KEY_PREVIOUS,
        'ATTRIBUTION_SIGNING_KEY_PREVIOUS',
      ),
    },
    dataEncryptionKeys: {
      current: requireSecret(
        bindings.ATTRIBUTION_DATA_ENCRYPTION_KEY_CURRENT,
        'ATTRIBUTION_DATA_ENCRYPTION_KEY_CURRENT',
      ),
      previous: optionalSecret(
        bindings.ATTRIBUTION_DATA_ENCRYPTION_KEY_PREVIOUS,
        'ATTRIBUTION_DATA_ENCRYPTION_KEY_PREVIOUS',
      ),
    },
    queues: {
      meta: requireQueue(bindings.META_QUEUE, 'META_QUEUE'),
      tiktok: requireQueue(bindings.TIKTOK_QUEUE, 'TIKTOK_QUEUE'),
      google: requireQueue(bindings.GOOGLE_QUEUE, 'GOOGLE_QUEUE'),
    },
  }
}
