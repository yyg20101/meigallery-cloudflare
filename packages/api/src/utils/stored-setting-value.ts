export function parseStoredSettingValue(value: string, fallback: unknown = undefined): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}
