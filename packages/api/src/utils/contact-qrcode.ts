export function isExpectedContactQrCodeKey(qrCodeKey: string, contactId: string): boolean {
  return new RegExp(`^qrcodes/${escapeRegExp(contactId)}\\.(?:jpe?g|png|webp)$`, 'i').test(qrCodeKey)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
