import type { ConversionActionType, ConversionMetaEventName, MetaTrackingMode } from '../types'

export interface ConversionDedupeInput {
  actionType: ConversionActionType
  sessionId: string
  visitorId: string
  occurredDate: string
  methodType?: string
  actionTarget?: string
}

export function buildConversionDedupeKey(input: ConversionDedupeInput) {
  if (input.actionType === 'contact') {
    return `contact:${input.sessionId}:${normalizePart(input.methodType)}:${normalizePart(input.actionTarget)}`
  }
  if (input.actionType === 'lead') return `lead:${input.sessionId}`
  if (input.actionType === 'complete_registration' || input.actionType === 'start_trial') {
    return `${input.actionType}:${input.sessionId}:${input.occurredDate}`
  }
  return `${input.actionType}:${input.visitorId}:${input.occurredDate}`
}

export function buildExternalEventId(input: ConversionDedupeInput & { metaEventName: ConversionMetaEventName }) {
  return `meta:${input.metaEventName}:${buildConversionDedupeKey(input)}`
}

export function normalizeMetaTrackingMode(value: unknown): MetaTrackingMode {
  return value === 'test' || value === 'production' ? value : 'disabled'
}

function normalizePart(value: unknown) {
  return String(value ?? 'unknown').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-') || 'unknown'
}
