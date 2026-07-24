import { AttributionDomainError } from '../domain/errors'
import { sha256Hex } from '../security/digest'

export type AttributionPrivacyDefaultMode =
  | 'notice_opt_out'
  | 'prior_consent'
  | 'disabled'

export type AttributionPrivacyChoice = 'granted' | 'denied' | null

export interface AttributionPrivacyPolicy {
  defaultMode: AttributionPrivacyDefaultMode
  priorConsentCountryCodes: readonly string[]
  policyVersion: number
  updatedAt: string | null
}

export type AttributionPrivacyDecision =
  | {
    state: 'granted'
    reason: 'explicit' | 'regional_default'
  }
  | {
    state: 'denied'
    reason: 'gpc' | 'disabled' | 'explicit'
  }
  | {
    state: 'choice_required'
    reason: 'policy_default' | 'prior_consent_region' | 'unknown_region'
  }

export interface AttributionPrivacyDecisionInput {
  country: string | null
  choice: AttributionPrivacyChoice
  gpc: boolean
}

export interface PrivacyPolicyCommandEnvironment {
  db: D1Database
  now?: () => Date
  idFactory?: (prefix: string) => string
}

export interface SavePrivacyPolicyInput {
  defaultMode: AttributionPrivacyDefaultMode
  priorConsentCountryCodes: readonly string[]
  actorId: number
  idempotencyKey: string
}

interface PolicyRow {
  default_mode: string
  prior_consent_country_codes_json: string
  policy_version: number
  updated_at: string | null
}

interface CommandReceiptRow {
  command_type: string
  request_hash: string
  result_json: string
}

const POLICY_ID = 'global'
const ISO_COUNTRY_CODES = new Set(`
  AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ
  BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ
  CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ
  DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR
  GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY
  HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT
  JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ
  LA LB LC LI LK LR LS LT LU LV LY
  MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ
  NA NC NE NF NG NI NL NO NP NR NU NZ OM
  PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA
  RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV
  SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ
  UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW
`.trim().split(/\s+/u))

export function resolvePrivacyDecision(
  policy: AttributionPrivacyPolicy,
  input: AttributionPrivacyDecisionInput,
): AttributionPrivacyDecision {
  if (input.gpc === true) return { state: 'denied', reason: 'gpc' }
  if (policy.defaultMode === 'disabled') {
    return { state: 'denied', reason: 'disabled' }
  }
  if (input.choice === 'denied') {
    return { state: 'denied', reason: 'explicit' }
  }
  if (input.choice === 'granted') {
    return { state: 'granted', reason: 'explicit' }
  }
  if (policy.defaultMode === 'prior_consent') {
    return { state: 'choice_required', reason: 'policy_default' }
  }

  const country = normalizeCountry(input.country)
  if (!country) {
    return { state: 'choice_required', reason: 'unknown_region' }
  }
  if (policy.priorConsentCountryCodes.includes(country)) {
    return { state: 'choice_required', reason: 'prior_consent_region' }
  }
  return { state: 'granted', reason: 'regional_default' }
}

export async function readPrivacyPolicy(
  db: D1Database,
): Promise<AttributionPrivacyPolicy> {
  try {
    const row = await db.prepare(`
      SELECT default_mode, prior_consent_country_codes_json,
             policy_version, updated_at
      FROM attribution_privacy_policy
      WHERE id = ?
      LIMIT 1
    `).bind(POLICY_ID).first<PolicyRow>()
    return row ? policyFromRow(row) : failClosedPolicy()
  } catch {
    return failClosedPolicy()
  }
}

export async function savePrivacyPolicy(
  environment: PrivacyPolicyCommandEnvironment,
  input: SavePrivacyPolicyInput,
): Promise<AttributionPrivacyPolicy> {
  validateCommandInput(input)
  const countryCodes = normalizeCountryCodes(
    input.priorConsentCountryCodes,
  )
  const requestHash = await hashRequest({
    defaultMode: input.defaultMode,
    priorConsentCountryCodes: countryCodes,
    actorId: input.actorId,
  })
  const receipt = await readReceipt(
    environment.db,
    input.idempotencyKey,
    requestHash,
  )
  if (receipt) return receipt

  const current = await requirePolicy(environment.db)
  const timestamp = validNow(environment.now ?? (() => new Date()))
  const result: AttributionPrivacyPolicy = {
    defaultMode: input.defaultMode,
    priorConsentCountryCodes: countryCodes,
    policyVersion: current.policyVersion + 1,
    updatedAt: timestamp,
  }
  const idFactory = environment.idFactory
    ?? (prefix => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`)
  const auditId = idFactory('audit')
  validateIdentifier(auditId)

  let batchResults: D1Result<unknown>[]
  try {
    batchResults = await environment.db.batch([
      environment.db.prepare(`
        UPDATE attribution_privacy_policy
        SET default_mode = ?,
            prior_consent_country_codes_json = ?,
            policy_version = policy_version + 1,
            updated_by = ?,
            updated_at = ?
        WHERE id = ?
          AND policy_version = ?
      `).bind(
        result.defaultMode,
        JSON.stringify(result.priorConsentCountryCodes),
        input.actorId,
        timestamp,
        POLICY_ID,
        current.policyVersion,
      ),
      environment.db.prepare(`
        INSERT INTO attribution_audit_logs (
          id, actor_id, command_type, connection_id,
          outcome, detail_json, created_at
        )
        SELECT ?, ?, 'save_privacy_policy', 'global',
               'updated', ?, ?
        WHERE changes() = 1
      `).bind(
        auditId,
        input.actorId,
        JSON.stringify({
          defaultMode: result.defaultMode,
          priorConsentCountryCodes: result.priorConsentCountryCodes,
          policyVersion: result.policyVersion,
        }),
        timestamp,
      ),
      environment.db.prepare(`
        INSERT INTO attribution_command_receipts (
          idempotency_key, command_type, request_hash,
          result_json, created_at
        )
        SELECT ?, 'save_privacy_policy', ?, ?, ?
        WHERE changes() = 1
      `).bind(
        input.idempotencyKey,
        requestHash,
        JSON.stringify(result),
        timestamp,
      ),
    ])
  } catch {
    const raced = await readReceipt(
      environment.db,
      input.idempotencyKey,
      requestHash,
    )
    if (raced) return raced
    throw commandFailed()
  }
  if (Number(batchResults[0]?.meta.changes ?? 0) !== 1) {
    const raced = await readReceipt(
      environment.db,
      input.idempotencyKey,
      requestHash,
    )
    if (raced) return raced
    throw commandFailed()
  }
  return result
}

export function normalizeCountryCodes(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > ISO_COUNTRY_CODES.size) {
    throw policyInvalid()
  }
  const normalized = [...new Set(value.map(item => (
    typeof item === 'string' ? item.trim().toUpperCase() : ''
  )))].sort()
  if (!normalized.every(code => ISO_COUNTRY_CODES.has(code))) {
    throw policyInvalid()
  }
  return normalized
}

function normalizeCountry(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toUpperCase()
  return ISO_COUNTRY_CODES.has(normalized) ? normalized : null
}

async function requirePolicy(
  db: D1Database,
): Promise<AttributionPrivacyPolicy> {
  const row = await db.prepare(`
    SELECT default_mode, prior_consent_country_codes_json,
           policy_version, updated_at
    FROM attribution_privacy_policy
    WHERE id = ?
    LIMIT 1
  `).bind(POLICY_ID).first<PolicyRow>()
  if (!row) throw commandFailed()
  try {
    return policyFromRow(row)
  } catch {
    throw commandFailed()
  }
}

function policyFromRow(row: PolicyRow): AttributionPrivacyPolicy {
  if (
    !isDefaultMode(row.default_mode)
    || !Number.isSafeInteger(row.policy_version)
    || row.policy_version < 1
    || (
      row.updated_at !== null
      && !Number.isFinite(new Date(row.updated_at).getTime())
    )
  ) {
    throw policyInvalid()
  }
  const parsed: unknown = JSON.parse(row.prior_consent_country_codes_json)
  return {
    defaultMode: row.default_mode,
    priorConsentCountryCodes: normalizeCountryCodes(parsed),
    policyVersion: row.policy_version,
    updatedAt: row.updated_at,
  }
}

async function readReceipt(
  db: D1Database,
  idempotencyKey: string,
  requestHash: string,
): Promise<AttributionPrivacyPolicy | null> {
  const row = await db.prepare(`
    SELECT command_type, request_hash, result_json
    FROM attribution_command_receipts
    WHERE idempotency_key = ?
  `).bind(idempotencyKey).first<CommandReceiptRow>()
  if (!row) return null
  if (
    row.command_type !== 'save_privacy_policy'
    || row.request_hash !== requestHash
  ) {
    throw new AttributionDomainError('ATTRIBUTION_IDEMPOTENCY_CONFLICT')
  }
  try {
    const result = JSON.parse(row.result_json) as AttributionPrivacyPolicy
    return policyFromResult(result)
  } catch {
    throw commandFailed()
  }
}

function policyFromResult(
  value: AttributionPrivacyPolicy,
): AttributionPrivacyPolicy {
  if (
    !value
    || !isDefaultMode(value.defaultMode)
    || !Number.isSafeInteger(value.policyVersion)
    || value.policyVersion < 1
    || typeof value.updatedAt !== 'string'
    || !Number.isFinite(new Date(value.updatedAt).getTime())
  ) {
    throw commandFailed()
  }
  return {
    defaultMode: value.defaultMode,
    priorConsentCountryCodes: normalizeCountryCodes(
      value.priorConsentCountryCodes,
    ),
    policyVersion: value.policyVersion,
    updatedAt: value.updatedAt,
  }
}

async function hashRequest(
  payload: Record<string, unknown>,
): Promise<string> {
  return sha256Hex(JSON.stringify(payload))
}

function validateCommandInput(input: SavePrivacyPolicyInput): void {
  if (
    !isDefaultMode(input.defaultMode)
    || !Number.isSafeInteger(input.actorId)
    || input.actorId < 1
    || !isIdentifier(input.idempotencyKey)
  ) {
    throw policyInvalid()
  }
}

function isDefaultMode(value: unknown): value is AttributionPrivacyDefaultMode {
  return value === 'notice_opt_out'
    || value === 'prior_consent'
    || value === 'disabled'
}

function validateIdentifier(value: unknown): asserts value is string {
  if (!isIdentifier(value)) throw policyInvalid()
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 240
    && /^[A-Za-z0-9:_-]+$/.test(value)
}

function validNow(now: () => Date): string {
  const value = now()
  if (!Number.isFinite(value.getTime())) throw policyInvalid()
  return value.toISOString()
}

function failClosedPolicy(): AttributionPrivacyPolicy {
  return {
    defaultMode: 'prior_consent',
    priorConsentCountryCodes: [],
    policyVersion: 1,
    updatedAt: null,
  }
}

function policyInvalid(): AttributionDomainError {
  return new AttributionDomainError('ATTRIBUTION_PRIVACY_POLICY_INVALID')
}

function commandFailed(): AttributionDomainError {
  return new AttributionDomainError('ATTRIBUTION_COMMAND_FAILED')
}
