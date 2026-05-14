export function parsePositiveIntParam(value: string | undefined, defaultValue: number, maxValue?: number): number {
  const parsed = Number.parseInt(value || '', 10)
  const normalized = Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue
  return maxValue === undefined ? normalized : Math.min(maxValue, normalized)
}
