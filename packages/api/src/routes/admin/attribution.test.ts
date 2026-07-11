import { Buffer } from 'node:buffer'
import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Bindings, Variables } from '../../index'
import { adminRoutes } from './index'

type DbCall = { sql: string; params: unknown[] }

type ReadinessOptions = {
  schemaTableCount?: number
  actionCount?: number
  retryExhaustedCount?: number
  externalEventIdMismatchCount?: number
  externalEventIds?: { sourceChannel?: string; pixel: readonly string[]; capi: readonly string[] }
  pendingTooLongCount?: number
  permanentFailureCount?: number
  fbpSampleCount?: number
  fbpMatchedCount?: number
  fbcSampleCount?: number
  fbcMatchedCount?: number
  pixelAttemptedCount?: number
  capiSentCount?: number
  liveVerificationPresent?: boolean
  resourcesVerificationPresent?: boolean
  liveVerificationExpiresAt?: string
  resourcesVerificationExpiresAt?: string
  lastManualConfirmationAt?: string
}

type AttributionDbOptions = {
  failCreateBatchAt?: number
  historicalStartTrialDeliveryCount?: number
  membershipGrantDuplicateCount?: number
  attributionTotals?: {
    contactCount: number
    leadCount: number
    completeRegistrationCount: number
    membershipGrantCount: number
  }
  settings?: Partial<Record<string, string | boolean>>
  readiness?: ReadinessOptions
  previousOutboxCount?: number
  previousActiveDeliveryCount?: number
}

function createApp(role: string | null = 'admin') {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()
  app.use('*', async (c, next) => {
    c.set('userId', role ? 1 : null)
    c.set('userRole', role)
    await next()
  })
  app.route('/api/admin', adminRoutes)
  return app
}

function createAttributionDb(options: AttributionDbOptions = {}) {
  const calls: DbCall[] = []
  const historicalStartTrialDeliveryCount = Math.max(0, options.historicalStartTrialDeliveryCount ?? 0)
  const membershipGrantDuplicateCount = Math.max(0, options.membershipGrantDuplicateCount ?? 0)
  const attributionTotals = options.attributionTotals ?? {
    contactCount: 3,
    leadCount: 1,
    completeRegistrationCount: 1,
    membershipGrantCount: 0,
  }
  const dailyHistoryLeak = (sql: string) => sql.includes("event_name IN ('Contact', 'CompleteRegistration')")
    ? 0
    : historicalStartTrialDeliveryCount
  const actionHistoryLeak = (sql: string) => (
    sql.includes("action_type IN ('contact', 'complete_registration')") ||
    sql.includes("action_type IN ('contact', 'complete_registration', 'membership_grant')") ||
    sql.includes("action_type <> 'start_trial'")
  )
    ? 0
    : historicalStartTrialDeliveryCount
  const membershipGrantDuplicates = (sql: string) => (
    sql.includes("action_type <> 'start_trial'") || sql.includes("'membership_grant'")
  )
    ? membershipGrantDuplicateCount
    : 0
  const settings = {
    analytics_enabled: true,
    facebook_pixel_enabled: true,
    facebook_pixel_id: '1234567890',
    meta_capi_enabled: false,
    meta_tracking_mode: 'test',
    ...options.settings,
  }
  const readiness = {
    schemaTableCount: 4,
    actionCount: 5,
    retryExhaustedCount: 0,
    externalEventIdMismatchCount: 0,
    pendingTooLongCount: 0,
    permanentFailureCount: 0,
    fbpSampleCount: 10,
    fbpMatchedCount: 8,
    fbcSampleCount: 10,
    fbcMatchedCount: 7,
    pixelAttemptedCount: 2,
    capiSentCount: 1,
    liveVerificationPresent: true,
    resourcesVerificationPresent: true,
    liveVerificationExpiresAt: '2099-01-01T00:00:00.000Z',
    resourcesVerificationExpiresAt: '2099-01-01T00:00:00.000Z',
    lastManualConfirmationAt: new Date().toISOString(),
    ...options.readiness,
  }
  let testAction: { id: string; occurred_at: string; date: string; path: string; metadata: string } | null = null
  let testDelivery: {
    id: string
    conversion_action_id: string
    channel: string
    external_event_id: string
    event_name: string
    status: string
    skip_reason: string
    error_code: string
    error_message: string
    attempt_count: number
    tracking_mode: 'test'
    duplicate_suppressed_at: string | null
  } | null = null
  let pendingDailyCount = 0
  let pendingDailyCreated = 0
  let createBatchSeen = false
  let metaConnectionVerification: {
    environment: string
    pixel_id: string
    token_fingerprint: string
    graph_api_version: string
    verified_event_name: string
    verified_commit: string
    dataset_quality_status: string
    verified_at: string
    verified_by_user_id: number
    invalidated_at: string | null
    invalidation_reason: string
    revision: string
  } | null = null
  const db = {
    calls,
    get testAction() { return testAction },
    get testDelivery() { return testDelivery },
    get pendingDailyCount() { return pendingDailyCount },
    get pendingDailyCreated() { return pendingDailyCreated },
    prepare(sql: string) {
      const call: DbCall = { sql, params: [] }
      const statement = {
        __call: call,
        bind(...params: unknown[]) {
          const placeholderCount = sql.match(/\?/g)?.length ?? 0
          if (placeholderCount !== params.length) {
            throw new Error(`SQL placeholder 数 ${placeholderCount} 与 bind 数 ${params.length} 不一致`)
          }
          call.params = params
          return this
        },
        async all<T>() {
          calls.push(call)
          if (sql.includes('FROM sqlite_master')) {
            return {
              results: [{ table_count: readiness.schemaTableCount } as T],
              meta: { rows_read: 1, rows_written: 0, duration: 1 },
            }
          }
          if (sql.includes('AS retry_exhausted_count')) {
            return {
              results: [{ retry_exhausted_count: readiness.retryExhaustedCount + actionHistoryLeak(sql) } as T],
              meta: { rows_read: 1, rows_written: 0, duration: 1 },
            }
          }
          if (sql.includes('AS external_event_id_mismatch_count')) {
            const externalEventIdMismatchCount = readiness.externalEventIds
              ? externalEventIdMismatch(readiness.externalEventIds)
              : readiness.externalEventIdMismatchCount
            return {
              results: [{ external_event_id_mismatch_count: externalEventIdMismatchCount + actionHistoryLeak(sql) } as T],
              meta: { rows_read: 1, rows_written: 0, duration: 1 },
            }
          }
          if (sql.includes('AS pending_too_long_count')) {
            return {
              results: [{ pending_too_long_count: readiness.pendingTooLongCount + actionHistoryLeak(sql) } as T],
              meta: { rows_read: 1, rows_written: 0, duration: 1 },
            }
          }
          if (sql.includes('AS permanent_failure_count')) {
            return {
              results: [{ permanent_failure_count: readiness.permanentFailureCount + actionHistoryLeak(sql) } as T],
              meta: { rows_read: 1, rows_written: 0, duration: 1 },
            }
          }
          if (sql.includes('AS fbp_sample_count')) {
            return {
              results: [{
                fbp_sample_count: readiness.fbpSampleCount + actionHistoryLeak(sql),
                fbp_matched_count: readiness.fbpMatchedCount,
                fbc_sample_count: readiness.fbcSampleCount + actionHistoryLeak(sql),
                fbc_matched_count: readiness.fbcMatchedCount,
              } as T],
              meta: { rows_read: 1, rows_written: 0, duration: 1 },
            }
          }
          if (sql.includes('AS pixel_attempted_count') && sql.includes('AS capi_sent_count') && !sql.includes('GROUP BY date')) {
            return {
              results: [{
                pixel_attempted_count: readiness.pixelAttemptedCount + dailyHistoryLeak(sql),
                pixel_pending_count: 0,
                pixel_skipped_count: 0,
                capi_sent_count: readiness.capiSentCount + dailyHistoryLeak(sql),
                capi_failed_count: dailyHistoryLeak(sql),
                capi_skipped_count: 0,
                capi_duplicate_suppressed_count: 1 + dailyHistoryLeak(sql),
                duplicate_suppressed_count: 1 + dailyHistoryLeak(sql),
              } as T],
              meta: { rows_read: 1, rows_written: 0, duration: 1 },
            }
          }
          if (sql.includes('FROM analytics_release_verifications') && sql.includes('GROUP BY verification_type')) {
            const results = []
            if (readiness.liveVerificationPresent && isFutureIsoTimestamp(readiness.liveVerificationExpiresAt)) {
              results.push({ verification_type: 'meta_live', verified_at: '2026-07-10T00:00:00.000Z', expires_at: readiness.liveVerificationExpiresAt })
            }
            if (readiness.resourcesVerificationPresent && isFutureIsoTimestamp(readiness.resourcesVerificationExpiresAt)) {
              results.push({ verification_type: 'meta_resources', verified_at: '2026-07-10T00:00:00.000Z', expires_at: readiness.resourcesVerificationExpiresAt })
            }
            return {
              results: results as T[],
              meta: { rows_read: results.length, rows_written: 0, duration: 1 },
            }
          }
          if (sql.includes('FROM analytics_release_verifications') && sql.includes('last_manual_confirmation_at')) {
            return {
              results: [{ last_manual_confirmation_at: readiness.lastManualConfirmationAt } as T],
              meta: { rows_read: 1, rows_written: 0, duration: 1 },
            }
          }
          if (sql.includes('COUNT(*) AS duplicate_action_count')) {
            return {
              results: [{
                duplicate_action_count: 1 + actionHistoryLeak(sql) + membershipGrantDuplicates(sql),
              } as T],
              meta: { rows_read: 1, rows_written: 0, duration: 1 },
            }
          }
          if (sql.includes('FROM analytics_conversion_daily') && sql.includes('GROUP BY date')) {
            return {
              results: [
                {
                  date: '2026-07-09',
                  contact_count: attributionTotals.contactCount,
                  lead_count: attributionTotals.leadCount,
                  complete_registration_count: attributionTotals.completeRegistrationCount,
                  membership_grant_count: attributionTotals.membershipGrantCount,
                },
              ] as T[],
              meta: { rows_read: 1, rows_written: 0, duration: 1 },
            }
          }
          if (sql.includes('FROM analytics_conversion_daily') && sql.includes('GROUP BY action_type')) {
            return {
              results: [
                { action_type: 'contact', action_count: attributionTotals.contactCount, unique_session_count: attributionTotals.contactCount },
                { action_type: 'lead', action_count: attributionTotals.leadCount, unique_session_count: attributionTotals.leadCount },
                { action_type: 'complete_registration', action_count: attributionTotals.completeRegistrationCount, unique_session_count: attributionTotals.completeRegistrationCount },
                { action_type: 'membership_grant', action_count: attributionTotals.membershipGrantCount, unique_session_count: attributionTotals.membershipGrantCount },
              ] as T[],
              meta: { rows_read: 4, rows_written: 0, duration: 1 },
            }
          }
          if (sql.includes('FROM analytics_conversion_daily') && sql.includes('GROUP BY source_channel')) {
            return {
              results: [
                {
                  source_channel: 'ad',
                  source_name: 'ad-a',
                  utm_campaign: 'july',
                  utm_content: 'chat-a',
                  contact_count: attributionTotals.contactCount,
                  lead_count: attributionTotals.leadCount,
                  complete_registration_count: attributionTotals.completeRegistrationCount,
                  membership_grant_count: attributionTotals.membershipGrantCount,
                },
              ] as T[],
              meta: { rows_read: 2, rows_written: 0, duration: 1 },
            }
          }
          if (sql.includes('AS historical_lead_count')) {
            return {
              results: [{ historical_lead_count: attributionTotals.leadCount } as T],
              meta: { rows_read: 1, rows_written: 0, duration: 1 },
            }
          }
          if (sql.includes('FROM analytics_conversion_daily') && sql.includes('SUM(action_count)') && !sql.includes('FROM analytics_tracking_sources')) {
            return {
              results: [{ action_count: readiness.actionCount } as T],
              meta: { rows_read: 1, rows_written: 0, duration: 1 },
            }
          }
          if (sql.includes('FROM analytics_conversion_daily') && !sql.includes('FROM analytics_tracking_sources')) {
            return {
              results: [
                {
                  contact_count: attributionTotals.contactCount,
                  lead_count: attributionTotals.leadCount,
                  complete_registration_count: attributionTotals.completeRegistrationCount,
                  membership_grant_count: attributionTotals.membershipGrantCount,
                },
              ] as T[],
              meta: { rows_read: 1, rows_written: 0, duration: 1 },
            }
          }
          if (sql.includes('FROM analytics_conversion_actions') && sql.includes("duplicate_of != ''")) {
            const results = [
              {
                id: 'convdup_1',
                action_type: 'contact',
                occurred_at: '2026-07-09T10:01:00.000Z',
                source_channel: 'ad',
                source_name: 'ad-a',
                tracking_source_slug: 'ad-a',
                utm_campaign: 'old-july',
                utm_content: 'old-chat',
                method_type: 'telegram',
                action_target: 'floating_contact_panel',
                duplicate_of: 'conv_1',
              },
            ]
            if (actionHistoryLeak(sql) > 0) {
              results.push({
                id: 'convdup_start_trial',
                action_type: 'start_trial',
                occurred_at: '2026-07-09T11:00:00.000Z',
                source_channel: 'ad',
                source_name: 'legacy-start-trial',
                tracking_source_slug: 'legacy-start-trial',
                utm_campaign: 'legacy',
                utm_content: 'legacy',
                method_type: '',
                action_target: 'legacy-start-trial',
                duplicate_of: 'conv_start_trial',
              })
            }
            if (membershipGrantDuplicates(sql) > 0) {
              results.push({
                id: 'convdup_membership_grant',
                action_type: 'membership_grant',
                occurred_at: '2026-07-09T10:30:00.000Z',
                source_channel: 'ad',
                source_name: 'ad-a',
                tracking_source_slug: 'ad-a',
                utm_campaign: 'old-july',
                utm_content: 'membership',
                method_type: 'manual',
                action_target: 'membership_grant',
                duplicate_of: 'conv_membership_grant',
              })
            }
            return {
              results: results as T[],
              meta: { rows_read: results.length, rows_written: 0, duration: 1 },
            }
          }
          if (sql.includes('FROM analytics_conversion_actions')) {
            return {
              results: [
                {
                  id: 'conv_1',
                  action_type: 'contact',
                  occurred_at: '2026-07-09T10:00:00.000Z',
                  source_channel: 'ad',
                  source_name: 'ad-a',
                  tracking_source_slug: 'ad-a',
                  utm_campaign: 'july',
                  utm_content: 'chat-a',
                  method_type: 'telegram',
                  action_target: 'floating_contact_panel',
                  route_name: 'gallery-detail',
                  path: '/gallery/demo',
                  duplicate_of: '',
                },
              ] as T[],
              meta: { rows_read: 1, rows_written: 0, duration: 1 },
            }
          }
          if (sql.includes('FROM analytics_conversion_delivery_daily') && sql.includes('GROUP BY date')) {
            return {
              results: [
                {
                  date: '2026-07-09',
                  pixel_attempted_count: 2 + dailyHistoryLeak(sql),
                  pixel_pending_count: 0,
                  pixel_skipped_count: 1,
                  capi_sent_count: 1 + dailyHistoryLeak(sql),
                  capi_failed_count: dailyHistoryLeak(sql),
                  capi_skipped_count: 0,
                  capi_duplicate_suppressed_count: 1 + dailyHistoryLeak(sql),
                },
              ] as T[],
              meta: { rows_read: 1, rows_written: 0, duration: 1 },
            }
          }
          if (sql.includes('FROM analytics_conversion_delivery_daily') && sql.includes('GROUP BY channel')) {
            const results = [
              { channel: 'meta_pixel', event_name: 'Contact', status: 'attempted', skip_reason: '', delivery_count: 2 },
              { channel: 'meta_capi', event_name: 'Contact', status: 'sent', skip_reason: '', delivery_count: 1 },
              { channel: 'meta_capi', event_name: 'Contact', status: 'duplicate_suppressed', skip_reason: '', delivery_count: 1 },
            ]
            if (dailyHistoryLeak(sql) > 0) {
              results.push({
                channel: 'meta_capi',
                event_name: 'StartTrial',
                status: 'sent',
                skip_reason: 'legacy',
                delivery_count: dailyHistoryLeak(sql),
              })
            }
            return {
              results: results as T[],
              meta: { rows_read: results.length, rows_written: 0, duration: 1 },
            }
          }
          if (sql.includes('FROM analytics_conversion_delivery_daily')) {
            return {
              results: [
                {
                  sent_count: 2 + dailyHistoryLeak(sql),
                  failed_count: dailyHistoryLeak(sql),
                  skipped_count: 1,
                  duplicate_suppressed_count: 1 + dailyHistoryLeak(sql),
                  delivery_count: 4 + dailyHistoryLeak(sql),
                },
              ] as T[],
              meta: { rows_read: 1, rows_written: 0, duration: 1 },
            }
          }
          if (sql.includes('FROM analytics_tracking_sources')) {
            return {
              results: [
                {
                  id: 'ats_1',
                  name: 'Meta 广告 A',
                  channel: 'ad',
                  slug: 'ad-a',
                  target_path: '/',
                  utm_source: 'ad-a',
                  utm_medium: 'paid_social',
                  utm_campaign: 'july',
                  utm_content: 'chat-a',
                  status: 'active',
                  note: '',
                  created_by: 1,
                  created_at: '2026-07-09T00:00:00.000Z',
                  updated_at: '2026-07-09T00:00:00.000Z',
                  visitor_count: 4,
                  session_count: 4,
                  page_view_count: 8,
                  gallery_detail_count: 3,
                  contact_click_count: 0,
                  register_count: 0,
                  membership_grant_count: 0,
                  active_seconds_total: 120,
                  contact_count: attributionTotals.contactCount,
                  lead_count: attributionTotals.leadCount,
                  complete_registration_count: attributionTotals.completeRegistrationCount,
                  conversion_membership_grant_count: attributionTotals.membershipGrantCount,
                },
              ] as T[],
              meta: { rows_read: 1, rows_written: 0, duration: 1 },
            }
          }
          if (sql.includes('FROM analytics_conversion_deliveries') && sql.includes('AS last_sent_at')) {
            return {
              results: [{
                last_sent_at: actionHistoryLeak(sql) > 0
                  ? '2099-01-01T00:00:00.000Z'
                  : '2026-07-09T10:00:00.000Z',
              } as T],
              meta: { rows_read: 1, rows_written: 0, duration: 1 },
            }
          }
          if (sql.includes('FROM site_settings')) {
            return {
              results: Object.entries(settings).map(([key, value]) => ({ key, value: JSON.stringify(value) })) as T[],
              meta: { rows_read: Object.keys(settings).length, rows_written: 0, duration: 1 },
            }
          }
          return { results: [] as T[], meta: { rows_read: 0, rows_written: 0, duration: 0 } }
        },
        async first<T>() {
          calls.push(call)
          if (sql.includes('FROM meta_capi_secure_outbox')) {
            return { reference_count: options.previousOutboxCount ?? 0 } as T
          }
          if (sql.includes('FROM analytics_conversion_deliveries') && sql.includes('encryption_key_id')) {
            return { reference_count: options.previousActiveDeliveryCount ?? 0 } as T
          }
          if (sql.includes('FROM analytics_conversion_deliveries d') && testAction && testDelivery) {
            return {
              ...testDelivery,
              occurred_at: testAction.occurred_at,
              date: testAction.date,
              path: testAction.path,
              metadata: testAction.metadata,
            } as T
          }
          if (sql.includes('FROM analytics_conversion_daily')) {
            return {
              contact_count: attributionTotals.contactCount,
              lead_count: attributionTotals.leadCount,
              complete_registration_count: attributionTotals.completeRegistrationCount,
              membership_grant_count: attributionTotals.membershipGrantCount,
            } as T
          }
          if (sql.includes('FROM analytics_conversion_delivery_daily')) {
            return {
              sent_count: 2,
              failed_count: 0,
              skipped_count: 1,
              duplicate_suppressed_count: 1,
            } as T
          }
          if (sql.includes('FROM analytics_conversion_deliveries') && sql.includes('AS last_sent_at')) {
            return { last_sent_at: '2026-07-09T10:00:00.000Z' } as T
          }
          if (sql.includes('COUNT(*) AS duplicate_action_count')) {
            return { duplicate_action_count: 1 } as T
          }
          if (sql.includes('FROM site_settings')) {
            const key = sql.match(/key\s*=\s*'([^']+)'/)?.[1]
            if (!key || !(key in settings)) return null
            return { value: JSON.stringify(settings[key as keyof typeof settings]) } as T
          }
          if (sql.includes('FROM meta_connection_verifications')) {
            return metaConnectionVerification as T | null
          }
          return null
        },
        async run() {
          calls.push(call)
          if (sql.includes('INSERT INTO analytics_conversion_actions')) {
            testAction = {
              id: String(call.params[0] ?? ''),
              occurred_at: String(call.params[2] ?? ''),
              date: String(call.params[3] ?? ''),
              path: '/admin/attribution/meta',
              metadata: String(call.params[5] ?? '{}'),
            }
          }
          if (sql.includes('INSERT INTO analytics_conversion_deliveries')) {
            testDelivery = {
              id: String(call.params[0] ?? ''),
              conversion_action_id: String(call.params[1] ?? ''),
              channel: 'meta_capi',
              external_event_id: String(call.params[2] ?? ''),
              event_name: 'Contact',
              status: 'pending',
              skip_reason: '',
              error_code: '',
              error_message: '',
              attempt_count: 0,
              tracking_mode: 'test',
              duplicate_suppressed_at: null,
            }
          }
          if (sql.includes('UPDATE analytics_conversion_deliveries') && testDelivery) {
            testDelivery.status = String(call.params[0] ?? '')
            testDelivery.skip_reason = String(call.params[1] ?? '')
            testDelivery.error_code = String(call.params[2] ?? '')
            testDelivery.error_message = String(call.params[3] ?? '')
            testDelivery.attempt_count += 1
          }
          if (sql.includes('INSERT INTO analytics_conversion_delivery_daily') && sql.includes("'pending'")) {
            pendingDailyCount += 1
            pendingDailyCreated += 1
          }
          if (sql.includes('INSERT INTO meta_connection_verifications')) {
            metaConnectionVerification = {
              environment: String(call.params[0]),
              pixel_id: String(call.params[1]),
              token_fingerprint: String(call.params[2]),
              graph_api_version: String(call.params[3]),
              verified_event_name: String(call.params[4]),
              verified_commit: String(call.params[5]),
              revision: String(call.params[6]),
              dataset_quality_status: 'not_checked',
              verified_at: '2026-07-11T00:00:00.000Z',
              verified_by_user_id: Number(call.params[7]),
              invalidated_at: null,
              invalidation_reason: '',
            }
          }
          if (sql.includes('UPDATE analytics_conversion_delivery_daily') && call.params[3] === 'pending') {
            pendingDailyCount = Math.max(0, pendingDailyCount - 1)
          }
          return { meta: { changes: 1, rows_read: 0, rows_written: 1, duration: 1 } }
        },
      }
      return statement
    },
    async batch(statements: Array<{ run: () => Promise<unknown> }>) {
      const isCreateBatch = !createBatchSeen && statements.length === 3
      if (isCreateBatch) createBatchSeen = true
      const snapshot = {
        testAction: testAction ? { ...testAction } : null,
        testDelivery: testDelivery ? { ...testDelivery } : null,
        pendingDailyCount,
        pendingDailyCreated,
      }
      const results = []
      try {
        for (let index = 0; index < statements.length; index += 1) {
          if (isCreateBatch && options.failCreateBatchAt === index + 1) throw new Error('模拟 Test Event 创建失败')
          results.push(await statements[index]!.run())
        }
        return results
      } catch (error) {
        testAction = snapshot.testAction
        testDelivery = snapshot.testDelivery
        pendingDailyCount = snapshot.pendingDailyCount
        pendingDailyCreated = snapshot.pendingDailyCreated
        throw error
      }
    },
  }
  return db
}

function externalEventIdMismatch(input: { sourceChannel?: string; pixel: readonly string[]; capi: readonly string[] }) {
  if (input.sourceChannel === 'internal') return 0
  const pixelIds = new Set(input.pixel)
  const capiIds = new Set(input.capi)
  if (pixelIds.size === 0 || capiIds.size === 0) return 0
  const allIds = new Set([...pixelIds, ...capiIds])
  return pixelIds.size === 1 && capiIds.size === 1 && allIds.size === 1 ? 0 : 1
}

function isFutureIsoTimestamp(value: string) {
  const timestamp = new Date(value).getTime()
  return Number.isFinite(timestamp) && timestamp > Date.now()
}

const VALID_RELEASE_COMMIT = 'a'.repeat(40)
const VALID_READINESS_ENV = {
  META_CAPI_ACCESS_TOKEN: 'secret-token',
  META_CAPI_TEST_EVENT_CODE: 'test-code',
  META_CAPI_QUEUE: { send: async () => undefined },
  RELEASE_COMMIT: VALID_RELEASE_COMMIT,
  APP_ENV: 'dev',
  META_CAPI_DATA_KEY_CURRENT: Buffer.alloc(32, 7).toString('base64'),
  META_CAPI_DATA_KEY_PREVIOUS: Buffer.alloc(32, 8).toString('base64'),
}

async function requestReadiness(
  dbOptions: AttributionDbOptions = {},
  envOverrides: Partial<Bindings> = {},
) {
  const db = createAttributionDb(dbOptions)
  const res = await createApp('admin').request(
    '/api/admin/attribution/readiness?from=2026-07-09&to=2026-07-09',
    {},
    { DB: db, ...VALID_READINESS_ENV, ...envOverrides } as unknown as Bindings,
  )
  return { db, res, body: await res.json() }
}

type RolloutDbOptions = {
  target?: 0 | 10 | 50 | 100
  connectionVerified?: boolean
  liveEvidence?: boolean
  incidentSeverity?: 'warning' | 'critical' | null
  sent?: number
  failed?: number
  permissionErrors?: number
  retryExhausted?: number
  stalePending?: number
  criticalQualityDiagnostics?: number
  conflict?: boolean
}

function createRolloutDb(options: RolloutDbOptions = {}) {
  const calls: DbCall[] = []
  const audits: Array<{ before: unknown; after: unknown }> = []
  let targetRaw = JSON.stringify(options.target ?? 0)
  let batchCount = 0
  let lastChanges = 0

  function rowsFor<T>(sql: string, params: unknown[]): T[] {
    if (sql.includes('FROM meta_capi_incidents')) {
      if (options.incidentSeverity !== 'critical') return []
      return [{
        id: 'incident_rollout_open',
        severity: 'critical',
        trigger_code: 'meta_permission_denied',
        trigger_summary: 'Meta 权限拒绝',
        target_rollout_percentage: options.target ?? 0,
        effective_rollout_percentage: 0,
        opened_at: '2026-07-11T00:00:00.000Z',
        last_observed_at: '2026-07-11T00:01:00.000Z',
      } as T]
    }
    if (sql.includes('FROM analytics_release_verifications')) {
      return options.liveEvidence === false ? [] : [{ id: 'verification_meta_live' } as T]
    }
    if (sql.includes('AS permission_error_count')) {
      return [{
        sent_count: options.sent ?? 100,
        failed_count: options.failed ?? 0,
        permission_error_count: options.permissionErrors ?? 0,
        retry_exhausted_count: options.retryExhausted ?? 0,
        stale_pending_count: options.stalePending ?? 0,
        critical_quality_diagnostic_count: options.criticalQualityDiagnostics ?? 0,
      } as T]
    }
    if (sql.includes('FROM site_settings') && sql.includes("key = 'meta_capi_rollout_percentage'")) {
      return [{ value: targetRaw } as T]
    }
    if (sql.includes('FROM site_settings') && sql.includes("key = 'facebook_pixel_id'")) {
      return [{ value: JSON.stringify('1234567890') } as T]
    }
    if (sql.includes('FROM site_settings') && sql.includes("key = 'meta_tracking_mode'")) {
      return [{ value: JSON.stringify('test') } as T]
    }
    if (sql.includes('FROM meta_connection_verifications')) {
      if (options.connectionVerified === false) return []
      return [{
        environment: 'dev',
        pixel_id: '1234567890',
        token_fingerprint: 'a31456d57fa4fd03160643daf898d11bff0e56e42c445ffa81680f662de55276',
        graph_api_version: 'v25.0',
        verified_event_name: 'Contact',
        verified_commit: VALID_RELEASE_COMMIT,
        dataset_quality_status: 'not_checked',
        verified_at: '2026-07-11T00:00:00.000Z',
        verified_by_user_id: 1,
        invalidated_at: null,
        invalidation_reason: '',
        revision: '1'.repeat(32),
      } as T]
    }
    return []
  }

  const db = {
    calls,
    audits,
    get target() { return JSON.parse(targetRaw) },
    get batchCount() { return batchCount },
    prepare(sql: string) {
      const call: DbCall = { sql, params: [] }
      const statement = {
        bind(...params: unknown[]) {
          call.params = params
          return this
        },
        async first<T>() {
          calls.push(call)
          return rowsFor<T>(sql, call.params)[0] ?? null
        },
        async all<T>() {
          calls.push(call)
          return { results: rowsFor<T>(sql, call.params), meta: { rows_read: 1, rows_written: 0 } }
        },
        async run() {
          calls.push(call)
          if (sql.includes('UPDATE site_settings') && sql.includes('meta_capi_rollout_percentage')) {
            const [nextRaw, expectedRaw] = call.params.map(String)
            if (options.conflict || targetRaw !== expectedRaw) {
              lastChanges = 0
              return { meta: { changes: 0, rows_written: 0 } }
            }
            targetRaw = nextRaw!
            lastChanges = 1
            return { meta: { changes: 1, rows_written: 1 } }
          }
          if (sql.includes('INSERT INTO admin_audit_logs')) {
            if (lastChanges === 1) {
              audits.push({
                before: JSON.parse(String(call.params[5])),
                after: JSON.parse(String(call.params[6])),
              })
              return { meta: { changes: 1, rows_written: 1 } }
            }
            return { meta: { changes: 0, rows_written: 0 } }
          }
          lastChanges = 1
          return { meta: { changes: 1, rows_written: 1 } }
        },
      }
      return statement
    },
    async batch(statements: Array<{ run: () => Promise<unknown> }>) {
      batchCount += 1
      const beforeTarget = targetRaw
      const beforeAudits = [...audits]
      try {
        const results = []
        for (const statement of statements) results.push(await statement.run())
        return results
      }
      catch (error) {
        targetRaw = beforeTarget
        audits.splice(0, audits.length, ...beforeAudits)
        throw error
      }
    },
  }
  return db
}

const VALID_ROLLOUT_ENV = {
  APP_ENV: 'dev',
  META_CAPI_ACCESS_TOKEN: 'rollout-token',
  META_CAPI_TEST_EVENT_CODE: 'test-code',
  RELEASE_COMMIT: VALID_RELEASE_COMMIT,
}

async function requestRollout(
  role: string,
  dbOptions: RolloutDbOptions = {},
  init: RequestInit = {},
  envOverrides: Partial<Bindings> = {},
) {
  const db = createRolloutDb(dbOptions)
  const res = await createApp(role).request(
    '/api/admin/attribution/meta/rollout',
    init,
    { DB: db, ...VALID_ROLLOUT_ENV, ...envOverrides } as unknown as Bindings,
  )
  return { db, res, body: await res.json() }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('后台归因中心 API', () => {
  it('要求 admin+ 才能访问归因总览', async () => {
    const res = await createApp(null).request('/api/admin/attribution/overview?range=7d', {}, { DB: createAttributionDb() } as unknown as Bindings)
    expect(res.status).toBe(403)
  })

  it('总览返回转化趋势、Meta 状态和重复诊断', async () => {
    const res = await createApp('admin').request('/api/admin/attribution/overview?from=2026-07-09&to=2026-07-09', {}, { DB: createAttributionDb() } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.range).toMatchObject({ from: '2026-07-09', to: '2026-07-09', days: 1 })
    expect(body.usage.rowsRead).toBeGreaterThan(0)
    expect(body.data.totals.contact_count).toBe(3)
    expect(body.data.meta).toMatchObject({
      pixel_attempted_count: 2,
      pixel_pending_count: 0,
      pixel_skipped_count: 0,
      capi_sent_count: 1,
      capi_failed_count: 0,
      capi_skipped_count: 0,
      capi_duplicate_suppressed_count: 1,
    })
    expect(body.data.duplicates.duplicate_suppressed_count).toBe(1)
    expect(body.data.trend[0]).toMatchObject({ date: '2026-07-09', contact_count: 3 })
    expect(body.data.metaTrend[0]).toMatchObject({ date: '2026-07-09', capi_failed_count: 0, failed_count: 0 })
    expect(Array.isArray(body.data.risks)).toBe(true)
  })

  it('总览 Meta 汇总严格按 Pixel/CAPI 渠道解释状态', async () => {
    const db = createAttributionDb()
    const res = await createApp('admin').request('/api/admin/attribution/overview?from=2026-07-09&to=2026-07-09', {}, { DB: db } as unknown as Bindings)
    const body = await res.json()
    const totalsSql = db.calls.find(call => call.sql.includes('AS capi_duplicate_suppressed_count') && !call.sql.includes('GROUP BY date'))?.sql ?? ''
    const trendSql = db.calls.find(call => call.sql.includes('AS capi_duplicate_suppressed_count') && call.sql.includes('GROUP BY date'))?.sql ?? ''
    const lastSentSql = db.calls.find(call => call.sql.includes('AS last_sent_at'))?.sql ?? ''

    expect(res.status).toBe(200)
    expect(body.data.meta.capi_sent_count).toBe(1)
    expect(body.data.meta).not.toHaveProperty('sent_count')
    expect(totalsSql).toContain("channel = 'meta_pixel' AND status = 'attempted'")
    expect(totalsSql).not.toContain("channel = 'meta_pixel' AND status = 'sent'")
    expect(totalsSql).toContain("channel = 'meta_capi' AND status = 'sent'")
    expect(trendSql).toContain("channel = 'meta_capi' AND status = 'sent'")
    expect(lastSentSql).toContain("channel = 'meta_capi'")
    expect(lastSentSql).toContain("status = 'sent'")
  })

  it('返回转化动作、来源和最近样本', async () => {
    const res = await createApp('admin').request('/api/admin/attribution/conversions?from=2026-07-09&to=2026-07-09', {}, { DB: createAttributionDb() } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.byAction[0]).toMatchObject({ action_type: 'contact', action_count: 3 })
    expect(body.data.bySource[0]).toMatchObject({ source_name: 'ad-a', contact_count: 3 })
    expect(body.data.samples[0]).toMatchObject({ id: 'conv_1', action_type: 'contact' })
    expect(JSON.stringify(body.data)).not.toContain('start_trial')
  })

  it('活动归因只统计 Contact 和完成注册并单独返回历史 Lead', async () => {
    const db = createAttributionDb()
    const app = createApp('admin')
    const env = { DB: db } as unknown as Bindings
    const [overviewResponse, conversionsResponse, linksResponse] = await Promise.all([
      app.request('/api/admin/attribution/overview?from=2026-07-09&to=2026-07-09', {}, env),
      app.request('/api/admin/attribution/conversions?from=2026-07-09&to=2026-07-09', {}, env),
      app.request('/api/admin/attribution/links?from=2026-07-09&to=2026-07-09', {}, env),
    ])
    const [overview, conversions, links] = await Promise.all([
      overviewResponse.json(),
      conversionsResponse.json(),
      linksResponse.json(),
    ])

    expect(overview.data.totals).not.toHaveProperty('lead_count')
    expect(overview.data.totals).not.toHaveProperty('membership_grant_count')
    expect(overview.data.operations).toEqual({ membershipGrantCount: 0 })
    expect(overview.data.historical).toEqual({ leadCount: 1 })
    expect(overview.data.trend[0]).not.toHaveProperty('lead_count')
    expect(overview.data.trend[0]).not.toHaveProperty('membership_grant_count')
    expect(conversions.data.historical).toEqual({ leadCount: 1 })
    expect(conversions.data.operations).toEqual({ membershipGrantCount: 0 })
    expect(conversions.data.byAction.map((row: { action_type: string }) => row.action_type)).not.toContain('lead')
    expect(conversions.data.bySource[0]).not.toHaveProperty('lead_count')
    expect(conversions.data.bySource[0]).not.toHaveProperty('membership_grant_count')
    expect(conversions.data.bySource[0].operations).toEqual({ membershipGrantCount: 0 })
    expect(conversions.data.bySource[0].historical).toEqual({ leadCount: 1 })
    expect(links.data.links[0]).not.toHaveProperty('leadCount')
    expect(links.data.links[0]).not.toHaveProperty('conversionMembershipGrantCount')
    expect(links.data.links[0].operations).toEqual({ membershipGrantCount: 0 })
    expect(links.data.links[0].historical).toEqual({ leadCount: 1 })

    const activityQueries = db.calls.filter(call => (
      call.sql.includes('FROM analytics_conversion_delivery_daily') ||
      call.sql.includes('FROM analytics_conversion_deliveries')
    ))
    expect(activityQueries.length).toBeGreaterThan(0)
    expect(activityQueries.every(call => !call.sql.includes("'Lead'"))).toBe(true)
    expect(activityQueries.every(call => !call.sql.includes("'lead'"))).toBe(true)
    const linksSql = db.calls.find(call => call.sql.includes('WITH conversion_metrics'))?.sql ?? ''
    expect(linksSql).not.toContain('ORDER BY contact_count DESC, lead_count DESC')
  })

  it('只有会员发放时仍判定活动转化为空', async () => {
    const res = await createApp('admin').request('/api/admin/attribution/overview?from=2026-07-09&to=2026-07-09', {}, {
      DB: createAttributionDb({
        attributionTotals: {
          contactCount: 0,
          leadCount: 0,
          completeRegistrationCount: 0,
          membershipGrantCount: 7,
        },
      }),
    } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.totals).toEqual({ contact_count: 0, complete_registration_count: 0 })
    expect(body.data.operations).toEqual({ membershipGrantCount: 7 })
    expect(body.data.risks).toContainEqual(expect.objectContaining({ key: 'conversion_empty' }))
  })

  it('默认 overview/conversions/links SQL 与响应完全排除历史 start_trial', async () => {
    const db = createAttributionDb()
    const app = createApp('admin')
    const env = { DB: db } as unknown as Bindings
    const [overview, conversions, links] = await Promise.all([
      app.request('/api/admin/attribution/overview?from=2026-07-09&to=2026-07-09', {}, env),
      app.request('/api/admin/attribution/conversions?from=2026-07-09&to=2026-07-09', {}, env),
      app.request('/api/admin/attribution/links?from=2026-07-09&to=2026-07-09', {}, env),
    ])
    const bodies = await Promise.all([overview.json(), conversions.json(), links.json()])
    const currentReportCalls = db.calls.filter(call => call.sql.includes('FROM analytics_conversion_daily'))

    expect(bodies.every(body => !JSON.stringify(body.data).includes('start_trial'))).toBe(true)
    expect(currentReportCalls.length).toBeGreaterThan(0)
    expect(currentReportCalls.every(call => (
      call.sql.includes("action_type <> 'start_trial'") ||
      call.sql.includes("action_type = 'lead'")
    ))).toBe(true)
    expect(currentReportCalls.every(call => !call.sql.includes('AS start_trial_count'))).toBe(true)
    const sampleSql = db.calls.find(call => call.sql.includes('FROM analytics_conversion_actions') && call.sql.includes('LIMIT 100'))?.sql ?? ''
    expect(sampleSql).toContain("action_type <> 'start_trial'")
  })

  it('转化接口支持按 sourceCode 过滤', async () => {
    const db = createAttributionDb()
    const res = await createApp('admin').request('/api/admin/attribution/conversions?from=2026-07-09&to=2026-07-09&sourceCode=ad-a', {}, { DB: db } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.bySource[0]).toMatchObject({ source_name: 'ad-a', contact_count: 3 })
    const sourceSqlCalls = db.calls.filter(call => call.sql.includes('analytics_conversion_daily') || call.sql.includes('analytics_conversion_actions'))
    expect(sourceSqlCalls.some(call => call.sql.includes('source_name = ?') && call.params.includes('ad-a'))).toBe(true)
    expect(sourceSqlCalls.some(call => call.sql.includes('tracking_source_slug = ?') && call.params.includes('ad-a'))).toBe(true)
  })

  it('返回投放追踪链接和转化指标', async () => {
    const db = createAttributionDb()
    const res = await createApp('admin').request('/api/admin/attribution/links?from=2026-07-09&to=2026-07-09', {}, { DB: db } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.links[0]).toMatchObject({
      sourceLabel: 'Meta 广告 A',
      utmContent: 'chat-a',
      contactCount: 3,
      completeRegistrationCount: 1,
      historical: { leadCount: 1 },
    })
    expect(body.data.links[0].trackingPath).toContain('utm_content=chat-a')
    const linkSql = db.calls.find(call => call.sql.includes('WITH conversion_metrics'))
    expect(linkSql?.sql).toContain('GROUP BY source_name')
    expect(linkSql?.sql).not.toContain('cm.utm_campaign')
    expect(linkSql?.sql).not.toContain('cm.utm_content')
    expect(body.data.links[0]).not.toHaveProperty('startTrialCount')
  })

  it('投放链接按 sourceCode 过滤时 SQL placeholder 与 bind 顺序完全匹配', async () => {
    const db = createAttributionDb()
    const res = await createApp('admin').request('/api/admin/attribution/links?from=2026-07-09&to=2026-07-09&sourceCode=ad-a', {}, {
      DB: db,
    } as unknown as Bindings)
    const body = await res.json()
    const linkCall = db.calls.find(call => call.sql.includes('WITH conversion_metrics'))

    expect(res.status).toBe(200)
    expect(body.data.links[0]).toMatchObject({ sourceCode: 'ad-a' })
    expect(linkCall?.sql.match(/\?/g)).toHaveLength(7)
    expect(linkCall?.params).toEqual([
      '2026-07-09',
      '2026-07-09',
      'ad-a',
      '2026-07-09',
      '2026-07-09',
      'ad-a',
      'ad-a',
    ])
  })

  it('返回 Meta 投递状态和配置', async () => {
    const res = await createApp('admin').request('/api/admin/attribution/meta?from=2026-07-09&to=2026-07-09', {}, {
      DB: createAttributionDb(),
      ...VALID_READINESS_ENV,
    } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.totals).toMatchObject({
      pixel_attempted_count: 2,
      capi_sent_count: 1,
      capi_failed_count: 0,
      retry_exhausted_count: 0,
      duplicate_suppressed_count: 1,
    })
    expect(body.data.deliveries[0]).toMatchObject({ channel: 'meta_pixel', event_name: 'Contact' })
    expect(body.data.settings).not.toHaveProperty('facebook_pixel_id')
    expect(body.data.connection.tokenConfigured).toBe(true)
    expect(body.data.connection.testEventCodeConfigured).toBe(true)
    expect(body.data.queueBindingPresent).toBe(true)
    expect(body.data.keyRotation).toEqual({
      currentKeyValid: true,
      previousKeyConfigured: true,
      previousKeyValid: true,
      previousSameAsCurrent: false,
      previousOutboxCount: 0,
      previousActiveDeliveryCount: 0,
      canRemovePrevious: true,
    })
    expect(Object.keys(body.data.keyRotation)).toHaveLength(7)
    expect(JSON.stringify(body)).not.toContain('secret-token')
    expect(JSON.stringify(body)).not.toContain('test-code')
    expect(JSON.stringify(body)).not.toContain(VALID_READINESS_ENV.META_CAPI_DATA_KEY_CURRENT)
    expect(JSON.stringify(body)).not.toContain(VALID_READINESS_ENV.META_CAPI_DATA_KEY_PREVIOUS)
  })

  it('Meta key rotation 只统计 previous 的全部 outbox 与 pending/failed delivery', async () => {
    const db = createAttributionDb({ previousOutboxCount: 4, previousActiveDeliveryCount: 2 })
    const res = await createApp('admin').request('/api/admin/attribution/meta?range=30d', {}, {
      DB: db,
      ...VALID_READINESS_ENV,
    } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.keyRotation).toMatchObject({
      previousOutboxCount: 4,
      previousActiveDeliveryCount: 2,
      canRemovePrevious: false,
    })
    const outboxSql = db.calls.find(call => call.sql.includes('FROM meta_capi_secure_outbox'))?.sql ?? ''
    const deliverySql = db.calls.find(call => call.sql.includes('encryption_key_id'))?.sql ?? ''
    expect(outboxSql).not.toContain('expires_at')
    expect(deliverySql).toContain("status IN ('pending', 'failed')")
  })

  it('Meta 配置存在状态将纯空白 token 和 Test Event Code 视为缺失', async () => {
    const res = await createApp('admin').request('/api/admin/attribution/meta?from=2026-07-09&to=2026-07-09', {}, {
      DB: createAttributionDb(),
      APP_ENV: 'dev',
      RELEASE_COMMIT: VALID_RELEASE_COMMIT,
      META_CAPI_ACCESS_TOKEN: ' \n\t ',
      META_CAPI_TEST_EVENT_CODE: '\n  ',
    } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.connection.tokenConfigured).toBe(false)
    expect(body.data.connection.testEventCodeConfigured).toBe(false)
    expect(body.data).not.toHaveProperty('secretPresent')
    expect(body.data).not.toHaveProperty('testEventCodePresent')
  })

  it('Meta 后台只返回连接布尔与验证状态，不返回 Pixel ID、fingerprint 或 secret', async () => {
    const db = createAttributionDb()
    const res = await createApp('admin').request('/api/admin/attribution/meta?from=2026-07-09&to=2026-07-09', {}, {
      DB: db,
      ...VALID_READINESS_ENV,
    } as unknown as Bindings)
    const body = await res.json()
    const serialized = JSON.stringify(body)

    expect(res.status).toBe(200)
    expect(body.data.connection).toMatchObject({
      state: 'unverified',
      environment: 'dev',
      pixelIdConfigured: true,
      tokenConfigured: true,
      testEventCodeConfigured: true,
      verifiedAt: null,
      verifiedCommit: null,
      graphApiVersion: 'v25.0',
      datasetQualityStatus: 'not_checked',
      invalidationReason: 'verification_missing',
    })
    expect(body.data.settings).not.toHaveProperty('facebook_pixel_id')
    expect(body.data.connection).not.toHaveProperty('fingerprint')
    expect(body.data.connection).not.toHaveProperty('traceId')
    expect(serialized).not.toContain('secret-token')
    expect(serialized).not.toContain('test-code')
  })

  it('Meta 匹配覆盖率固定使用近 7 天合格 CAPI 与 Meta 付费样本', async () => {
    const db = createAttributionDb({
      readiness: {
        fbpSampleCount: 25,
        fbpMatchedCount: 20,
        fbcSampleCount: 20,
        fbcMatchedCount: 14,
      },
    })
    const res = await createApp('admin').request('/api/admin/attribution/meta?range=30d', {}, {
      DB: db,
      APP_ENV: 'dev',
      RELEASE_COMMIT: VALID_RELEASE_COMMIT,
    } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.matchQuality).toMatchObject({
      fbpCoverage: 0.8,
      fbpSampleCount: 25,
      fbcCoverage: 0.7,
      fbcSampleCount: 20,
    })
    const coverageSql = db.calls.find(call => call.sql.includes('AS fbp_sample_count'))?.sql ?? ''
    expect(coverageSql).toContain("date('now', '-6 days')")
    expect(coverageSql).toContain("d.status IN ('pending', 'sent', 'failed', 'duplicate_suppressed')")
    expect(coverageSql).toContain("a.source_channel = 'ad'")
    expect(coverageSql).toContain("lower(a.utm_source) IN ('facebook', 'fb', 'meta', 'instagram')")
    expect(coverageSql).not.toContain("d.status = 'skipped'")
  })

  it('返回重复诊断和重复样本', async () => {
    const res = await createApp('admin').request('/api/admin/attribution/duplicates?from=2026-07-09&to=2026-07-09', {}, { DB: createAttributionDb() } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.duplicateSuppressedCount).toBe(1)
    expect(body.data.duplicateActionCount).toBe(1)
    expect(body.data.samples[0]).toMatchObject({ id: 'convdup_1', duplicate_of: 'conv_1' })
  })

  it('非零历史 StartTrial delivery 不影响当前 Meta 指标、重复诊断或 readiness', async () => {
    const readiness = {
      fbpSampleCount: 20,
      fbpMatchedCount: 16,
      fbcSampleCount: 20,
      fbcMatchedCount: 14,
      pixelAttemptedCount: 20,
      capiSentCount: 16,
    }
    const dbOptions: AttributionDbOptions = {
      historicalStartTrialDeliveryCount: 37,
      readiness,
    }
    const db = createAttributionDb(dbOptions)
    const app = createApp('admin')
    const env = { DB: db, ...VALID_READINESS_ENV } as unknown as Bindings
    const [overviewResponse, metaResponse, duplicatesResponse, readinessResponse] = await Promise.all([
      app.request('/api/admin/attribution/overview?from=2026-07-09&to=2026-07-09', {}, env),
      app.request('/api/admin/attribution/meta?from=2026-07-09&to=2026-07-09', {}, env),
      app.request('/api/admin/attribution/duplicates?from=2026-07-09&to=2026-07-09', {}, env),
      app.request('/api/admin/attribution/readiness?from=2026-07-09&to=2026-07-09', {}, env),
    ])
    const [overview, meta, duplicates, historicalReadiness] = await Promise.all([
      overviewResponse.json(),
      metaResponse.json(),
      duplicatesResponse.json(),
      readinessResponse.json(),
    ])
    const { body: baselineReadiness } = await requestReadiness({ readiness })

    expect(overview.data.meta).toMatchObject({
      pixel_attempted_count: 20,
      capi_sent_count: 16,
      capi_failed_count: 0,
      capi_duplicate_suppressed_count: 1,
      last_sent_at: '2026-07-09T10:00:00.000Z',
    })
    expect(overview.data.duplicates).toMatchObject({
      duplicate_suppressed_count: 1,
      duplicate_action_count: 1,
      duplicate_rate: 0.0588,
    })
    expect(meta.data.totals).toMatchObject({
      pixel_attempted_count: 20,
      capi_sent_count: 16,
      capi_failed_count: 0,
      retry_exhausted_count: 0,
      duplicate_suppressed_count: 1,
    })
    expect(meta.data.lastSentAt).toBe('2026-07-09T10:00:00.000Z')
    expect(meta.data.matchQuality).toMatchObject({ fbpCoverage: 0.8, fbpSampleCount: 20, fbcCoverage: 0.7, fbcSampleCount: 20 })
    expect(meta.data.deliveries.every((row: { event_name: string }) => ['Contact', 'CompleteRegistration'].includes(row.event_name))).toBe(true)
    expect(duplicates.data).toMatchObject({ duplicateSuppressedCount: 1, duplicateActionCount: 1, duplicateRate: 0.25 })
    expect(duplicates.data.samples.every((row: { action_type: string }) => row.action_type !== 'start_trial')).toBe(true)

    const checkStates = (body: {
      data: { checks: Array<{ key: string; level: string; ok: boolean }> }
    }) => body.data.checks.map((check) => ({
      key: check.key,
      level: check.level,
      ok: check.ok,
    }))
    expect(historicalReadiness.data.ready).toBe(true)
    expect(checkStates(historicalReadiness)).toEqual(checkStates(baselineReadiness))

    const dailyQueries = db.calls.filter(call => call.sql.includes('FROM analytics_conversion_delivery_daily'))
    const deliveryQueries = db.calls.filter(call => (
      call.sql.includes('FROM analytics_conversion_deliveries')
      && !call.sql.includes('encryption_key_id')
    ))
    const duplicateActionQueries = db.calls.filter(call => call.sql.includes('FROM analytics_conversion_actions') && call.sql.includes("duplicate_of != ''"))
    expect(dailyQueries.length).toBeGreaterThan(0)
    expect(dailyQueries.every(call => call.sql.includes("event_name IN ('Contact', 'CompleteRegistration')"))).toBe(true)
    expect(deliveryQueries.length).toBeGreaterThan(0)
    expect(deliveryQueries.every(call => (
      call.sql.includes('JOIN analytics_conversion_actions a ON a.id = d.conversion_action_id') &&
      call.sql.includes("a.action_type IN ('contact', 'complete_registration')")
    ))).toBe(true)
    expect(duplicateActionQueries.length).toBeGreaterThan(0)
    expect(duplicateActionQueries.every(call => call.sql.includes("action_type IN ('contact', 'complete_registration', 'membership_grant')"))).toBe(true)
  })

  it('当前重复诊断保留 membership_grant 且排除历史 StartTrial', async () => {
    const db = createAttributionDb({
      historicalStartTrialDeliveryCount: 37,
      membershipGrantDuplicateCount: 1,
    })
    const app = createApp('admin')
    const env = { DB: db } as unknown as Bindings
    const [overviewResponse, duplicatesResponse] = await Promise.all([
      app.request('/api/admin/attribution/overview?from=2026-07-09&to=2026-07-09', {}, env),
      app.request('/api/admin/attribution/duplicates?from=2026-07-09&to=2026-07-09', {}, env),
    ])
    const [overview, duplicates] = await Promise.all([
      overviewResponse.json(),
      duplicatesResponse.json(),
    ])

    expect(overview.data.duplicates.duplicate_action_count).toBe(2)
    expect(duplicates.data.duplicateActionCount).toBe(2)
    expect(duplicates.data.samples.map((row: { action_type: string }) => row.action_type)).toEqual(expect.arrayContaining([
      'contact',
      'membership_grant',
    ]))
    expect(duplicates.data.samples.some((row: { action_type: string }) => row.action_type === 'start_trial')).toBe(false)

    const duplicateActionQueries = db.calls.filter(call => (
      call.sql.includes('FROM analytics_conversion_actions') && call.sql.includes("duplicate_of != ''")
    ))
    expect(duplicateActionQueries.length).toBeGreaterThan(0)
    expect(duplicateActionQueries.every(call => call.sql.includes("action_type IN ('contact', 'complete_registration', 'membership_grant')"))).toBe(true)

    const deliveryQueries = db.calls.filter(call => call.sql.includes('FROM analytics_conversion_deliveries'))
    expect(deliveryQueries.length).toBeGreaterThan(0)
    expect(deliveryQueries.every(call => (
      call.sql.includes("a.action_type IN ('contact', 'complete_registration')")
    ))).toBe(true)
  })

  it('返回分层归因上线检查且 ready 只由 blocker 决定', async () => {
    const { res, body } = await requestReadiness({ readiness: { pendingTooLongCount: 1 } })

    expect(res.status).toBe(200)
    expect(body.data.ready).toBe(true)
    expect(body.data.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'meta_live_verification', level: 'blocker', ok: true }),
      expect.objectContaining({ key: 'meta_resources_verification', level: 'blocker', ok: true }),
      expect.objectContaining({ key: 'pending_too_long', level: 'warning', ok: false }),
    ]))
  })

  it('conversion ledger 只使用 Contact 和完成注册活动事实', async () => {
    const { db, body } = await requestReadiness({ readiness: { actionCount: 0 } })
    const ledger = body.data.checks.find((item: { key: string }) => item.key === 'conversion_ledger')
    const ledgerSql = db.calls.find(call => call.sql.includes('SUM(action_count)') && call.sql.includes('analytics_conversion_daily'))?.sql ?? ''

    expect(ledger).toMatchObject({ key: 'conversion_ledger', level: 'blocker', ok: false })
    expect(body.data.ready).toBe(false)
    expect(ledgerSql).toContain("action_type IN ('contact', 'complete_registration')")
  })

  it.each([
    ['2026-07-10T11:59:59.000Z', false],
    ['2026-07-10T12:00:01.000Z', true],
    ['invalid', false],
    ['', false],
  ] as const)('release verification expires_at=%s 时有效状态为 %s', async (expiresAt, expected) => {
    vi.useFakeTimers()
    vi.setSystemTime('2026-07-10T12:00:00.000Z')
    const { db, body } = await requestReadiness({
      readiness: {
        liveVerificationExpiresAt: expiresAt,
        resourcesVerificationExpiresAt: expiresAt,
      },
    })
    const live = body.data.checks.find((item: { key: string }) => item.key === 'meta_live_verification')
    const resources = body.data.checks.find((item: { key: string }) => item.key === 'meta_resources_verification')
    const verificationSql = db.calls.find(call => call.sql.includes('FROM analytics_release_verifications') && call.sql.includes('GROUP BY verification_type'))?.sql ?? ''

    expect(live.ok).toBe(expected)
    expect(resources.ok).toBe(expected)
    expect(body.data.ready).toBe(expected)
    expect(verificationSql).toContain("datetime(expires_at) > datetime('now')")
    expect(verificationSql).not.toContain("AND expires_at > datetime('now')")
  })

  it.each([
    ['capi_secret', { META_CAPI_ACCESS_TOKEN: ' \n\t ' }],
    ['test_event_code', { META_CAPI_TEST_EVENT_CODE: '\n   ' }],
  ] as const)('readiness 将纯空白配置判定为 %s 缺失', async (key, envOverrides) => {
    const { body } = await requestReadiness({}, envOverrides)
    const check = body.data.checks.find((item: { key: string }) => item.key === key)

    expect(check).toMatchObject({ key, level: 'blocker', ok: false })
    expect(body.data.ready).toBe(false)
  })

  it.each([
    ['internal Test Event CAPI-only', { sourceChannel: 'internal', pixel: [], capi: ['test'] }, true],
    ['首次 Pixel-only', { sourceChannel: 'ad', pixel: ['pixel-only'], capi: [] }, true],
    ['CAPI-only', { sourceChannel: 'ad', pixel: [], capi: ['capi-only'] }, true],
    ['双渠道一一匹配', { sourceChannel: 'ad', pixel: ['z'], capi: ['z'] }, true],
    ['双渠道 Pixel 多值', { sourceChannel: 'ad', pixel: ['a', 'z'], capi: ['z'] }, false],
    ['双渠道值不同', { sourceChannel: 'ad', pixel: ['a'], capi: ['z'] }, false],
  ] as const)('%s 的 external event ID 集合 %j 一致性为 %s', async (_label, externalEventIds, expected) => {
    const { db, body } = await requestReadiness({ readiness: { externalEventIds } })
    const check = body.data.checks.find((item: { key: string }) => item.key === 'external_event_id_consistency')
    const mismatchSql = db.calls.find(call => call.sql.includes('AS external_event_id_mismatch_count'))?.sql ?? ''

    expect(check).toMatchObject({ key: 'external_event_id_consistency', level: 'blocker', ok: expected })
    expect(body.data.ready).toBe(expected)
    expect(mismatchSql).toContain('JOIN analytics_conversion_actions a ON a.id = d.conversion_action_id')
    expect(mismatchSql).toContain("a.source_channel <> 'internal'")
    expect(mismatchSql).toContain("COUNT(DISTINCT CASE WHEN d.channel = 'meta_pixel' THEN d.external_event_id END) > 0")
    expect(mismatchSql).toContain("COUNT(DISTINCT CASE WHEN d.channel = 'meta_capi' THEN d.external_event_id END) > 0")
    expect(mismatchSql).toContain("COUNT(DISTINCT CASE WHEN d.channel = 'meta_pixel' THEN d.external_event_id END)")
    expect(mismatchSql).toContain("COUNT(DISTINCT CASE WHEN d.channel = 'meta_capi' THEN d.external_event_id END)")
    expect(mismatchSql).toContain('COUNT(DISTINCT d.external_event_id)')
    expect(mismatchSql).not.toContain('MAX(')
  })

  it('readiness 的 ISO 时间字段统一经过 SQLite datetime 解析后比较', async () => {
    const { db } = await requestReadiness()
    const sqlByAlias = (alias: string) => db.calls.find(call => call.sql.includes(alias))?.sql ?? ''

    expect(sqlByAlias('AS retry_exhausted_count')).toContain("datetime(d.last_attempt_at) >= datetime('now', '-24 hours')")
    expect(sqlByAlias('AS external_event_id_mismatch_count')).toContain("datetime(d.created_at) >= datetime('now', '-7 days')")
    expect(sqlByAlias('AS pending_too_long_count')).toContain("datetime(d.created_at) < datetime('now', '-10 minutes')")
    expect(sqlByAlias('AS permanent_failure_count')).toContain("datetime(d.updated_at) >= datetime('now', '-7 days')")
  })

  it.each([
    ['conversion_schema', { readiness: { schemaTableCount: 3 } }, {}],
    ['analytics_enabled', { settings: { analytics_enabled: false } }, {}],
    ['conversion_ledger', { readiness: { actionCount: 0 } }, {}],
    ['pixel_mode_consistency', { settings: { facebook_pixel_enabled: false } }, {}],
    ['capi_secret', {}, { META_CAPI_ACCESS_TOKEN: undefined }],
    ['test_event_code', {}, { META_CAPI_TEST_EVENT_CODE: undefined }],
    ['queue_binding', {}, { META_CAPI_QUEUE: undefined }],
    ['meta_live_verification', {}, { RELEASE_COMMIT: 'not-a-full-commit' }],
    ['meta_live_verification', { readiness: { liveVerificationPresent: false } }, {}],
    ['meta_resources_verification', { readiness: { resourcesVerificationPresent: false } }, {}],
    ['retry_exhausted', { readiness: { retryExhaustedCount: 1 } }, {}],
    ['external_event_id_consistency', { readiness: { externalEventIdMismatchCount: 1 } }, {}],
  ] as const)('blocker %s 独立失败时 readiness 不通过', async (key, dbOptions, envOverrides) => {
    const { body } = await requestReadiness(dbOptions, envOverrides as Partial<Bindings>)
    const check = body.data.checks.find((item: { key: string }) => item.key === key)

    expect(check).toMatchObject({ key, level: 'blocker', ok: false })
    expect(body.data.ready).toBe(false)
  })

  it.each([
    ['pending_too_long', { pendingTooLongCount: 1 }],
    ['permanent_failure', { permanentFailureCount: 1 }],
    ['fbp_coverage', { fbpSampleCount: 20, fbpMatchedCount: 15 }],
    ['fbc_coverage', { fbcSampleCount: 20, fbcMatchedCount: 13 }],
    ['capi_delivery_ratio', { pixelAttemptedCount: 20, capiSentCount: 15 }],
    ['manual_confirmation', { lastManualConfirmationAt: '2026-01-01T00:00:00.000Z' }],
  ] as const)('warning %s 独立异常时不阻断 ready', async (key, readinessOverride) => {
    const { body } = await requestReadiness({ readiness: readinessOverride })
    const check = body.data.checks.find((item: { key: string }) => item.key === key)

    expect(check).toMatchObject({ key, level: 'warning', ok: false })
    expect(body.data.ready).toBe(true)
  })

  it.each([
    ['fbp_coverage', { fbpSampleCount: 19, fbpMatchedCount: 0 }],
    ['fbc_coverage', { fbcSampleCount: 19, fbcMatchedCount: 0 }],
    ['capi_delivery_ratio', { pixelAttemptedCount: 19, capiSentCount: 0 }],
  ] as const)('%s 样本不足时不判定质量异常', async (key, readinessOverride) => {
    const { body } = await requestReadiness({ readiness: readinessOverride })
    const check = body.data.checks.find((item: { key: string }) => item.key === key)

    expect(check).toMatchObject({ key, level: 'warning', ok: true })
    expect(check.detail).toContain('样本不足')
  })

  it('非 owner 不能触发 Test Event', async () => {
    const db = createAttributionDb()
    const res = await createApp('admin').request('/api/admin/attribution/meta/test-event', { method: 'POST' }, { DB: db } as unknown as Bindings)
    expect(res.status).toBe(403)
    expect(db.calls.some(call => (
      call.sql.includes('INSERT INTO admin_audit_logs')
      && call.params[2] === 'attribution.meta_test_event'
    ))).toBe(true)
  })

  it('production bootstrap 固定 409，且在业务记录、Graph fetch 与 verification upsert 前阻断', async () => {
    const db = createAttributionDb({ settings: { meta_tracking_mode: 'production' } })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const res = await createApp('owner').request('/api/admin/attribution/meta/test-event', { method: 'POST' }, {
      DB: db,
      ...VALID_READINESS_ENV,
      APP_ENV: 'production',
    } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body.code).toBe('META_PRODUCTION_TEST_GATE_PENDING')
    expect(db.calls.some(call => call.sql.includes('INSERT INTO admin_audit_logs'))).toBe(true)
    expect(db.calls.some(call => call.sql.includes('INSERT INTO analytics_conversion_actions'))).toBe(false)
    expect(db.calls.some(call => call.sql.includes('INSERT INTO analytics_conversion_deliveries'))).toBe(false)
    expect(db.calls.some(call => call.sql.includes('INSERT INTO meta_connection_verifications'))).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ['Queue binding', { META_CAPI_QUEUE: undefined }],
    ['data key', { META_CAPI_DATA_KEY_CURRENT: undefined }],
    ['非法 data key', { META_CAPI_DATA_KEY_CURRENT: 'not-base64' }],
  ])('dev bootstrap 缺少或非法 %s 时不创建记录、不 fetch 且写审计', async (_label, overrides) => {
    const db = createAttributionDb()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const res = await createApp('owner').request('/api/admin/attribution/meta/test-event', { method: 'POST' }, {
      DB: db,
      ...VALID_READINESS_ENV,
      META_CAPI_DATA_KEY_CURRENT: Buffer.alloc(32, 7).toString('base64'),
      ...overrides,
    } as unknown as Bindings)

    expect(res.status).toBe(503)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(db.calls.some(call => call.sql.includes('INSERT INTO analytics_conversion_actions'))).toBe(false)
    expect(db.calls.some(call => call.sql.includes('INSERT INTO analytics_conversion_deliveries'))).toBe(false)
    expect(db.calls.some(call => call.sql.includes('INSERT INTO meta_connection_verifications'))).toBe(false)
    expect(db.calls.some(call => call.sql.includes('INSERT INTO admin_audit_logs'))).toBe(true)
  })

  it('dev bootstrap 只发送固定合成值，不读取请求或 Owner 匹配信号', async () => {
    const db = createAttributionDb()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ events_received: 1 }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const res = await createApp('owner').request('/api/admin/attribution/meta/test-event', {
      method: 'POST',
      headers: {
        'CF-Connecting-IP': '203.0.113.24',
        'User-Agent': 'Owner-Request-Agent/1.0',
        Cookie: '_fbp=fb.1.1700000000000.private; _fbc=fb.1.1700000000000.private',
      },
      body: JSON.stringify({
        email: 'owner@example.test',
        externalId: 'owner-42',
        test_event_code: 'request-code-must-not-win',
      }),
    }, {
      DB: db,
      ...VALID_READINESS_ENV,
      META_CAPI_DATA_KEY_CURRENT: Buffer.alloc(32, 7).toString('base64'),
    } as unknown as Bindings)

    expect(res.status).toBe(200)
    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(payload.data[0].user_data).toEqual({
      client_ip_address: '192.0.2.1',
      client_user_agent: 'MeiGallery MetaConnection Synthetic Test/1.0',
    })
    const serialized = JSON.stringify({ payload, response: await res.clone().json(), calls: db.calls })
    expect(serialized).not.toContain('owner@example.test')
    expect(serialized).not.toContain('owner-42')
    expect(serialized).not.toContain('203.0.113.24')
    expect(serialized).not.toContain('Owner-Request-Agent/1.0')
    expect(serialized).not.toContain('request-code-must-not-win')
    expect(db.calls.some(call => call.sql.includes('INSERT INTO analytics_conversion_actions'))).toBe(false)
    expect(db.calls.some(call => call.sql.includes('INSERT INTO analytics_conversion_deliveries'))).toBe(false)
    expect(db.calls.some(call => call.sql.includes('INSERT INTO meta_connection_verifications'))).toBe(true)
  })

  it.each([
    ['token', {}, { META_CAPI_ACCESS_TOKEN: undefined }],
    ['空白 token', {}, { META_CAPI_ACCESS_TOKEN: ' \n\t ' }],
    ['Test Event Code', {}, { META_CAPI_TEST_EVENT_CODE: undefined }],
    ['空白 Test Event Code', {}, { META_CAPI_TEST_EVENT_CODE: '\n  ' }],
    ['Pixel ID', { settings: { facebook_pixel_id: '' } }, {}],
  ])('缺少 %s 时 Test Event 返回 503 并审计', async (_label, dbOptions, envOverrides) => {
    const db = createAttributionDb(dbOptions as AttributionDbOptions)
    const res = await createApp('owner').request('/api/admin/attribution/meta/test-event', { method: 'POST' }, {
      DB: db,
      ...VALID_READINESS_ENV,
      ...envOverrides,
    } as unknown as Bindings)

    expect(res.status).toBe(503)
    expect(db.calls.some(call => call.sql.includes('INSERT INTO admin_audit_logs'))).toBe(true)
    expect(db.calls.some(call => call.sql.includes('INSERT INTO analytics_conversion_deliveries'))).toBe(false)
  })

  it('Meta 确认接收 1 条 Test Event 时返回 200 且不泄露临时数据', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ events_received: 1, fbtrace_id: 'trace-safe' }), { status: 200 })))
    const db = createAttributionDb()
    const res = await createApp('owner').request('/api/admin/attribution/meta/test-event', {
      method: 'POST',
      headers: {
        'CF-Connecting-IP': '203.0.113.24',
        'User-Agent': 'Task7-Test-Agent/1.0',
      },
    }, {
      DB: db,
      ...VALID_READINESS_ENV,
    } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data).toMatchObject({
      status: 'verified',
      eventsReceived: 1,
      connection: {
        state: 'verified',
        verifiedCommit: VALID_RELEASE_COMMIT,
        graphApiVersion: 'v25.0',
      },
    })
    expect(body.data).not.toHaveProperty('traceId')
    expect(db.calls.some(call => call.sql.includes('INSERT INTO admin_audit_logs') && call.params[2] === 'attribution.meta_test_event')).toBe(true)
    expect(db.calls.some(call => call.sql.includes('INSERT INTO analytics_conversion_actions'))).toBe(false)
    expect(db.calls.some(call => call.sql.includes('INSERT INTO analytics_conversion_deliveries'))).toBe(false)
    expect(db.calls.some(call => call.sql.includes('INSERT INTO meta_connection_verifications'))).toBe(true)
    expect(db.pendingDailyCreated).toBe(0)
    expect(db.pendingDailyCount).toBe(0)
    const serialized = JSON.stringify({ body, calls: db.calls })
    expect(serialized).not.toContain('secret-token')
    expect(serialized).not.toContain('test-code')
    expect(serialized).not.toContain('203.0.113.24')
    expect(serialized).not.toContain('Task7-Test-Agent/1.0')
    expect(serialized).not.toContain('trace-safe')
  })

  it.each(['203.0.113.24', 'test-code'])('Test Event 丢弃回显敏感值的 traceId：%s', async sensitiveTraceId => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      events_received: 1,
      fbtrace_id: sensitiveTraceId,
    }), { status: 200 })))
    const db = createAttributionDb()
    const res = await createApp('owner').request('/api/admin/attribution/meta/test-event', {
      method: 'POST',
      headers: {
        'CF-Connecting-IP': '203.0.113.24',
        'User-Agent': 'Task7-Test-Agent/1.0',
      },
    }, {
      DB: db,
      ...VALID_READINESS_ENV,
    } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(JSON.stringify({ body, calls: db.calls })).not.toContain(sensitiveTraceId)
  })

  it.each([
    ['permanent', 400, 424],
    ['events_not_received', 200, 424],
    ['retryable', 500, 503],
  ] as const)('Meta %s 结果不会返回成功状态', async (_kind, metaStatus, expectedStatus) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify(metaStatus === 200 ? { events_received: 0 } : { error: { message: 'sensitive upstream error' } }),
      { status: metaStatus },
    )))
    const db = createAttributionDb()
    const res = await createApp('owner').request('/api/admin/attribution/meta/test-event', { method: 'POST' }, {
      DB: db,
      ...VALID_READINESS_ENV,
    } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(expectedStatus)
    expect(body.data?.status).not.toBe('verified')
    expect(JSON.stringify({ body, calls: db.calls })).not.toContain('sensitive upstream error')
  })

  it('rollout GET 返回 target、critical incident 熔断后的 effective 与晋级检查', async () => {
    const { res, body } = await requestRollout('admin', {
      target: 10,
      incidentSeverity: 'critical',
    })

    expect(res.status).toBe(200)
    expect(body.data).toMatchObject({
      targetPercentage: 10,
      effectivePercentage: 0,
      promotion: {
        from: 10,
        to: 50,
        allowed: false,
        hardBlockers: ['circuit_open'],
      },
      openIncident: {
        id: 'incident_rollout_open',
        severity: 'critical',
        triggerCode: 'meta_permission_denied',
      },
    })
    expect(JSON.stringify(body)).not.toContain('rollout-token')
  })

  it('warning incident 不熔断 rollout', async () => {
    const { res, body } = await requestRollout('admin', {
      target: 10,
      incidentSeverity: 'warning',
    })

    expect(res.status).toBe(200)
    expect(body.data).toMatchObject({
      targetPercentage: 10,
      effectivePercentage: 10,
      openIncident: null,
    })
  })

  it('POST rollout 显式要求 Owner', async () => {
    const { db, res, body } = await requestRollout('admin', { target: 0 }, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ percentage: 10, force: false }),
    })

    expect(res.status).toBe(403)
    expect(body.code).toBe('OWNER_REQUIRED')
    expect(db.batchCount).toBe(0)
    expect(db.audits).toEqual([])
  })

  it.each([
    ['connection_unverified', { connectionVerified: false }, {}],
    ['meta_live_verification_missing', { liveEvidence: false }, {}],
    ['release_commit_invalid', {}, { RELEASE_COMMIT: 'invalid' }],
  ] as const)('0 -> 10 不允许绕过硬门禁 %s', async (blocker, dbOptions, envOverrides) => {
    const { db, res, body } = await requestRollout('owner', { target: 0, ...dbOptions }, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        percentage: 10,
        force: true,
        reason: '当前指标已有人工复核确认风险受控并持续观察运行状态',
      }),
    }, envOverrides)

    expect(res.status).toBe(409)
    expect(body.code).toBe('META_CAPI_ROLLOUT_PROMOTION_BLOCKED')
    expect(body.detail.blockers).toContain(blocker)
    expect(db.batchCount).toBe(0)
  })

  it('升级只允许相邻档位，force 不能绕过跳级', async () => {
    const { db, res, body } = await requestRollout('owner', { target: 0 }, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        percentage: 50,
        force: true,
        reason: '当前指标已有人工复核确认风险受控并持续观察运行状态',
      }),
    })

    expect(res.status).toBe(409)
    expect(body.detail.blockers).toContain('non_adjacent_promotion')
    expect(db.batchCount).toBe(0)
  })

  it.each([
    [10, 50],
    [50, 100],
  ] as const)('普通 %i -> %i 不因 dev meta_live 缺失被阻止', async (target, percentage) => {
    const { db, res, body } = await requestRollout('owner', {
      target,
      liveEvidence: false,
    }, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ percentage, force: false }),
    })

    expect(res.status).toBe(200)
    expect(body.data).toMatchObject({
      targetPercentage: percentage,
      effectivePercentage: percentage,
      liveEvidencePresent: false,
      changed: true,
    })
    expect(db.target).toBe(percentage)
  })

  it.each([
    ['meta_live_verification_missing', { liveEvidence: false }, {}],
    ['release_commit_invalid', {}, { RELEASE_COMMIT: 'invalid' }],
  ] as const)('force 升级仍要求当前 commit 的 dev meta_live 门禁：%s', async (
    blocker,
    dbOptions,
    envOverrides,
  ) => {
    const reason = '当前指标已有人工复核确认风险受控并持续观察运行状态'
    const { db, res, body } = await requestRollout('owner', {
      target: 10,
      sent: 9,
      ...dbOptions,
    }, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ percentage: 50, force: true, reason }),
    }, envOverrides)

    expect(res.status).toBe(409)
    expect(body.code).toBe('META_CAPI_ROLLOUT_PROMOTION_BLOCKED')
    expect(body.detail.blockers).toContain(blocker)
    expect(db.batchCount).toBe(0)
  })

  it('GET 暴露证据缺失状态，但普通 10 -> 50 晋级检查不把它列为 blocker', async () => {
    const { res, body } = await requestRollout('admin', {
      target: 10,
      liveEvidence: false,
    })

    expect(res.status).toBe(200)
    expect(body.data).toMatchObject({
      liveEvidencePresent: false,
      promotion: {
        from: 10,
        to: 50,
        allowed: true,
        hardBlockers: [],
      },
    })
  })

  it('指标不达标时 force 需要至少 20 个汉字，合格后以同一 batch 更新与审计', async () => {
    const short = await requestRollout('owner', { target: 10, sent: 9 }, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ percentage: 50, force: true, reason: '风险已人工确认' }),
    })
    expect(short.res.status).toBe(400)
    expect(short.body.code).toBe('META_CAPI_ROLLOUT_FORCE_REASON_INVALID')
    expect(short.db.batchCount).toBe(0)

    const reason = '当前指标已有人工复核确认风险受控并持续观察运行状态'
    const forced = await requestRollout('owner', { target: 10, sent: 9 }, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ percentage: 50, force: true, reason }),
    })

    expect(forced.res.status).toBe(200)
    expect(forced.body.data).toMatchObject({ targetPercentage: 50, effectivePercentage: 50, changed: true })
    expect(forced.db.target).toBe(50)
    expect(forced.db.batchCount).toBe(1)
    expect(forced.db.audits).toHaveLength(1)
    expect(forced.db.calls.some(call => (
      call.sql.includes('INSERT INTO admin_audit_logs')
      && call.params[2] === 'attribution.meta_rollout_update'
    ))).toBe(true)
    expect(forced.db.audits[0]).toEqual({
      before: { percentage: 10 },
      after: {
        percentage: 50,
        force: true,
        reason,
        blockers: ['insufficient_attempts'],
        environment: 'dev',
      },
    })
    expect(JSON.stringify(forced.db.audits)).not.toContain('rollout-token')
  })

  it('同值为 no-op 不写审计，降级到任意低档位始终允许', async () => {
    const same = await requestRollout('owner', { target: 50 }, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ percentage: 50, force: false }),
    })
    expect(same.res.status).toBe(200)
    expect(same.body.data.changed).toBe(false)
    expect(same.db.batchCount).toBe(0)
    expect(same.db.audits).toEqual([])

    const downgrade = await requestRollout('owner', {
      target: 100,
      incidentSeverity: 'critical',
      sent: 0,
      failed: 100,
    }, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ percentage: 10, force: false }),
    })
    expect(downgrade.res.status).toBe(200)
    expect(downgrade.db.target).toBe(10)
    expect(downgrade.db.audits).toHaveLength(1)
  })

  it('旧值条件冲突时返回稳定错误码且不写误导性审计', async () => {
    const { db, res, body } = await requestRollout('owner', { target: 0, conflict: true }, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ percentage: 10, force: false }),
    })

    expect(res.status).toBe(409)
    expect(body.code).toBe('META_CAPI_ROLLOUT_CONFLICT')
    expect(db.target).toBe(0)
    expect(db.audits).toEqual([])
  })
})
