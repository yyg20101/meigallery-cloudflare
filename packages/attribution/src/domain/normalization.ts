import {
  AttributionDomainError,
} from './errors'
import type {
  AttributionCandidateBindingInput,
  AttributionCandidateInput,
  NormalizedAttributionCandidate,
} from './connection'

const encoder = new TextEncoder()

export function normalizeCandidateInput(
  input: AttributionCandidateInput,
): NormalizedAttributionCandidate {
  if (
    !['meta', 'tiktok', 'google'].includes(input.provider)
    || !isStringRecord(input.publicConfig)
    || input.bindings.length === 0
    || input.bindings.length > 2
  ) {
    throw candidateInvalid()
  }

  const publicConfigEntries = Object.entries(input.publicConfig)
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([key, value]) => {
      const normalizedKey = key.trim()
      const normalizedValue = value.trim()
      if (!normalizedKey || !normalizedValue) throw candidateInvalid()
      return [normalizedKey, normalizedValue] as const
    })

  if (
    publicConfigEntries.length === 0
    || new Set(publicConfigEntries.map(([key]) => key)).size
      !== publicConfigEntries.length
  ) {
    throw candidateInvalid()
  }

  const bindings = input.bindings
    .map(normalizeBinding)
    .sort((first, second) =>
      first.canonicalEvent.localeCompare(second.canonicalEvent))
  if (
    new Set(bindings.map(binding => binding.canonicalEvent)).size
    !== bindings.length
  ) {
    throw candidateInvalid()
  }

  const credentialFingerprint = input.credentialFingerprint.trim()
  if (!credentialFingerprint) throw candidateInvalid()

  return {
    provider: input.provider,
    publicConfig: Object.fromEntries(publicConfigEntries),
    bindings,
    credentialFingerprint,
  }
}

export async function hashCandidateIdentity(
  input: NormalizedAttributionCandidate,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(JSON.stringify(input)),
  )
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
}

function normalizeBinding(
  binding: AttributionCandidateBindingInput,
): AttributionCandidateBindingInput {
  const browserDestination = binding.browserDestination.trim()
  const serverDestination = binding.serverDestination.trim()
  if (
    !['Contact', 'CompleteRegistration'].includes(binding.canonicalEvent)
    || typeof binding.enabled !== 'boolean'
    || !browserDestination
    || !serverDestination
  ) {
    throw candidateInvalid()
  }

  return {
    canonicalEvent: binding.canonicalEvent,
    enabled: binding.enabled,
    browserDestination,
    serverDestination,
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.values(value).every(item => typeof item === 'string')
}

function candidateInvalid(): AttributionDomainError {
  return new AttributionDomainError('ATTRIBUTION_CANDIDATE_INVALID')
}
