import type { Bindings } from '../index'
import {
  createRuntimeMetaResourceAttestation,
  type MetaResourceAttestation,
} from './meta-resource-attestation'

const COMMIT_PATTERN = /^[0-9a-f]{40}$/
const NONCE_PATTERN = /^nonce_[0-9a-f]{32,128}$/
const TICKET_PATTERN = /^mrat_[0-9a-f]{64}$/
const TICKET_TTL_MS = 60_000

type TicketEnv = Pick<Bindings,
  'DB' | 'APP_ENV' | 'RELEASE_COMMIT' | 'META_CAPI_ACCESS_TOKEN' | 'META_CAPI_TEST_EVENT_CODE' | 'META_CAPI_DATA_KEY_CURRENT'>

export type MetaResourceAttestationTicket = {
  schemaVersion: 1
  environment: 'dev' | 'production'
  commitSha: string
  nonce: string
  ticket: string
  issuedAt: string
  expiresAt: string
}

export async function issueMetaResourceAttestationTicket(
  env: TicketEnv,
  ownerUserId: number,
  nonceValue: string,
  options: { now?: string | number | Date; randomBytes?: Uint8Array } = {},
): Promise<MetaResourceAttestationTicket> {
  const environment = normalizeEnvironment(env.APP_ENV)
  const commitSha = normalizeCommit(env.RELEASE_COMMIT)
  const nonce = normalizeNonce(nonceValue)
  const issuedAt = normalizeNow(options.now)
  if (!Number.isSafeInteger(ownerUserId) || ownerUserId < 1) throw new Error('Meta attestation ticket Owner 非法')

  const bytes = options.randomBytes ?? crypto.getRandomValues(new Uint8Array(32))
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 32) throw new Error('Meta attestation ticket 随机值非法')
  const ticket = `mrat_${toHex(bytes)}`
  const ticketDigest = await sha256(ticket)
  const expiresAt = new Date(issuedAt.getTime() + TICKET_TTL_MS)

  await env.DB.prepare(`
    DELETE FROM meta_resource_attestation_tickets
    WHERE datetime(expires_at) <= datetime(?)
  `).bind(issuedAt.toISOString()).run()
  const result = await env.DB.prepare(`
    INSERT INTO meta_resource_attestation_tickets (
      ticket_digest, environment, commit_sha, nonce, owner_user_id,
      issued_at, expires_at, consumed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
  `).bind(
    ticketDigest, environment, commitSha, nonce, ownerUserId,
    issuedAt.toISOString(), expiresAt.toISOString(),
  ).run()
  if (Number(result.meta?.changes ?? 0) !== 1) throw new Error('Meta attestation ticket 创建失败')

  return {
    schemaVersion: 1,
    environment,
    commitSha,
    nonce,
    ticket,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  }
}

export async function consumeMetaResourceAttestationTicket(
  env: TicketEnv,
  ticketValue: string,
  nonceValue: string,
  options: { now?: string | number | Date } = {},
): Promise<{ attestation: MetaResourceAttestation; ownerUserId: number }> {
  const environment = normalizeEnvironment(env.APP_ENV)
  const commitSha = normalizeCommit(env.RELEASE_COMMIT)
  const nonce = normalizeNonce(nonceValue)
  const ticket = String(ticketValue || '')
  const now = normalizeNow(options.now)
  if (!TICKET_PATTERN.test(ticket)) throw new Error('Meta attestation ticket 非法')
  const ticketDigest = await sha256(ticket)

  const row = await env.DB.prepare(`
    SELECT owner_user_id
    FROM meta_resource_attestation_tickets
    WHERE ticket_digest = ?
      AND environment = ?
      AND commit_sha = ?
      AND nonce = ?
      AND consumed_at IS NULL
      AND expires_at > ?
    LIMIT 1
  `).bind(ticketDigest, environment, commitSha, nonce, now.toISOString()).first<{ owner_user_id: number }>()
  if (!row || !Number.isSafeInteger(Number(row.owner_user_id))) throw new Error('Meta attestation ticket 不可消费')

  const consumed = await env.DB.prepare(`
    UPDATE meta_resource_attestation_tickets
    SET consumed_at = ?
    WHERE ticket_digest = ?
      AND environment = ?
      AND commit_sha = ?
      AND nonce = ?
      AND consumed_at IS NULL
      AND expires_at > ?
  `).bind(now.toISOString(), ticketDigest, environment, commitSha, nonce, now.toISOString()).run()
  if (Number(consumed.meta?.changes ?? 0) !== 1) throw new Error('Meta attestation ticket 已消费')

  const attestation = await createRuntimeMetaResourceAttestation(env, nonce, now)
  return { attestation, ownerUserId: Number(row.owner_user_id) }
}

function normalizeEnvironment(value: unknown) {
  if (value !== 'dev' && value !== 'production') throw new Error('Meta attestation ticket 环境非法')
  return value
}

function normalizeCommit(value: unknown) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!COMMIT_PATTERN.test(normalized)) throw new Error('Meta attestation ticket commit 非法')
  return normalized
}

function normalizeNonce(value: unknown) {
  const normalized = String(value || '')
  if (!NONCE_PATTERN.test(normalized)) throw new Error('Meta attestation ticket nonce 非法')
  return normalized
}

function normalizeNow(value: string | number | Date | undefined) {
  const now = new Date(value ?? Date.now())
  if (!Number.isFinite(now.getTime())) throw new Error('Meta attestation ticket 时间非法')
  return now
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return toHex(new Uint8Array(digest))
}

function toHex(value: Uint8Array) {
  return Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('')
}
