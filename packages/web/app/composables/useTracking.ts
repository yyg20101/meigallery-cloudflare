import type { MetaPixelInstruction } from '@meigallery/shared'

type FailedPixelReceiptRetry = {
  send: () => Promise<unknown>
  attempts: number
}

const failedPixelReceiptRetries: FailedPixelReceiptRetry[] = []
const PIXEL_RECEIPT_RETRY_DELAYS = [250, 1_000, 3_000]
const PIXEL_RECEIPT_RETRY_LIMIT = 100
let pixelReceiptRetryTimer: ReturnType<typeof setTimeout> | null = null

export function useTracking() {
  const { api } = useApi()
  const pixel = useFacebookPixel()
  const marketingConsent = useMarketingConsent()

  function executePixelInstructions(instructions: unknown) {
    if (!canDeliverMarketing(marketingConsent) || !Array.isArray(instructions)) return
    for (const value of instructions) {
      if (!isMetaPixelInstruction(value)) continue
      const attempted = pixel.trackStandardEvent(value.eventName, value.payload, { eventID: value.eventId })
      if (attempted !== true) continue
      reportPixelAttempted(() => api('/api/conversions/pixel-receipts', {
        method: 'POST',
        body: {
          deliveryId: value.deliveryId,
          attempted: true,
          receiptToken: value.receiptToken,
        },
      }))
    }
  }

  return { executePixelInstructions }
}

function canDeliverMarketing(marketingConsent: ReturnType<typeof useMarketingConsent>) {
  return marketingConsent.state.value === 'granted' && marketingConsent.canTrackMarketing.value
}

function isMetaPixelInstruction(value: unknown): value is MetaPixelInstruction {
  if (!value || typeof value !== 'object') return false
  const event = value as Partial<MetaPixelInstruction> & { eventName?: unknown }
  return typeof event.deliveryId === 'string'
    && event.deliveryId.length > 0
    && (event.eventName === 'Contact' || event.eventName === 'CompleteRegistration')
    && typeof event.eventId === 'string'
    && event.eventId.length > 0
    && Boolean(event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload))
    && typeof event.receiptToken === 'string'
    && event.receiptToken.length > 0
}

function reportPixelAttempted(send: () => Promise<unknown>) {
  void send().catch(() => queueFailedPixelReceiptRetry({ send, attempts: 0 }))
}

function queueFailedPixelReceiptRetry(entry: FailedPixelReceiptRetry) {
  if (failedPixelReceiptRetries.length >= PIXEL_RECEIPT_RETRY_LIMIT) return
  failedPixelReceiptRetries.push(entry)
  scheduleFailedPixelReceiptRetry()
}

function scheduleFailedPixelReceiptRetry() {
  if (pixelReceiptRetryTimer || failedPixelReceiptRetries.length === 0) return
  const delay = PIXEL_RECEIPT_RETRY_DELAYS[failedPixelReceiptRetries[0]!.attempts]!
  pixelReceiptRetryTimer = setTimeout(() => {
    pixelReceiptRetryTimer = null
    void retryFailedPixelReceipts()
  }, delay)
}

async function retryFailedPixelReceipts() {
  const pending = failedPixelReceiptRetries.splice(0)
  for (const entry of pending) {
    try {
      await entry.send()
    } catch {
      if (entry.attempts < PIXEL_RECEIPT_RETRY_DELAYS.length - 1) {
        queueFailedPixelReceiptRetry({ ...entry, attempts: entry.attempts + 1 })
      }
    }
  }
  scheduleFailedPixelReceiptRetry()
}
