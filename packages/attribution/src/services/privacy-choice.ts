import {
  signAttributionToken,
  verifyAttributionToken,
  type AttributionSigningKeys,
} from '../security/signed-token'
import type { AttributionPrivacyChoice } from './privacy-policy'

export const PRIVACY_CHOICE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60

export interface PrivacyChoiceEnvironment {
  signingKeys: AttributionSigningKeys
  nowSeconds?: () => number
}

interface PrivacyChoicePayload {
  schemaVersion: 1
  choice: Exclude<AttributionPrivacyChoice, null>
  issuedAt: number
  expiresAt: number
}

export async function issuePrivacyChoiceToken(
  environment: PrivacyChoiceEnvironment,
  choice: Exclude<AttributionPrivacyChoice, null>,
): Promise<string> {
  const now = validNow(environment.nowSeconds)
  return signAttributionToken(
    environment.signingKeys.current,
    'privacy-choice',
    {
      schemaVersion: 1,
      choice,
      issuedAt: now,
      expiresAt: now + PRIVACY_CHOICE_MAX_AGE_SECONDS,
    } satisfies PrivacyChoicePayload,
  )
}

export async function readPrivacyChoiceToken(
  environment: PrivacyChoiceEnvironment,
  token: string | null,
): Promise<AttributionPrivacyChoice> {
  if (!token) return null
  try {
    const now = validNow(environment.nowSeconds)
    const payload = await verifyAttributionToken(
      environment.signingKeys,
      'privacy-choice',
      token,
    )
    return isPrivacyChoicePayload(payload, now)
      ? payload.choice
      : null
  } catch {
    return null
  }
}

function isPrivacyChoicePayload(
  value: Record<string, unknown> | null,
  now: number,
): value is PrivacyChoicePayload & Record<string, unknown> {
  if (!value) return false
  const keys = Object.keys(value)
  if (
    keys.length !== 4
    || ![
      'schemaVersion',
      'choice',
      'issuedAt',
      'expiresAt',
    ].every(key => key in value)
  ) return false

  return value.schemaVersion === 1
    && (value.choice === 'granted' || value.choice === 'denied')
    && Number.isSafeInteger(value.issuedAt)
    && Number.isSafeInteger(value.expiresAt)
    && Number(value.issuedAt) <= now
    && Number(value.expiresAt) > now
    && Number(value.expiresAt) - Number(value.issuedAt)
      <= PRIVACY_CHOICE_MAX_AGE_SECONDS
}

function validNow(nowSeconds: (() => number) | undefined): number {
  const value = (nowSeconds ?? (() => Math.floor(Date.now() / 1_000)))()
  if (!Number.isSafeInteger(value) || value < 0) throw new Error()
  return value
}
