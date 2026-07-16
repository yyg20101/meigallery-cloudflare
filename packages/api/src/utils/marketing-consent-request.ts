import type { Context } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import type { Bindings, Variables } from '../index'
import {
  isPriorConsentRegion,
  readAttributionPrivacyPolicy,
  type AttributionPrivacyDefaultMode,
} from '../services/attribution-privacy-policy'
import {
  createMarketingConsentChoice,
  createAdConsentSnapshot,
  createMarketingConsentReceipt,
  MARKETING_CONSENT_CHOICE_TTL_SECONDS,
  MARKETING_CONSENT_RECEIPT_TTL_SECONDS,
  resolveTrustedMarketingConsent,
  type MarketingConsentReceiptState,
} from './marketing-consent-receipt'

export const MARKETING_CONSENT_CHOICE_COOKIE = 'mei_marketing_consent_choice'
export const MARKETING_CONSENT_RECEIPT_COOKIE = 'mei_marketing_consent_receipt'

type AppContext = Context<{ Bindings: Bindings; Variables: Variables }>

export type MarketingConsentDecisionSource =
  | 'explicit'
  | 'regional_default'
  | 'choice_required'
  | 'gpc'
  | 'disabled'
  | 'request_limit'

export interface RequestMarketingConsentResolution extends Awaited<ReturnType<typeof resolveTrustedMarketingConsent>> {
  policyMode: AttributionPrivacyDefaultMode
  decisionSource: MarketingConsentDecisionSource
  requiresChoice: boolean
  policyVersion: number
}

export async function resolveRequestMarketingConsent(
  c: AppContext,
  requestedState?: unknown,
  nowSeconds = Math.floor(Date.now() / 1_000),
  explicitOverride?: MarketingConsentReceiptState,
): Promise<RequestMarketingConsentResolution> {
  const trusted = await resolveTrustedMarketingConsent(
    c.env.SESSION_SECRET,
    {
      choice: getCookie(c, MARKETING_CONSENT_CHOICE_COOKIE),
      receipt: getCookie(c, MARKETING_CONSENT_RECEIPT_COOKIE),
    },
    undefined,
    nowSeconds,
  )
  if (trusted.needsReceiptRefresh && trusted.choice) {
    const receipt = await createMarketingConsentReceipt(c.env.SESSION_SECRET, trusted.choice, nowSeconds)
    setConsentCookie(c, MARKETING_CONSENT_RECEIPT_COOKIE, receipt, MARKETING_CONSENT_RECEIPT_TTL_SECONDS)
  }

  const policy = await readAttributionPrivacyPolicy(c.env.DB)
  const countryCode = requestCountryCode(c.req.raw)
  const priorConsentRegion = isPriorConsentRegion(policy, countryCode)
  const explicitState = explicitOverride ?? (trusted.state === 'granted' || trusted.state === 'denied'
    ? trusted.state
    : null)

  let state: 'granted' | 'limited' | 'denied'
  let decisionSource: MarketingConsentDecisionSource
  if (requestHasGlobalPrivacyControl(c.req.raw)) {
    state = 'denied'
    decisionSource = 'gpc'
  }
  else if (policy.defaultMode === 'disabled') {
    state = 'denied'
    decisionSource = 'disabled'
  }
  else if (explicitState) {
    state = explicitState
    decisionSource = 'explicit'
  }
  else if (priorConsentRegion) {
    state = 'limited'
    decisionSource = 'choice_required'
  }
  else {
    state = 'granted'
    decisionSource = 'regional_default'
  }

  if (requestedState === 'denied' || requestedState === 'limited') {
    state = requestedState
    decisionSource = 'request_limit'
  }
  const consent = state === 'granted'
    ? createAdConsentSnapshot('granted', nowSeconds)
    : createAdConsentSnapshot('denied', nowSeconds)

  return {
    ...trusted,
    state,
    consent,
    policyMode: policy.defaultMode === 'disabled'
      ? 'disabled'
      : priorConsentRegion ? 'prior_consent' : 'notice_opt_out',
    decisionSource,
    requiresChoice: state === 'limited' && decisionSource === 'choice_required',
    policyVersion: policy.policyVersion,
  }
}

export async function persistMarketingConsentChoice(
  c: AppContext,
  state: MarketingConsentReceiptState,
  nowSeconds = Math.floor(Date.now() / 1_000),
) {
  const choice = await createMarketingConsentChoice(c.env.SESSION_SECRET, state, nowSeconds)
  const receipt = await createMarketingConsentReceipt(c.env.SESSION_SECRET, choice.claims, nowSeconds)
  setConsentCookie(c, MARKETING_CONSENT_CHOICE_COOKIE, choice.token, MARKETING_CONSENT_CHOICE_TTL_SECONDS)
  setConsentCookie(c, MARKETING_CONSENT_RECEIPT_COOKIE, receipt, MARKETING_CONSENT_RECEIPT_TTL_SECONDS)
  return { state }
}

function setConsentCookie(c: AppContext, name: string, value: string, maxAge: number) {
  setCookie(c, name, value, {
    httpOnly: true,
    secure: c.env.APP_ENV === 'production' || new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/',
    maxAge,
  })
}

function requestCountryCode(request: Request): string | null {
  const requestWithCf = request as Request & { cf?: { country?: unknown } }
  const raw = requestWithCf.cf?.country ?? request.headers.get('CF-IPCountry')
  const normalized = String(raw ?? '').trim().toUpperCase()
  return /^[A-Z]{2}$/.test(normalized) || normalized === 'T1' ? normalized : null
}

function requestHasGlobalPrivacyControl(request: Request) {
  return request.headers.get('Sec-GPC')?.trim() === '1'
}
