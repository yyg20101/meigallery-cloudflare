export type AttributionPrivacyDefaultMode = 'notice_opt_out' | 'prior_consent' | 'disabled'

export interface AttributionPrivacyPolicy {
  defaultMode: AttributionPrivacyDefaultMode
  priorConsentCountryCodes: string[]
  policyVersion: number
  updatedAt: string | null
}

export interface SaveAttributionPrivacyPolicyInput {
  defaultMode: AttributionPrivacyDefaultMode
  priorConsentCountryCodes: string[]
  actorId: number
}

const POLICY_ID = 'global'
const CACHE_TTL_MS = 60_000
const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/
const DEFAULT_PRIOR_CONSENT_COUNTRY_CODES = [
  'AT', 'AX', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GB',
  'GF', 'GP', 'GR', 'HR', 'HU', 'IE', 'IS', 'IT', 'LI', 'LT', 'LU', 'LV', 'MF',
  'MQ', 'MT', 'NL', 'NO', 'PL', 'PT', 'RE', 'RO', 'SE', 'SI', 'SK', 'YT',
]

type PolicyRow = {
  default_mode: string
  prior_consent_country_codes_json: string
  policy_version: number
  updated_at: string | null
}

const cache = new WeakMap<object, { expiresAt: number; policy: AttributionPrivacyPolicy }>()

export async function readAttributionPrivacyPolicy(db: D1Database): Promise<AttributionPrivacyPolicy> {
  const cacheKey = db as unknown as object
  const cached = cache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.policy

  try {
    const row = await db.prepare(`
      SELECT default_mode, prior_consent_country_codes_json, policy_version, updated_at
      FROM attribution_privacy_policy
      WHERE id = ?
      LIMIT 1
    `).bind(POLICY_ID).first<PolicyRow>()
    const policy = row ? policyFromRow(row) : failClosedPolicy()
    cache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, policy })
    return policy
  }
  catch {
    return failClosedPolicy()
  }
}

export async function saveAttributionPrivacyPolicy(
  db: D1Database,
  input: SaveAttributionPrivacyPolicyInput,
): Promise<AttributionPrivacyPolicy> {
  const defaultMode = normalizeDefaultMode(input.defaultMode)
  const countryCodes = normalizeCountryCodes(input.priorConsentCountryCodes)
  if (!defaultMode || !Number.isSafeInteger(input.actorId) || input.actorId <= 0) {
    throw new AttributionPrivacyPolicyError('ATTRIBUTION_PRIVACY_POLICY_INVALID')
  }

  await db.prepare(`
    UPDATE attribution_privacy_policy
    SET default_mode = ?,
        prior_consent_country_codes_json = ?,
        policy_version = policy_version + 1,
        updated_by = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).bind(defaultMode, JSON.stringify(countryCodes), input.actorId, POLICY_ID).run()
  cache.delete(db as unknown as object)
  return readAttributionPrivacyPolicy(db)
}

export function normalizeCountryCodes(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 120) {
    throw new AttributionPrivacyPolicyError('ATTRIBUTION_PRIVACY_POLICY_INVALID')
  }
  const normalized = [...new Set(value.map(item => String(item).trim().toUpperCase()))].sort()
  if (!normalized.every(code => COUNTRY_CODE_PATTERN.test(code))) {
    throw new AttributionPrivacyPolicyError('ATTRIBUTION_PRIVACY_POLICY_INVALID')
  }
  return normalized
}

export function isPriorConsentRegion(policy: AttributionPrivacyPolicy, countryCode: string | null) {
  if (!countryCode || countryCode === 'XX' || countryCode === 'T1') return true
  return policy.defaultMode === 'prior_consent'
    || policy.priorConsentCountryCodes.includes(countryCode)
}

export class AttributionPrivacyPolicyError extends Error {
  constructor(public readonly code: 'ATTRIBUTION_PRIVACY_POLICY_INVALID') {
    super(code)
  }
}

function policyFromRow(row: PolicyRow): AttributionPrivacyPolicy {
  const defaultMode = normalizeDefaultMode(row.default_mode)
  const parsed = JSON.parse(row.prior_consent_country_codes_json)
  if (!defaultMode || !Number.isSafeInteger(row.policy_version) || row.policy_version <= 0) {
    return failClosedPolicy()
  }
  return {
    defaultMode,
    priorConsentCountryCodes: normalizeCountryCodes(parsed),
    policyVersion: row.policy_version,
    updatedAt: row.updated_at,
  }
}

function normalizeDefaultMode(value: unknown): AttributionPrivacyDefaultMode | null {
  return value === 'notice_opt_out' || value === 'prior_consent' || value === 'disabled'
    ? value
    : null
}

function failClosedPolicy(): AttributionPrivacyPolicy {
  return {
    defaultMode: 'prior_consent',
    priorConsentCountryCodes: [...DEFAULT_PRIOR_CONSENT_COUNTRY_CODES],
    policyVersion: 1,
    updatedAt: null,
  }
}
