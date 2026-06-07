import { ANALYTICS_LIMITS } from '@meigallery/shared/constants'

export interface AnalyticsDateRange {
  from: string
  to: string
  days: number
}

const OPERATION_TIME_ZONE = 'Asia/Shanghai'
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function toOperationDateShanghai(value: Date | string | number = new Date()): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error('分析日期无效')
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: OPERATION_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

export function clampActiveSeconds(value: unknown, maxSeconds = ANALYTICS_LIMITS.PAGE_ACTIVE_SECONDS_CAP): number {
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) return 0
  return Math.min(maxSeconds, Math.floor(seconds))
}

export function parseAnalyticsRange(raw: {
  from?: string | null
  to?: string | null
  range?: string | null
}, now = new Date()): AnalyticsDateRange {
  const today = toOperationDateShanghai(now)

  if (raw.from || raw.to) {
    const from = normalizeDate(raw.from, today)
    const to = normalizeDate(raw.to, today)
    const days = daysBetweenInclusive(from, to)
    if (days <= 0) throw new Error('分析日期范围无效')
    if (days > ANALYTICS_LIMITS.CUSTOM_RANGE_MAX_DAYS) throw new Error('分析日期范围不能超过 90 天')
    return { from, to, days }
  }

  const days = rangeToDays(raw.range)
  return {
    from: addDays(today, -(days - 1)),
    to: today,
    days,
  }
}

export function rangeToDays(range: string | null | undefined): number {
  if (range === '7d') return 7
  if (range === '90d') return 90
  return 30
}

function normalizeDate(value: string | null | undefined, fallback: string) {
  const date = String(value || fallback).trim()
  if (!DATE_RE.test(date)) throw new Error('分析日期格式必须为 YYYY-MM-DD')
  return date
}

function daysBetweenInclusive(from: string, to: string) {
  const fromDate = dateStringToUtc(from)
  const toDate = dateStringToUtc(to)
  return Math.floor((toDate.getTime() - fromDate.getTime()) / 86_400_000) + 1
}

function addDays(date: string, delta: number) {
  const next = dateStringToUtc(date)
  next.setUTCDate(next.getUTCDate() + delta)
  return next.toISOString().slice(0, 10)
}

function dateStringToUtc(date: string) {
  const [year, month, day] = date.split('-').map(part => Number.parseInt(part, 10))
  if (!year || !month || !day) throw new Error('分析日期无效')
  const parsed = new Date(Date.UTC(year, month - 1, day))
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) {
    throw new Error('分析日期无效')
  }
  return parsed
}
