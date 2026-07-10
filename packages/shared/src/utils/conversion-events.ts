import type { ConversionActionType, ConversionMetaEventName, MetaTrackingMode } from '../types'

export interface ConversionDedupeInput {
  actionType: ConversionActionType
  sessionId: string
  visitorId: string
  occurredDate: string
  userId?: number
  methodType?: string
  actionTarget?: string
}

export function buildConversionDedupeKey(input: ConversionDedupeInput) {
  if (input.actionType === 'contact') {
    return `contact:${input.sessionId}:${normalizePart(input.methodType)}:${normalizePart(input.actionTarget)}`
  }
  if (input.actionType === 'complete_registration') {
    if (!Number.isInteger(input.userId) || Number(input.userId) <= 0) {
      throw new Error('注册转化必须包含正整数 userId')
    }
    return `complete_registration:user:${input.userId}`
  }
  return `historical:${input.actionType}:${input.visitorId}:${input.sessionId}:${input.occurredDate}`
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
