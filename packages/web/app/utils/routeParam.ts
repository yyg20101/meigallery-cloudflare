export function decodeRouteParam(value: unknown): string {
  const rawValue = Array.isArray(value) ? value[0] : value
  if (typeof rawValue !== 'string') return ''

  try {
    return decodeURIComponent(rawValue)
  }
  catch {
    return rawValue
  }
}
