function parseDateTime(value: unknown) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null

  const date = new Date(trimmed)
  if (Number.isNaN(date.getTime())) return null
  return date
}

export function normalizeHomeAdScheduleValue(value: unknown) {
  const date = parseDateTime(value)
  if (!date) return ''
  return date.toISOString()
}

function normalizeRequiredHomeAdScheduleValue(value: unknown, label: string) {
  if (typeof value !== 'string' || !value.trim()) return ''
  const normalized = normalizeHomeAdScheduleValue(value)
  if (!normalized) throw new Error(`${label}无效`)
  return normalized
}

export function normalizeHomeAdScheduleRange(startsAt: unknown, endsAt: unknown) {
  const normalizedStartsAt = typeof startsAt === 'string' && startsAt.trim()
    ? normalizeRequiredHomeAdScheduleValue(startsAt, '首页广告开始时间')
    : ''
  const normalizedEndsAt = typeof endsAt === 'string' && endsAt.trim()
    ? normalizeRequiredHomeAdScheduleValue(endsAt, '首页广告结束时间')
    : ''

  if (normalizedStartsAt && normalizedEndsAt) {
    const start = parseDateTime(normalizedStartsAt)
    const end = parseDateTime(normalizedEndsAt)
    if (start && end && start >= end) {
      throw new Error('首页广告结束时间必须晚于开始时间')
    }
  }

  return {
    startsAt: normalizedStartsAt,
    endsAt: normalizedEndsAt,
  }
}

export function isHomeAdActive(
  enabled: unknown,
  startsAt: unknown,
  endsAt: unknown,
  now = new Date(),
) {
  const isEnabled = enabled === true || enabled === 'true'
  if (!isEnabled) return false

  const hasStartValue = typeof startsAt === 'string' && startsAt.trim()
  const start = parseDateTime(startsAt)
  if (hasStartValue && !start) return false
  if (start && now < start) return false

  const hasEndValue = typeof endsAt === 'string' && endsAt.trim()
  const end = parseDateTime(endsAt)
  if (hasEndValue && !end) return false
  if (end && now >= end) return false

  return true
}
