import { normalizeAnalyticsCampaignToken } from '@meigallery/shared/utils'
import { sanitizeAnalyticsPath } from '~/utils/analyticsSanitizer'
import {
  hasSensitiveAnalyticsUrl,
  isAdminPath,
  sanitizeAnalyticsText,
} from '~/utils/trackingSanitizer'

export interface TrackContactInput {
  contactMethodId: string
  methodType: string
  actionType: 'open_link' | 'copy'
  linkUrl: string | null
  value: string
  attributionCapability: string | null
}

export interface TrackSearchInput {
  searchString: string
  resultCount: number
}

type BrowserPayload = Record<string, string | number | boolean>
type AnalyticsContext =
  ReturnType<ReturnType<typeof useAnalytics>['getContext']>
  & { sourceChannel?: string }

export function useTracking() {
  const route = useRoute()
  const analytics = useAnalytics()
  const adAttribution = useAdAttribution()

  async function trackContact(input: TrackContactInput) {
    if (!validContactInput(input)) return null
    const pagePath = safeRoutePath(route.fullPath, route.path)
    const result = await adAttribution.trackContact({
      ...input,
      pagePath,
    })

    analytics.track('contact_method_click', {
      eventId: result?.externalEventId || '',
      entityType: 'contact',
      flush: true,
      props: {
        contact_method_id: input.contactMethodId,
        method_type: normalizeText(input.methodType, 80) || 'unknown',
        action_type: input.actionType,
        location: 'floating_contact_panel',
      },
    })
    return result
  }

  async function consumeRegistrationInstruction(
    instructionToken: string | null | undefined,
  ) {
    return adAttribution.consumeRegistrationInstruction(
      instructionToken,
    )
  }

  async function trackViewContent(payload: BrowserPayload) {
    if (!isMarketingRouteAllowed(route.fullPath)) return false
    return adAttribution.trackSignal('ViewContent', payload)
  }

  async function trackSearch(input: TrackSearchInput) {
    if (!isMarketingRouteAllowed(route.fullPath)) return false
    return adAttribution.trackSignal('Search', {
      search_string: sanitizeAnalyticsText(input.searchString, 80),
      result_count: Number.isFinite(input.resultCount)
        ? input.resultCount
        : 0,
    })
  }

  async function buildRegistrationAttributionContext() {
    const context = analytics.getContext() as AnalyticsContext
    const sourceContext = context.sourceContext || {}
    return {
      visitorId: normalizeText(context.visitorId, 120) || undefined,
      sessionId: normalizeText(context.sessionId, 120) || undefined,
      path: safeRoutePath(route.fullPath, route.path),
      sourceChannel:
        normalizeText(context.sourceChannel, 40) || 'unknown',
      sourceName: normalizeText(sourceContext.sourceName, 120),
      trackingSourceSlug: normalizeText(
        sourceContext.trackingSourceSlug,
        120,
      ),
      utmSource: normalizeText(sourceContext.utmSource, 120),
      utmMedium: normalizeText(sourceContext.utmMedium, 120),
      utmCampaign: normalizeText(sourceContext.utmCampaign, 120),
      utmContent: normalizeAnalyticsCampaignToken(
        sourceContext.utmContent
        || queryValue(route.query.utm_content),
      ),
    }
  }

  return {
    trackAnalytics: analytics.track,
    trackContact,
    consumeRegistrationInstruction,
    trackViewContent,
    trackSearch,
    buildRegistrationAttributionContext,
  }
}

function validContactInput(
  input: TrackContactInput,
): input is TrackContactInput {
  return Boolean(input)
    && /^[A-Za-z0-9:_-]{1,160}$/.test(input.contactMethodId)
    && safeText(input.methodType, 80)
    && (input.actionType === 'open_link'
      || input.actionType === 'copy')
    && safeText(input.value, 1_024)
    && (
      input.linkUrl === null
      || safeText(input.linkUrl, 2_048)
    )
    && (
      input.attributionCapability === null
      || (
        typeof input.attributionCapability === 'string'
        && input.attributionCapability.length >= 16
        && input.attributionCapability.length <= 4_096
      )
    )
}

function queryValue(value: unknown) {
  const raw = Array.isArray(value) ? value[0] : value
  return sanitizeAnalyticsText(raw, 120)
}

function safeRoutePath(fullPath: string, path: string) {
  return sanitizeAnalyticsPath(fullPath)
    || sanitizeAnalyticsPath(path)
    || '/'
}

function normalizeText(value: unknown, maxLength: number) {
  return String(value ?? '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maxLength)
}

function isMarketingRouteAllowed(fullPath: string) {
  let pathname: string
  try {
    pathname = new URL(fullPath, 'https://site.local').pathname
  }
  catch {
    pathname = fullPath.split(/[?#]/u)[0] || fullPath
  }
  return !isAdminPath(pathname) && !hasSensitiveAnalyticsUrl(fullPath)
}

function safeText(value: unknown, maximum: number): value is string {
  return typeof value === 'string'
    && value.trim() === value
    && value.length > 0
    && value.length <= maximum
    && !/\p{Cc}/u.test(value)
}
