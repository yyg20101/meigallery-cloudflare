import type { Context } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import type { Bindings, Variables } from '../index'
import {
  createMarketingConsentChoice,
  createMarketingConsentReceipt,
  MARKETING_CONSENT_CHOICE_TTL_SECONDS,
  MARKETING_CONSENT_RECEIPT_TTL_SECONDS,
  resolveTrustedMarketingConsent,
  type MarketingConsentReceiptState,
} from './marketing-consent-receipt'

export const MARKETING_CONSENT_CHOICE_COOKIE = 'mei_marketing_consent_choice'
export const MARKETING_CONSENT_RECEIPT_COOKIE = 'mei_marketing_consent_receipt'

type AppContext = Context<{ Bindings: Bindings; Variables: Variables }>

export async function resolveRequestMarketingConsent(
  c: AppContext,
  requestedState?: unknown,
  nowSeconds = Math.floor(Date.now() / 1_000),
) {
  const resolved = await resolveTrustedMarketingConsent(
    c.env.SESSION_SECRET,
    {
      choice: getCookie(c, MARKETING_CONSENT_CHOICE_COOKIE),
      receipt: getCookie(c, MARKETING_CONSENT_RECEIPT_COOKIE),
    },
    requestedState,
    nowSeconds,
  )
  if (resolved.needsReceiptRefresh && resolved.choice) {
    const receipt = await createMarketingConsentReceipt(c.env.SESSION_SECRET, resolved.choice, nowSeconds)
    setConsentCookie(c, MARKETING_CONSENT_RECEIPT_COOKIE, receipt, MARKETING_CONSENT_RECEIPT_TTL_SECONDS)
  }
  return resolved
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
