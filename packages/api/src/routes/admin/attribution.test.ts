import { Buffer } from 'node:buffer'
import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Bindings, Variables } from '../../index'
import { adminRoutes } from './index'
import { MetaCapiCircuitError } from '../../services/meta-capi-circuit-breaker'

const { closeIncidentMock } = vi.hoisted(() => ({
  closeIncidentMock: vi.fn(),
}))

vi.mock('../../services/meta-capi-circuit-breaker', async importOriginal => ({
  ...await importOriginal<typeof import('../../services/meta-capi-circuit-breaker')>(),
  closeMetaCapiIncident: closeIncidentMock,
}))

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
  connectionVerified?: boolean
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
  incidentRows?: Array<Record<string, unknown>>
  incidentQueryError?: boolean
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
    enabled: true,
    browser_enabled: true,
    destination_id: '1234567890',
    server_enabled: false,
    debug_enabled: false,
    rollout_percentage: 0,
    mode: 'test',
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
    provider: 'meta'
    transport: 'server'
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
  } | null = options.connectionVerified ? {
    environment: 'dev',
    pixel_id: String(settings.destination_id),
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
  } : null
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
          if (sql.includes("SELECT key, value FROM site_settings WHERE key = 'analytics_enabled'")
            && sql.includes('FROM ad_platform_connections')) {
            return {
              results: [
                { key: 'analytics_enabled', value: JSON.stringify(settings.analytics_enabled) },
                { key: 'enabled', value: String(Boolean(settings.enabled)) },
                { key: 'browser_enabled', value: String(Boolean(settings.browser_enabled)) },
                { key: 'server_enabled', value: String(Boolean(settings.server_enabled)) },
                { key: 'destination_configured', value: String(Boolean(settings.destination_id)) },
                { key: 'mode', value: JSON.stringify(settings.mode) },
              ] as T[],
              meta: { rows_read: 2, rows_written: 0, duration: 1 },
            }
          }
          if (sql.includes('FROM meta_capi_incidents')) {
            if (options.incidentQueryError) throw new Error('模拟 incident 查询失败')
            return {
              results: (options.incidentRows ?? []) as T[],
              meta: { rows_read: options.incidentRows?.length ?? 0, rows_written: 0, duration: 1 },
            }
          }
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
          if (sql.includes('AS membership_grant_count')
            && sql.includes("action_type = 'membership_grant'")
            && !sql.includes('FROM analytics_tracking_sources')) {
            return {
              results: [{ membership_grant_count: attributionTotals.membershipGrantCount } as T],
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
          if (sql.includes('FROM analytics_conversion_delivery_daily') && sql.includes('GROUP BY transport')) {
            const results = [
              { transport: 'browser', event_name: 'Contact', status: 'attempted', skip_reason: '', delivery_count: 2 },
              { transport: 'server', event_name: 'Contact', status: 'sent', skip_reason: '', delivery_count: 1 },
              { transport: 'server', event_name: 'Contact', status: 'duplicate_suppressed', skip_reason: '', delivery_count: 1 },
            ]
            if (dailyHistoryLeak(sql) > 0) {
              results.push({
                transport: 'server',
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
          if (sql.includes('FROM ad_platform_connections')) {
            return {
              results: [{
                provider: 'meta',
                enabled: settings.enabled ? 1 : 0,
                mode: settings.mode,
                browser_enabled: settings.browser_enabled ? 1 : 0,
                server_enabled: settings.server_enabled ? 1 : 0,
                destination_id: settings.destination_id,
                debug_enabled: settings.debug_enabled ? 1 : 0,
                rollout_percentage: Number(settings.rollout_percentage),
                credential_secret_name: 'META_CAPI_ACCESS_TOKEN',
                revision: metaConnectionVerification?.revision ?? null,
              }] as T[],
              meta: { rows_read: 1, rows_written: 0, duration: 1 },
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
          if (sql.includes('FROM ad_platform_connections')) {
            return {
              provider: 'meta',
              enabled: settings.enabled ? 1 : 0,
              mode: settings.mode,
              browser_enabled: settings.browser_enabled ? 1 : 0,
              server_enabled: settings.server_enabled ? 1 : 0,
              destination_id: settings.destination_id,
              debug_enabled: settings.debug_enabled ? 1 : 0,
              rollout_percentage: Number(settings.rollout_percentage),
              credential_secret_name: 'META_CAPI_ACCESS_TOKEN',
              revision: metaConnectionVerification?.revision ?? null,
            } as T
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
              provider: 'meta',
              transport: 'server',
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

type DashboardDbOptions = {
  empty?: boolean
  fail?: boolean
  matchDenominator?: number
  datasetQualityRows?: Array<Record<string, unknown>>
}

function createDashboardDb(options: DashboardDbOptions = {}) {
  const calls: DbCall[] = []
  const usage = { rows_read: 1, rows_written: 0, duration: 1 }
  const matchDenominator = options.matchDenominator ?? 4

  function rowsFor(sql: string): Array<Record<string, unknown>> {
    if (options.fail) throw new Error('模拟 dashboard 查询失败')
    if (sql.includes('WITH action_facts')) {
      return options.empty
        ? []
        : [{
            dimension_value: 'summer-campaign',
            action_count: 5,
            contact_count: 3,
            complete_registration_count: 2,
            pixel_attempted_count: 5,
            capi_sent_count: 4,
            failed_count: 1,
            skipped_count: 0,
            pending_count: 0,
          }]
    }
    if (sql.includes('AS historical_lead_count')) {
      return [{ historical_lead_count: options.empty ? 0 : 9 }]
    }
    if (sql.includes('AS total_action_count')) {
      return [{
        contact_count: options.empty ? 0 : 3,
        complete_registration_count: options.empty ? 0 : 2,
        total_action_count: options.empty ? 0 : 5,
      }]
    }
    if (sql.includes('AS retry_exhausted_count') && !sql.includes('GROUP BY')) {
      return [{ retry_exhausted_count: options.empty ? 0 : 1 }]
    }
    if (sql.includes('AS retry_exhausted_count') && sql.includes('GROUP BY a.date')) {
      return options.empty ? [] : [{ date: '2026-07-10', retry_exhausted_count: 1 }]
    }
    if (sql.includes('AS pixel_attempted_count') && !sql.includes('GROUP BY date')) {
      return [{
        pixel_attempted_count: options.empty ? 0 : 5,
        capi_sent_count: options.empty ? 0 : 4,
        failed_count: options.empty ? 0 : 1,
        skipped_count: options.empty ? 0 : 2,
        pending_count: options.empty ? 0 : 3,
      }]
    }
    if (sql.includes('FROM analytics_conversion_daily') && sql.includes('GROUP BY date')) {
      return options.empty
        ? []
        : [{ date: '2026-07-10', contact_count: 3, complete_registration_count: 2 }]
    }
    if (sql.includes('FROM analytics_conversion_delivery_daily') && sql.includes('GROUP BY date')) {
      return options.empty
        ? []
        : [{
            date: '2026-07-10',
            pixel_attempted_count: 5,
            capi_sent_count: 4,
            failed_count: 1,
            skipped_count: 2,
            pending_count: 3,
          }]
    }
    if (sql.includes('AS fbp_numerator')) {
      return [{
        date: '2026-07-10',
        fbp_numerator: matchDenominator > 0 ? 3 : 0,
        fbp_denominator: matchDenominator,
        fbc_numerator: matchDenominator > 0 ? 2 : 0,
        fbc_denominator: matchDenominator,
        email_numerator: matchDenominator > 0 ? 4 : 0,
        email_denominator: matchDenominator,
        external_id_numerator: matchDenominator > 0 ? 1 : 0,
        external_id_denominator: matchDenominator,
      }]
    }
    if (sql.includes('FROM meta_dataset_quality_snapshots')) {
      return options.datasetQualityRows ?? []
    }
    return []
  }

  const db = {
    calls,
    prepare(sql: string) {
      const call: DbCall = { sql, params: [] }
      return {
        bind(...params: unknown[]) {
          call.params = params
          return this
        },
        async all<T>() {
          calls.push(call)
          const results = rowsFor(sql) as T[]
          return { results, meta: { ...usage, rows_read: results.length } }
        },
        async first<T>() {
          calls.push(call)
          return (rowsFor(sql)[0] ?? null) as T | null
        },
      }
    },
  }
  return db
}

function createMetaStatusUsageDb() {
  const calls: DbCall[] = []

  function queryUsage(sql: string) {
    if (sql.includes('FROM ad_platform_connections')) return 5
    if (sql.includes("key = 'destination_id'")) return 2
    if (sql.includes("key = 'mode'")) return 3
    if (sql.includes('FROM meta_connection_verifications')) return 5
    if (sql.includes("key = 'rollout_percentage'")) return 7
    if (sql.includes('FROM meta_capi_incidents')) return 11
    if (sql.includes('FROM analytics_release_verifications')) return 13
    if (sql.includes('AS permission_error_count')) return 17
    if (sql.includes('AS total_action_count')) return 19
    if (sql.includes('AS historical_lead_count')) return 23
    if (sql.includes('AS pixel_attempted_count')) return 29
    if (sql.includes('AS retry_exhausted_count')) return 31
    return 0
  }

  function rowsFor<T>(sql: string): T[] {
    if (sql.includes('FROM ad_platform_connections')) return [{
      provider: 'meta', enabled: 1, mode: 'test', browser_enabled: 1, server_enabled: 1,
      destination_id: '1234567890', debug_enabled: 0, rollout_percentage: 10,
      credential_secret_name: 'META_CAPI_ACCESS_TOKEN', revision: '1'.repeat(32),
    } as T]
    if (sql.includes("key = 'destination_id'")) return [{ value: JSON.stringify('1234567890') } as T]
    if (sql.includes("key = 'mode'")) return [{ value: JSON.stringify('test') } as T]
    if (sql.includes('FROM meta_connection_verifications')) return []
    if (sql.includes("key = 'rollout_percentage'")) return [{ value: JSON.stringify(10) } as T]
    if (sql.includes('FROM meta_capi_incidents')) return []
    if (sql.includes('FROM analytics_release_verifications')) return [{ id: 'verification_meta_live' } as T]
    if (sql.includes('AS permission_error_count')) {
      return [{
        sent_count: 100,
        failed_count: 0,
        permission_error_count: 0,
        retry_exhausted_count: 0,
        stale_pending_count: 0,
        critical_quality_diagnostic_count: 0,
      } as T]
    }
    if (sql.includes('AS total_action_count')) {
      return [{ contact_count: 3, complete_registration_count: 2, total_action_count: 5 } as T]
    }
    if (sql.includes('AS historical_lead_count')) return [{ historical_lead_count: 9 } as T]
    if (sql.includes('AS pixel_attempted_count')) {
      return [{ pixel_attempted_count: 5, capi_sent_count: 4, failed_count: 1, skipped_count: 2, pending_count: 3 } as T]
    }
    if (sql.includes('AS retry_exhausted_count')) return [{ retry_exhausted_count: 1 } as T]
    return []
  }

  return {
    calls,
    prepare(sql: string) {
      const call: DbCall = { sql, params: [] }
      return {
        bind(...params: unknown[]) {
          call.params = params
          return this
        },
        async all<T>() {
          calls.push(call)
          const value = queryUsage(sql)
          return {
            results: rowsFor<T>(sql),
            meta: { rows_read: value, rows_written: 0, duration: value },
          }
        },
        async first<T>() {
          calls.push(call)
          return rowsFor<T>(sql)[0] ?? null
        },
      }
    },
  }
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
  const db = createAttributionDb({ connectionVerified: true, ...dbOptions })
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
  incidentTriggerCode?: string
  incidentTriggerSummary?: string
  sent?: number
  failed?: number
  permissionErrors?: number
  retryExhausted?: number
  stalePending?: number
  criticalQualityDiagnostics?: number
  deliveryErrorCategories?: string[]
  metricsQueryError?: boolean
  conflict?: boolean
  resourceIsolation?: boolean
  trackingMode?: 'disabled' | 'test' | 'production'
  environment?: 'dev' | 'production'
  resourceSummary?: Record<string, unknown>
  trackingModeConflict?: boolean
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
        trigger_code: options.incidentTriggerCode ?? 'meta_permission_denied',
        trigger_summary: options.incidentTriggerSummary ?? 'Meta 权限拒绝',
        target_rollout_percentage: options.target ?? 0,
        effective_rollout_percentage: 0,
        opened_at: '2026-07-11T00:00:00.000Z',
        last_observed_at: '2026-07-11T00:01:00.000Z',
      } as T]
    }
    if (sql.includes('FROM analytics_release_verifications')) {
      if (options.liveEvidence === false || options.resourceIsolation === false) return []
      if (sql.includes("verification_type = 'meta_live'")) return [{ id: 'verification_meta_live' } as T]
      if (sql.includes("environment = 'production'")) {
        return [{
          summary: JSON.stringify(options.resourceSummary ?? fullResourceSummary()),
        } as T]
      }
      return [{ id: 'verification_meta_live' } as T]
    }
    if (sql.includes('AS permission_error_count')) {
      if (options.metricsQueryError) throw new Error('模拟 rollout metrics 查询失败')
      const deliveryErrorCategories = options.deliveryErrorCategories ?? []
      const queryRecognizes = (category: string) => (
        sql.includes(`'${category}'`) || params.includes(category)
      )
      const permissionErrorCategories = [
        'meta_permission_denied',
        'meta_http_401',
        'meta_http_403',
      ]
      const criticalQualityCategories = [
        ...permissionErrorCategories,
        'retry_exhausted',
      ]
      return [{
        sent_count: options.sent ?? 100,
        failed_count: options.failed ?? deliveryErrorCategories.length,
        permission_error_count: options.permissionErrors ?? deliveryErrorCategories.filter(category => (
          permissionErrorCategories.includes(category) && queryRecognizes(category)
        )).length,
        retry_exhausted_count: options.retryExhausted ?? 0,
        stale_pending_count: options.stalePending ?? 0,
        critical_quality_diagnostic_count: options.criticalQualityDiagnostics ?? deliveryErrorCategories.filter(category => (
          criticalQualityCategories.includes(category) && queryRecognizes(category)
        )).length,
      } as T]
    }
    if (sql.includes('FROM ad_platform_connections')) {
      return [{
        provider: 'meta',
        enabled: 1,
        mode: options.trackingMode ?? 'production',
        browser_enabled: 1,
        server_enabled: 1,
        destination_id: '1234567890',
        debug_enabled: 0,
        rollout_percentage: JSON.parse(targetRaw),
        credential_secret_name: 'META_CAPI_ACCESS_TOKEN',
        revision: '1'.repeat(32),
      } as T]
    }
    if (sql.includes('FROM meta_connection_verifications')) {
      if (options.connectionVerified === false) return []
      return [{
        environment: options.environment ?? 'dev',
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
          if (sql.includes('UPDATE ad_platform_connections') && sql.includes('rollout_percentage')) {
            const [nextValue, expectedValue, expectedTrackingMode] = call.params
            if (options.conflict || JSON.parse(targetRaw) !== Number(expectedValue)
              || (expectedTrackingMode && (options.trackingModeConflict || (options.trackingMode ?? 'production') !== expectedTrackingMode))) {
              lastChanges = 0
              return { meta: { changes: 0, rows_written: 0 } }
            }
            targetRaw = JSON.stringify(Number(nextValue))
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
  APP_ENV: 'production',
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
  const db = createRolloutDb({
    ...dbOptions,
    environment: envOverrides.APP_ENV === 'production' ? 'production' : 'dev',
  })
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
  vi.clearAllMocks()
})

describe('后台归因中心 API', () => {
  it('统一 Meta 连接配置仅允许 Owner 在 production 修改', async () => {
    const admin = await createApp('admin').request('/api/admin/attribution/platforms/meta', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }, {} as Bindings)
    expect(admin.status).toBe(403)
    expect((await admin.json()).code).toBe('OWNER_REQUIRED')

    const dev = await createApp('owner').request('/api/admin/attribution/platforms/meta', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }, { APP_ENV: 'dev' } as Bindings)
    expect(dev.status).toBe(409)
    expect((await dev.json()).code).toBe('AD_PLATFORM_PRODUCTION_ONLY')
  })

  it.each([
    [{ destinationId: 'bad', mode: 'test', rolloutPercentage: 0 }, 'AD_PLATFORM_DESTINATION_INVALID'],
    [{ destinationId: '1234567890', mode: 'legacy', rolloutPercentage: 0 }, 'AD_PLATFORM_MODE_INVALID'],
    [{ destinationId: '1234567890', mode: 'test', rolloutPercentage: 25 }, 'AD_PLATFORM_ROLLOUT_INVALID'],
  ] as const)('统一 Meta 连接配置拒绝非法参数 %#', async (body, code) => {
    const response = await createApp('owner').request('/api/admin/attribution/platforms/meta', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, { APP_ENV: 'production' } as Bindings)
    expect(response.status).toBe(400)
    expect((await response.json()).code).toBe(code)
  })

  it('TikTok 连接配置限制 production、校验 Pixel ID 且拒绝提前启用 Events API', async () => {
    const dev = await createApp('owner').request('/api/admin/attribution/platforms/tiktok', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ destinationId: 'C123456789ABCDEF', mode: 'test' }),
    }, { APP_ENV: 'dev' } as Bindings)
    expect(dev.status).toBe(409)
    expect((await dev.json()).code).toBe('AD_PLATFORM_PRODUCTION_ONLY')

    const invalid = await createApp('owner').request('/api/admin/attribution/platforms/tiktok', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ destinationId: '<script>', mode: 'test' }),
    }, { APP_ENV: 'production' } as Bindings)
    expect(invalid.status).toBe(400)
    expect((await invalid.json()).code).toBe('AD_PLATFORM_DESTINATION_INVALID')

    const server = await createApp('owner').request('/api/admin/attribution/platforms/tiktok', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ destinationId: 'C123456789ABCDEF', mode: 'test', serverEnabled: true }),
    }, { APP_ENV: 'production' } as Bindings)
    expect(server.status).toBe(409)
    expect((await server.json()).code).toBe('AD_PLATFORM_SERVER_UNSUPPORTED')
  })

  it('incident 列表拒绝未知 status，避免无界或歧义查询', async () => {
    const res = await createApp('admin').request(
      '/api/admin/attribution/meta/incidents?status=broken',
      {},
      { DB: createAttributionDb() } as unknown as Bindings,
    )
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.code).toBe('META_CAPI_INCIDENT_QUERY_INVALID')
  })

  it('incident close 显式要求 Owner', async () => {
    const res = await createApp('admin').request(
      '/api/admin/attribution/meta/incidents/incident_1/close',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ resolution: '已完成连接复验、资源检查并确认投递窗口恢复正常。' }),
      },
      { DB: createAttributionDb() } as unknown as Bindings,
    )
    const body = await res.json()

    expect(res.status).toBe(403)
    expect(body.code).toBe('OWNER_REQUIRED')
  })

  it('incident 列表默认最近 30 个上海业务日，并提供稳定默认分页与排序', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-11T04:00:00.000Z'))
    const db = createAttributionDb()
    const res = await createApp('admin').request(
      '/api/admin/attribution/meta/incidents',
      {},
      { DB: db, APP_ENV: 'dev' } as unknown as Bindings,
    )
    const body = await res.json()
    const query = db.calls.find(call => call.sql.includes('FROM meta_capi_incidents'))

    expect(res.status).toBe(200)
    expect(body.range).toEqual({ from: '2026-06-12', to: '2026-07-11', days: 30 })
    expect(body.data.pagination).toEqual({ limit: 50, offset: 0, hasMore: false })
    expect(query?.params).toEqual(['dev', '2026-06-12', '2026-07-11', 51, 0])
    expect(query?.sql).toContain('ORDER BY opened_at DESC, id DESC')
  })

  it('incident 列表支持 from/to、status、limit/offset，并绑定有界参数', async () => {
    const db = createAttributionDb()
    const res = await createApp('admin').request(
      '/api/admin/attribution/meta/incidents?from=2026-07-01&to=2026-07-10&status=open&limit=20&offset=40',
      {},
      { DB: db, APP_ENV: 'production' } as unknown as Bindings,
    )
    const query = db.calls.find(call => call.sql.includes('FROM meta_capi_incidents'))

    expect(res.status).toBe(200)
    expect(query?.params).toEqual(['production', '2026-07-01', '2026-07-10', 'open', 21, 40])
  })

  it('incident GET 从 trigger 固定定义重建 summary，并逐字段丢弃未知 evidence', async () => {
    const db = createAttributionDb({
      incidentRows: [
        {
          id: 'known', environment: 'dev', status: 'open', severity: 'critical',
          trigger_code: 'meta_permission_denied', trigger_summary: 'payload: 原始异常文本',
          target_rollout_percentage: 50, effective_rollout_percentage: 0,
          evidence: JSON.stringify({
            failedCount: 1,
            errorCategory: 'permission_denied',
            payloadCount: 99,
            rawResponse: 'OAuth secret',
          }),
          opened_at: '2026-07-11T00:00:00.000Z', last_observed_at: '2026-07-11T00:01:00.000Z',
          closed_at: null, closed_by_user_id: null, resolution: '',
        },
        {
          id: 'unknown', environment: 'dev', status: 'open', severity: 'critical',
          trigger_code: 'future_trigger', trigger_summary: '数据库中的用户与 Pixel 原文',
          target_rollout_percentage: 50, effective_rollout_percentage: 0,
          evidence: JSON.stringify({ userCount: 2, payload: 'private' }),
          opened_at: '2026-07-10T00:00:00.000Z', last_observed_at: '2026-07-10T00:01:00.000Z',
          closed_at: null, closed_by_user_id: null, resolution: '',
        },
      ],
    })
    const res = await createApp('admin').request(
      '/api/admin/attribution/meta/incidents',
      {},
      { DB: db, APP_ENV: 'dev' } as unknown as Bindings,
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.items[0]).toMatchObject({
      triggerSummary: 'Meta CAPI 权限被拒绝',
      evidence: { failedCount: 1, errorCategory: 'permission_denied' },
    })
    expect(body.data.items[0].evidence).not.toHaveProperty('payloadCount')
    expect(body.data.items[0].evidence).not.toHaveProperty('rawResponse')
    expect(body.data.items[1]).toMatchObject({
      triggerSummary: '未知 Meta CAPI incident',
      evidence: {},
    })
    expect(JSON.stringify(body)).not.toContain('数据库中的用户与 Pixel 原文')
    expect(JSON.stringify(body)).not.toContain('private')
  })

  it('incident 查询失败时 fail closed 返回稳定 503', async () => {
    const res = await createApp('admin').request(
      '/api/admin/attribution/meta/incidents',
      {},
      { DB: createAttributionDb({ incidentQueryError: true }), APP_ENV: 'dev' } as unknown as Bindings,
    )
    const body = await res.json()

    expect(res.status).toBe(503)
    expect(body.code).toBe('META_CAPI_INCIDENT_QUERY_UNAVAILABLE')
  })

  it.each([
    ['数组', []],
    ['对象', { text: '已完成连接复验、资源检查并确认投递窗口恢复正常。' }],
    ['数字', 123],
    ['null', null],
  ])('incident close 在 service 前拒绝%s resolution', async (_label, resolution) => {
    const res = await createApp('owner').request(
      '/api/admin/attribution/meta/incidents/incident_1/close',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ resolution }),
      },
      { DB: createAttributionDb(), APP_ENV: 'dev' } as unknown as Bindings,
    )
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.code).toBe('META_CAPI_INCIDENT_RESOLUTION_INVALID')
    expect(closeIncidentMock).not.toHaveBeenCalled()
  })

  it('incident close 成功返回 closed，并原样传递 string resolution', async () => {
    closeIncidentMock.mockResolvedValueOnce(undefined)
    const resolution = '已完成连接复验、资源检查并确认投递窗口恢复正常。'
    const res = await createApp('owner').request(
      '/api/admin/attribution/meta/incidents/incident_1/close',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ resolution }),
      },
      { DB: createAttributionDb(), APP_ENV: 'dev' } as unknown as Bindings,
    )

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ data: { id: 'incident_1', status: 'closed' } })
    expect(closeIncidentMock).toHaveBeenCalledWith(expect.anything(), {
      incidentId: 'incident_1', ownerUserId: 1, resolution,
    })
  })

  it('incident close 将 service 409 稳定映射为 blocker 响应', async () => {
    closeIncidentMock.mockRejectedValueOnce(new MetaCapiCircuitError(
      'META_CAPI_INCIDENT_CLOSE_CONFLICT',
      409,
      ['incident_state_changed'],
    ))
    const res = await createApp('owner').request(
      '/api/admin/attribution/meta/incidents/incident_1/close',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ resolution: '已完成连接复验、资源检查并确认投递窗口恢复正常。' }),
      },
      { DB: createAttributionDb(), APP_ENV: 'dev' } as unknown as Bindings,
    )
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body).toMatchObject({
      code: 'META_CAPI_INCIDENT_CLOSE_CONFLICT',
      detail: { blockers: ['incident_state_changed'] },
    })
  })

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
    expect(totalsSql).toContain("transport = 'browser' AND status = 'attempted'")
    expect(totalsSql).not.toContain("transport = 'browser' AND status = 'sent'")
    expect(totalsSql).toContain("transport = 'server' AND status = 'sent'")
    expect(trendSql).toContain("transport = 'server' AND status = 'sent'")
    expect(lastSentSql).toContain("transport = 'server'")
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
    const linksSql = db.calls.find(call => call.sql.includes('conversion_metrics AS'))?.sql ?? ''
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
      call.sql.includes("action_type IN ('contact', 'complete_registration')") ||
      call.sql.includes("action_type = 'lead'") ||
      call.sql.includes("action_type = 'membership_grant'")
    ))).toBe(true)
    expect(currentReportCalls.every(call => !call.sql.includes('AS start_trial_count'))).toBe(true)
    const sampleSql = db.calls.find(call => call.sql.includes('FROM analytics_conversion_actions') && call.sql.includes('LIMIT 100'))?.sql ?? ''
    expect(sampleSql).toContain("action_type IN ('contact', 'complete_registration')")
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
    const linkSql = db.calls.find(call => call.sql.includes('conversion_metrics AS'))
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
    const linkCall = db.calls.find(call => call.sql.includes('conversion_metrics AS'))

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
    expect(body.data.deliveries[0]).toMatchObject({ transport: 'browser', event_name: 'Contact' })
    expect(body.data.settings).not.toHaveProperty('destination_id')
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

  it('Meta 后台返回可管理的连接配置，但不返回 fingerprint 或 secret', async () => {
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
    expect(body.data.settings).not.toHaveProperty('destination_id')
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
    expect(mismatchSql).toContain("COUNT(DISTINCT CASE WHEN d.transport = 'browser' THEN d.external_event_id END) > 0")
    expect(mismatchSql).toContain("COUNT(DISTINCT CASE WHEN d.transport = 'server' THEN d.external_event_id END) > 0")
    expect(mismatchSql).toContain("COUNT(DISTINCT CASE WHEN d.transport = 'browser' THEN d.external_event_id END)")
    expect(mismatchSql).toContain("COUNT(DISTINCT CASE WHEN d.transport = 'server' THEN d.external_event_id END)")
    expect(mismatchSql).toContain('COUNT(DISTINCT d.external_event_id)')
    expect(mismatchSql).not.toContain('MAX(')
  })

  it('readiness 的 ISO 时间字段统一经过 SQLite datetime 解析后比较', async () => {
    const { db } = await requestReadiness()
    const sqlByAlias = (alias: string) => db.calls.find(call => call.sql.includes(alias))?.sql ?? ''

    expect(sqlByAlias('AS retry_exhausted_count')).toContain('a.date BETWEEN ? AND ?')
    expect(sqlByAlias('AS external_event_id_mismatch_count')).toContain('a.date BETWEEN ? AND ?')
    expect(sqlByAlias('AS pending_too_long_count')).toContain("datetime(d.created_at) < datetime('now', '-10 minutes')")
    expect(sqlByAlias('AS permanent_failure_count')).toContain('a.date BETWEEN ? AND ?')
  })

  it.each([
    ['conversion_schema', { readiness: { schemaTableCount: 3 } }, {}],
    ['analytics_enabled', { settings: { analytics_enabled: false } }, {}],
    ['conversion_ledger', { readiness: { actionCount: 0 } }, {}],
    ['pixel_mode_consistency', { settings: { browser_enabled: false } }, {}],
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

  it('readiness 使用 CAPI 接收口径描述投递比例', async () => {
    const { body } = await requestReadiness()
    const check = body.data.checks.find((item: { key: string }) => item.key === 'capi_delivery_ratio')

    expect(check.label).toBe('CAPI 接收与 Pixel 尝试比例')
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

  it.each([
    '/api/admin/attribution/meta/live-challenge',
    '/api/admin/attribution/meta/live-challenge/consume',
    '/api/admin/attribution/meta/resource-attestation-ticket',
  ])('非 owner 不能调用受信 Meta 验证流程：%s', async path => {
    const db = createAttributionDb()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const res = await createApp('admin').request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce: `nonce_${'a'.repeat(32)}`, challengeId: `mlc_${'b'.repeat(32)}` }),
    }, { DB: db, ...VALID_READINESS_ENV } as unknown as Bindings)
    expect(res.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('Owner 只能换取绑定环境/commit/nonce 的短期 ticket，不直接返回 resource attestation', async () => {
    const db = createAttributionDb()
    const nonce = `nonce_${'a'.repeat(32)}`
    const res = await createApp('owner').request('/api/admin/attribution/meta/resource-attestation-ticket', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce }),
    }, { DB: db, ...VALID_READINESS_ENV } as unknown as Bindings)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(body.data).toMatchObject({
      schemaVersion: 1, environment: 'dev', commitSha: VALID_RELEASE_COMMIT, nonce,
      ticket: expect.stringMatching(/^mrat_[0-9a-f]{64}$/),
    })
    expect(Date.parse(body.data.expiresAt) - Date.parse(body.data.issuedAt)).toBe(60_000)
    expect(body.data).not.toHaveProperty('identities')
    expect(JSON.stringify({ body, calls: db.calls })).not.toContain('secret-token')
    expect(JSON.stringify({ body, calls: db.calls })).not.toContain('test-code')
  })

  it('production bootstrap 缺发布资源证据时 409，且在 Graph fetch 与 verification upsert 前阻断', async () => {
    const db = createAttributionDb({ settings: { mode: 'test' } })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const res = await createApp('owner').request('/api/admin/attribution/meta/test-event', { method: 'POST' }, {
      DB: db,
      ...VALID_READINESS_ENV,
      APP_ENV: 'production',
    } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body.code).toBe('META_PRODUCTION_TEST_GATE_BLOCKED')
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
    ['Pixel ID', { settings: { destination_id: '' } }, {}],
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
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ events_received: 1, fbtrace_id: 'trace-safe' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
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
    const graphPayload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    const rawDeliveryId = String(graphPayload.data[0].event_id)
    const auditCall = db.calls.find(call => call.sql.includes('INSERT INTO admin_audit_logs'))
    expect(JSON.stringify(auditCall)).not.toContain(rawDeliveryId)
  })

  it('production 0 -> 10 只读取当前 production connection/Test Event，不查询 dev live row', async () => {
    const { db, res, body } = await requestRollout('owner', { target: 0 }, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ percentage: 10, force: false }),
    }, {
      APP_ENV: 'production',
    })

    expect(res.status).toBe(200)
    expect(body.data.targetPercentage).toBe(10)
    const verificationQueries = db.calls.filter(call => (
      call.sql.includes('analytics_release_verifications') || call.sql.includes('meta_connection_verifications')
    ))
    expect(verificationQueries.some(call => call.sql.includes("environment = 'dev'"))).toBe(false)
    expect(verificationQueries.some(call => call.params.includes('production'))).toBe(true)
  })

  it('production 0 -> 10 缺当前 full isolation attestation 时在 rollout UPDATE 前阻断', async () => {
    const { db, res, body } = await requestRollout('owner', { target: 0, resourceIsolation: false }, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ percentage: 10, force: false }),
    }, { APP_ENV: 'production' })

    expect(res.status).toBe(409)
    expect(body.detail.blockers).toContain('meta_live_verification_missing')
    expect(db.calls.some(call => call.sql.includes('UPDATE ad_platform_connections'))).toBe(false)
  })

  it.each(['bootstrap', 'post-deploy'] as const)('production 0 -> 10 拒绝 %s 资源摘要冒充 full', async verificationPhase => {
    const { db, res, body } = await requestRollout('owner', {
      target: 0,
      resourceSummary: {
        ...fullResourceSummary(),
        verificationPhase,
        bootstrapReady: verificationPhase === 'bootstrap',
        connectionVerified: verificationPhase !== 'bootstrap',
      },
    }, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ percentage: 10, force: false }),
    }, { APP_ENV: 'production' })

    expect(res.status).toBe(409)
    expect(body.detail.blockers).toContain('meta_live_verification_missing')
    expect(db.batchCount).toBe(0)
  })

  it('production 0 -> 10 的原子 UPDATE 同时约束旧 rollout 与当前 JSON production mode', async () => {
    const { db, res, body } = await requestRollout('owner', { target: 0, trackingModeConflict: true }, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ percentage: 10, force: false }),
    }, { APP_ENV: 'production' })

    expect(res.status).toBe(409)
    expect(body.code).toBe('META_CAPI_ROLLOUT_CONFLICT')
    const update = db.calls.find(call => call.sql.includes('UPDATE ad_platform_connections'))
    expect(update?.sql).toContain("mode = ?")
    expect(update?.params).toContain('production')
    expect(db.target).toBe(0)
    expect(db.audits).toEqual([])
  })

  it.each(['disabled', 'test'] as const)('production 0 -> 10 在 trackingMode=%s 时先于 fetch/queue/rollout UPDATE 阻断', async trackingMode => {
    const fetchMock = vi.fn()
    const queueSend = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { db, res, body } = await requestRollout('owner', { target: 0, trackingMode }, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ percentage: 10, force: false }),
    }, {
      APP_ENV: 'production',
      META_CAPI_QUEUE: { send: queueSend },
    })

    expect(res.status).toBe(409)
    expect(body.detail.blockers).toContain('tracking_mode_not_production')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(queueSend).not.toHaveBeenCalled()
    expect(db.calls.some(call => call.sql.includes('UPDATE ad_platform_connections'))).toBe(false)
    expect(db.batchCount).toBe(0)
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

  it.each([
    ['meta_permission_denied', 'Meta CAPI 权限被拒绝'],
    ['future_trigger', '未知 Meta CAPI incident'],
  ])('rollout 只按 trigger code 输出固定 summary：%s', async (triggerCode, expectedSummary) => {
    const pollutedSummary = '数据库中的用户、Pixel 与 token 原文'
    const { res, body } = await requestRollout('admin', {
      target: 10,
      incidentSeverity: 'critical',
      incidentTriggerCode: triggerCode,
      incidentTriggerSummary: pollutedSummary,
    })

    expect(res.status).toBe(200)
    expect(body.data.openIncident.triggerSummary).toBe(expectedSummary)
    expect(JSON.stringify(body)).not.toContain(pollutedSummary)
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

  it('rollout GET 明确返回指标不可用状态并禁止升级', async () => {
    const { res, body } = await requestRollout('admin', {
      target: 10,
      metricsQueryError: true,
    })

    expect(res.status).toBe(200)
    expect(body.data).toMatchObject({
      metricsStatus: {
        available: false,
        errorCode: 'META_CAPI_ROLLOUT_METRICS_QUERY_FAILED',
      },
      promotion: {
        allowed: false,
        hardBlockers: ['metrics_unavailable'],
      },
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
    [10, 50, 'RELEASE_COMMIT 缺失', {}, { RELEASE_COMMIT: undefined }],
    [10, 50, 'RELEASE_COMMIT 非法', {}, { RELEASE_COMMIT: 'invalid' }],
    [10, 50, 'MetaConnection 未验证', { connectionVerified: false }, {}],
    [50, 100, 'RELEASE_COMMIT 缺失', {}, { RELEASE_COMMIT: undefined }],
    [50, 100, 'RELEASE_COMMIT 非法', {}, { RELEASE_COMMIT: 'invalid' }],
    [50, 100, 'MetaConnection 未验证', { connectionVerified: false }, {}],
  ] as const)('普通 %i -> %i 在%s时仍要求当前 verified connection', async (
    target,
    percentage,
    _caseName,
    dbOptions,
    envOverrides,
  ) => {
    const { db, res, body } = await requestRollout('owner', { target, ...dbOptions }, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ percentage, force: false }),
    }, envOverrides)

    expect(res.status).toBe(409)
    expect(body.code).toBe('META_CAPI_ROLLOUT_PROMOTION_BLOCKED')
    expect(body.detail.blockers).toContain('connection_unverified')
    expect(db.batchCount).toBe(0)
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
        environment: 'production',
      },
    })
    expect(JSON.stringify(forced.db.audits)).not.toContain('rollout-token')
  })

  it('99 sent + 1 meta_http_403 权限错误不能通过 10 -> 50', async () => {
    const { db, res, body } = await requestRollout('owner', {
      target: 10,
      sent: 99,
      deliveryErrorCategories: ['meta_http_403'],
    }, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ percentage: 50, force: false }),
    })

    expect(res.status).toBe(409)
    expect(body.code).toBe('META_CAPI_ROLLOUT_PROMOTION_BLOCKED')
    expect(body.detail.blockers).toContain('permission_errors_present')
    expect(db.batchCount).toBe(0)
    expect(db.audits).toEqual([])
  })

  it('meta_http_403 关键诊断不能通过 50 -> 100', async () => {
    const { db, res, body } = await requestRollout('owner', {
      target: 50,
      sent: 99,
      deliveryErrorCategories: ['meta_http_403'],
    }, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ percentage: 100, force: false }),
    })

    expect(res.status).toBe(409)
    expect(body.code).toBe('META_CAPI_ROLLOUT_PROMOTION_BLOCKED')
    expect(body.detail.blockers).toContain('critical_quality_diagnostics_present')
    expect(db.batchCount).toBe(0)
    expect(db.audits).toEqual([])
  })

  it.each([
    ['普通升级', false, ''],
    ['force 升级', true, '当前指标已有人工复核确认风险受控并持续观察运行状态'],
  ] as const)('指标查询失败时拒绝%s且返回稳定非敏感错误状态', async (_caseName, force, reason) => {
    const { db, res, body } = await requestRollout('owner', {
      target: 10,
      metricsQueryError: true,
    }, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ percentage: 50, force, reason }),
    })

    expect(res.status).toBe(409)
    expect(body.code).toBe('META_CAPI_ROLLOUT_PROMOTION_BLOCKED')
    expect(body.detail).toMatchObject({
      blockers: expect.arrayContaining(['metrics_unavailable']),
      metricsStatus: {
        available: false,
        errorCode: 'META_CAPI_ROLLOUT_METRICS_QUERY_FAILED',
      },
    })
    expect(JSON.stringify(body)).not.toContain('模拟 rollout metrics 查询失败')
    expect(db.batchCount).toBe(0)
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

function fullResourceSummary(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    verificationPhase: 'full',
    bootstrapReady: false,
    liveAttestation: true,
    migrationsReady: true,
    d1Ready: true,
    r2Ready: true,
    queuesReady: true,
    secretsReady: true,
    migrationsCurrent: true,
    migrationsApplied: true,
    connectionVerified: true,
    capiEnabled: false,
    initialMetaRollout: false,
    noOpenCriticalIncident: true,
    initialRolloutZero: true,
    secureOutboxReady: true,
    previousKeyReferencesExplainable: true,
    rolloutZero: true,
    environmentIsolation: {
      d1: true, r2: true, queue: true, dlq: true,
      pixel: true, token: true, testEventCode: true, dataKey: true,
    },
  }
}

describe('Meta CAPI v2 质量运维看板契约', () => {
  const singleDay = 'from=2026-07-10&to=2026-07-10'

  it('summary 单日只汇总活动业务 action，并将 Lead 放入 historical', async () => {
    const db = createDashboardDb()
    const res = await createApp('admin').request(
      `/api/admin/attribution/summary?${singleDay}`,
      {},
      { DB: db } as unknown as Bindings,
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({
      range: { from: '2026-07-10', to: '2026-07-10', days: 1 },
      usage: { rowsRead: expect.any(Number), rowsWritten: 0, durationMs: expect.any(Number) },
      data: {
        business: {
          contactCount: 3,
          completeRegistrationCount: 2,
          actionCount: 5,
        },
        historical: { leadCount: 9 },
        delivery: {
          pixelAttempted: 5,
          capiSent: 4,
          failed: 1,
          skipped: 2,
          pending: 3,
          retryExhausted: 1,
        },
      },
    })
    expect(body.data.business).not.toHaveProperty('leadCount')
    expect(JSON.stringify(body.data)).not.toContain('Meta 归因成功')
  })

  it('trends 对指定单日恰好返回一行并保持业务与投递证据分层', async () => {
    const res = await createApp('admin').request(
      `/api/admin/attribution/trends?${singleDay}&granularity=day`,
      {},
      { DB: createDashboardDb() } as unknown as Bindings,
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.range).toEqual({ from: '2026-07-10', to: '2026-07-10', days: 1 })
    expect(body.data.granularity).toBe('day')
    expect(body.data.rows).toEqual([{
      date: '2026-07-10',
      business: { contactCount: 3, completeRegistrationCount: 2, actionCount: 5 },
      delivery: {
        pixelAttempted: 5,
        capiSent: 4,
        failed: 1,
        skipped: 2,
        pending: 3,
        retryExhausted: 1,
      },
    }])
  })

  it('trends 对无数据范围按上海业务日期逐日补零', async () => {
    const res = await createApp('admin').request(
      '/api/admin/attribution/trends?from=2026-07-09&to=2026-07-11&granularity=day',
      {},
      { DB: createDashboardDb({ empty: true }) } as unknown as Bindings,
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.rows.map((row: { date: string }) => row.date)).toEqual([
      '2026-07-09',
      '2026-07-10',
      '2026-07-11',
    ])
    expect(body.data.rows.every((row: { business: { actionCount: number }; delivery: { capiSent: number } }) => (
      row.business.actionCount === 0 && row.delivery.capiSent === 0
    ))).toBe(true)
  })

  it('quality 返回四项 match 分子、分母与 rate，且无 Dataset snapshot 不伪造 0 分', async () => {
    const res = await createApp('admin').request(
      `/api/admin/attribution/quality?${singleDay}`,
      {},
      { DB: createDashboardDb() } as unknown as Bindings,
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.match.summary).toEqual({
      fbp: { availability: 'available', numerator: 3, denominator: 4, rate: 0.75 },
      fbc: { availability: 'available', numerator: 2, denominator: 4, rate: 0.5 },
      email: { availability: 'available', numerator: 4, denominator: 4, rate: 1 },
      externalId: { availability: 'available', numerator: 1, denominator: 4, rate: 0.25 },
    })
    expect(body.data.match.rows).toHaveLength(1)
    expect(body.data.datasetQuality).toEqual({
      availability: 'unavailable',
      latest: null,
      rows: [],
    })
  })

  it('quality 的 match denominator 为零时 rate 为 null 且明确 unavailable', async () => {
    const res = await createApp('admin').request(
      `/api/admin/attribution/quality?${singleDay}`,
      {},
      { DB: createDashboardDb({ matchDenominator: 0 }) } as unknown as Bindings,
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.match.summary.fbp).toEqual({
      availability: 'unavailable',
      numerator: 0,
      denominator: 0,
      rate: null,
    })
    expect(body.data.match.rows[0].fbp.rate).toBeNull()
  })

  it.each([
    ['error', null, 'error'],
    ['success', null, 'unavailable'],
  ] as const)('Dataset snapshot 为 %s/null 时不标记 available', async (collectionStatus, metricValue, availability) => {
    const res = await createApp('admin').request(
      `/api/admin/attribution/quality?${singleDay}`,
      {},
      {
        DB: createDashboardDb({
          datasetQualityRows: [{
            date: '2026-07-10',
            event_name: 'Contact',
            metric_key: 'event_match_quality',
            metric_value: metricValue,
            collection_status: collectionStatus,
            error_category: collectionStatus === 'error' ? 'permission_denied' : '',
            collected_at: '2026-07-10T08:00:00.000Z',
            window_start: null,
            window_end: null,
            contract_version: 1,
          }],
        }),
      } as unknown as Bindings,
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.datasetQuality.availability).toBe(availability)
    expect(body.data.datasetQuality.latest).toMatchObject({
      availability,
      value: null,
      status: collectionStatus,
    })
  })

  it('meta/status 合并 connection、rollout、activity 的每项 D1 usage 且只读取一次 connection', async () => {
    const db = createMetaStatusUsageDb()
    const res = await createApp('admin').request(
      `/api/admin/attribution/meta/status?${singleDay}`,
      {},
      { DB: db, ...VALID_READINESS_ENV, APP_ENV: 'production' } as unknown as Bindings,
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.usage).toEqual({ rowsRead: 171, rowsWritten: 0, durationMs: 31 })
    expect(db.calls.filter(call => call.sql.includes('FROM ad_platform_connections'))).toHaveLength(2)
    expect(db.calls.filter(call => call.sql.includes('FROM meta_connection_verifications'))).toHaveLength(1)
    expect(db.calls).toHaveLength(11)
  })

  it('breakdown 以 conversion fact 为 action 基数，双通道不会翻倍', async () => {
    const db = createDashboardDb()
    const res = await createApp('admin').request(
      `/api/admin/attribution/breakdown?${singleDay}&dimension=utm_campaign`,
      {},
      { DB: db } as unknown as Bindings,
    )
    const body = await res.json()
    const query = db.calls.find(call => call.sql.includes('WITH action_facts'))

    expect(res.status).toBe(200)
    expect(body.data.dimension).toBe('utm_campaign')
    expect(body.data.rows[0]).toMatchObject({
      value: 'summer-campaign',
      actionCount: 5,
      contactCount: 3,
      completeRegistrationCount: 2,
      delivery: { pixelAttempted: 5, capiSent: 4, failed: 1 },
    })
    expect(query?.sql).toContain('delivery_per_action')
    expect(query?.sql).toContain('COUNT(*) AS action_count')
    expect(query?.params).toEqual(['2026-07-10', '2026-07-10', 50])
  })

  it.each(['utm_campaign', 'utm_content', 'tracking_link'] as const)(
    'breakdown 接受白名单 dimension %s',
    async (dimension) => {
      const res = await createApp('admin').request(
        `/api/admin/attribution/breakdown?${singleDay}&dimension=${dimension}`,
        {},
        { DB: createDashboardDb() } as unknown as Bindings,
      )
      expect(res.status).toBe(200)
    },
  )

  it('breakdown 拒绝未知 dimension 且不执行查询', async () => {
    const db = createDashboardDb()
    const res = await createApp('admin').request(
      `/api/admin/attribution/breakdown?${singleDay}&dimension=source_name`,
      {},
      { DB: db } as unknown as Bindings,
    )
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.code).toBe('ATTRIBUTION_BREAKDOWN_DIMENSION_INVALID')
    expect(db.calls).toHaveLength(0)
  })

  it.each(['summary', 'trends', 'quality', 'breakdown', 'meta/status', 'readiness'])(
    '%s 使用统一日期范围契约',
    async (endpoint) => {
      const suffix = endpoint === 'breakdown' ? '&dimension=utm_content' : ''
      const db = endpoint === 'meta/status' || endpoint === 'readiness'
        ? createAttributionDb()
        : createDashboardDb()
      const res = await createApp('admin').request(
        `/api/admin/attribution/${endpoint}?${singleDay}${suffix}`,
        {},
        { DB: db, ...VALID_READINESS_ENV } as unknown as Bindings,
      )
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.range).toEqual({ from: '2026-07-10', to: '2026-07-10', days: 1 })
      expect(body.usage).toMatchObject({
        rowsRead: expect.any(Number),
        rowsWritten: expect.any(Number),
        durationMs: expect.any(Number),
      })
      expect(body.data).toBeTypeOf('object')
    },
  )

  it('新看板运行时 SQL 的 active 查询不会把 Lead 混入统计', async () => {
    const db = createDashboardDb()
    const app = createApp('admin')
    const env = { DB: db } as unknown as Bindings
    await Promise.all([
      app.request(`/api/admin/attribution/summary?${singleDay}`, {}, env),
      app.request(`/api/admin/attribution/trends?${singleDay}&granularity=day`, {}, env),
      app.request(`/api/admin/attribution/quality?${singleDay}`, {}, env),
      app.request(`/api/admin/attribution/breakdown?${singleDay}&dimension=tracking_link`, {}, env),
    ])

    const activeSql = db.calls
      .map(call => call.sql)
      .filter(sql => !sql.includes("action_type = 'lead'"))
      .join('\n')
    expect(activeSql).not.toMatch(/action_type\s+IN\s*\([^)]*["']lead["']/i)
    expect(activeSql).not.toMatch(/event_name\s+IN\s*\([^)]*["']Lead["']/i)
    expect(db.calls.some(call => call.sql.includes("action_type = 'lead'"))).toBe(true)
  })

  it.each(['summary', 'trends', 'quality', 'breakdown', 'meta/status', 'readiness'])(
    '%s 查询失败时 fail closed 为稳定 503',
    async (endpoint) => {
      const suffix = endpoint === 'breakdown' ? '&dimension=utm_campaign' : ''
      const res = await createApp('admin').request(
        `/api/admin/attribution/${endpoint}?${singleDay}${suffix}`,
        {},
        { DB: createDashboardDb({ fail: true }), ...VALID_READINESS_ENV } as unknown as Bindings,
      )
      const body = await res.json()

      expect(res.status).toBe(503)
      expect(body.code).toBe('ATTRIBUTION_DASHBOARD_UNAVAILABLE')
      expect(JSON.stringify(body)).not.toContain('模拟 dashboard 查询失败')
    },
  )
})
