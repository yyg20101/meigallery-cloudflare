import type { PublicConversionActionType } from '@meigallery/shared'

type TrackConversionOptions = {
  methodType?: string
  actionTarget?: string
  metadata?: Record<string, unknown>
}

export function useConversionTracking() {
  const tracking = useTracking()

  function trackConversion(actionType: PublicConversionActionType, options: TrackConversionOptions = {}) {
    if (actionType !== 'contact') return Promise.resolve()
    return tracking.trackContact({
      methodType: normalizeText(options.methodType, 80) || 'unknown',
      actionTarget: normalizeText(options.actionTarget, 120) || 'floating_contact_panel',
      actionType: options.metadata?.action_type === 'copy' ? 'copy' : 'open_link',
    })
  }

  return { trackConversion }
}

function normalizeText(value: unknown, maxLength: number) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength)
}
