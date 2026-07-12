export function normalizeBooleanSetting(value: unknown) {
  return value === true || value === 1 || value === '1' || value === 'true'
}
