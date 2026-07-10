import type {
  ActiveConversionActionType,
  ActiveMetaEventName,
  ConversionActionType,
  MetaTrackingMode,
} from '../types'
import { ACTIVE_CONVERSION_ACTIONS, ACTIVE_META_EVENTS } from '../constants'

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

export function buildExternalEventId(input: ActiveConversionDedupeInput & { metaEventName: ActiveMetaEventName }) {
  if (
    !ACTIVE_CONVERSION_ACTIONS.includes(input.actionType)
    || !ACTIVE_META_EVENTS.includes(input.metaEventName)
  ) {
    throw new Error('外部投递只允许活动转化事件')
  }
  return `meta:${input.metaEventName}:${buildConversionDedupeKey(input)}`
}

export function normalizeMetaTrackingMode(value: unknown): MetaTrackingMode {
  return value === 'test' || value === 'production' ? value : 'disabled'
}

function normalizePart(value: unknown) {
  return String(value ?? 'unknown').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-') || 'unknown'
}
