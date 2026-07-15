import type {
  ActiveConversionActionType,
  AdPlatformTrackingMode,
  CanonicalConversionEvent,
  ConversionActionType,
} from '../types'
import {
  ACTIVE_AD_PLATFORM_CONVERSION_EVENTS,
  ACTIVE_CONVERSION_ACTIONS,
} from '../constants'

export interface ConversionDedupeInput {
  actionType: ConversionActionType
  sessionId: string
  visitorId: string
  occurredDate: string
  userId?: number
  methodType?: string
  actionTarget?: string
}

export type ActiveConversionDedupeInput = Omit<ConversionDedupeInput, 'actionType'> & {
  actionType: ActiveConversionActionType
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

export function buildExternalEventIdBasis(
  input: ActiveConversionDedupeInput & { eventName: CanonicalConversionEvent },
) {
  if (
    !ACTIVE_CONVERSION_ACTIONS.includes(input.actionType)
    || !ACTIVE_AD_PLATFORM_CONVERSION_EVENTS.includes(input.eventName)
  ) {
    throw new Error('外部投递只允许活动转化事件')
  }
  return `${input.eventName}:${buildConversionDedupeKey(input)}`
}

export function normalizeAdPlatformTrackingMode(value: unknown): AdPlatformTrackingMode {
  return value === 'test' || value === 'production' ? value : 'disabled'
}

function normalizePart(value: unknown) {
  return String(value ?? 'unknown').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-') || 'unknown'
}
