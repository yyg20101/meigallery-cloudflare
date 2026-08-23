const APP_NUMERIC_VERSION_PATTERN = /^\d{1,5}\.\d{1,5}(?:\.\d{1,5})?$/u

type AppNumericVersion = readonly [number, number, number]

export function normalizeAppNumericVersion(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return APP_NUMERIC_VERSION_PATTERN.test(normalized) ? normalized : null
}

export function compareAppNumericVersions(left: unknown, right: unknown): number | null {
  const leftParts = parseAppNumericVersion(left)
  const rightParts = parseAppNumericVersion(right)
  if (!leftParts || !rightParts) return null

  for (let index = 0; index < leftParts.length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (difference !== 0) return difference > 0 ? 1 : -1
  }
  return 0
}

export function supportsAppMinimumVersion(
  clientVersion: unknown,
  minimumVersion: unknown,
): boolean {
  const comparison = compareAppNumericVersions(clientVersion, minimumVersion)
  return comparison !== null && comparison >= 0
}

function parseAppNumericVersion(value: unknown): AppNumericVersion | null {
  const normalized = normalizeAppNumericVersion(value)
  if (!normalized) return null
  const parts = normalized.split('.').map(Number)
  return [Number(parts[0]), Number(parts[1]), parts[2] ?? 0]
}
