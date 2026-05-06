export function normalizeFacebookPixelId(value: unknown) {
  const pixelId = String(value ?? '').trim()
  if (!pixelId) return ''
  if (!/^\d{5,30}$/.test(pixelId)) {
    throw new Error('Facebook Pixel ID 只能填写 5-30 位数字')
  }
  return pixelId
}

export function normalizeBooleanSetting(value: unknown) {
  return value === true || value === 'true'
}
