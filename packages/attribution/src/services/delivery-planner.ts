import type {
  AttributionProvider,
  CanonicalConversionEvent,
} from '@meigallery/shared'
import type { AttributionRuntimePolicy } from '../domain/connection'
import { AttributionDomainError } from '../domain/errors'
import { sha256Hex } from '../security/digest'

export interface DeliveryPlanBinding {
  enabled: boolean
  browserDestination: string
  serverDestination: string
}

export interface DeliveryPlanInput {
  factId: string
  externalEventId: string
  connectionId: string
  versionId: string
  provider: AttributionProvider
  eventName: CanonicalConversionEvent
  serverDataAllowed: boolean
  runtimePolicy: AttributionRuntimePolicy
  binding: DeliveryPlanBinding
}

export interface PlannedDelivery {
  provider: AttributionProvider
  transport: 'browser' | 'server'
  destination: string
}

const PROVIDERS = new Set<AttributionProvider>([
  'meta',
  'tiktok',
  'google',
])
const EVENTS = new Set<CanonicalConversionEvent>([
  'Contact',
  'CompleteRegistration',
])
const PERCENTAGES = new Set([0, 10, 50, 100])

export async function planDeliveries(
  input: DeliveryPlanInput,
): Promise<PlannedDelivery[]> {
  validateInput(input)
  if (!input.binding.enabled || !input.runtimePolicy.enabled) return []

  const planned: PlannedDelivery[] = []
  if (
    input.runtimePolicy.browserEnabled
    && input.binding.browserDestination.length > 0
  ) {
    planned.push({
      provider: input.provider,
      transport: 'browser',
      destination: input.binding.browserDestination,
    })
  }

  if (
    input.serverDataAllowed
    && input.runtimePolicy.serverEnabled
    && input.runtimePolicy.circuitState === 'closed'
    && input.runtimePolicy.serverEffectivePercentage > 0
    && input.binding.serverDestination.length > 0
    && await isInServerBucket(input)
  ) {
    planned.push({
      provider: input.provider,
      transport: 'server',
      destination: input.binding.serverDestination,
    })
  }
  return planned
}

async function isInServerBucket(
  input: DeliveryPlanInput,
): Promise<boolean> {
  if (input.runtimePolicy.serverEffectivePercentage === 100) return true
  const digest = await sha256Hex([
    'delivery-bucket:v1',
    input.provider,
    input.connectionId,
    input.versionId,
    input.externalEventId,
  ].join(':'))
  const bucket = Number.parseInt(digest.slice(0, 8), 16) % 100
  return bucket < input.runtimePolicy.serverEffectivePercentage
}

function validateInput(input: DeliveryPlanInput): void {
  if (
    !input
    || !isIdentifier(input.factId)
    || !isIdentifier(input.externalEventId)
    || !isIdentifier(input.connectionId)
    || !isIdentifier(input.versionId)
    || !PROVIDERS.has(input.provider)
    || !EVENTS.has(input.eventName)
    || typeof input.serverDataAllowed !== 'boolean'
    || !isDestination(input.binding?.browserDestination)
    || !isDestination(input.binding?.serverDestination)
    || typeof input.binding.enabled !== 'boolean'
    || typeof input.runtimePolicy?.enabled !== 'boolean'
    || typeof input.runtimePolicy.browserEnabled !== 'boolean'
    || typeof input.runtimePolicy.serverEnabled !== 'boolean'
    || !PERCENTAGES.has(input.runtimePolicy.serverTargetPercentage)
    || !PERCENTAGES.has(input.runtimePolicy.serverEffectivePercentage)
    || (
      input.runtimePolicy.circuitState !== 'closed'
      && input.runtimePolicy.circuitState !== 'server_open'
    )
  ) {
    throw new AttributionDomainError('ATTRIBUTION_FACT_INVALID')
  }
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 240
    && /^[A-Za-z0-9:_-]+$/.test(value)
}

function isDestination(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= 512
    && !/\p{Cc}/u.test(value)
}
