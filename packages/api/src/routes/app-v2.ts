import type { AppBootstrapConfig } from '@meigallery/shared'
import { Hono } from 'hono'
import type { Bindings, Variables } from '../index'
import {
  APP_DISCOVERY_DEFAULT_PAGE_SIZE,
  APP_DISCOVERY_MAX_PAGE_SIZE,
  APP_DISCOVERY_SORTS,
  AppDiscoveryQueryError,
  getPublicPersonProfile,
  listPublicDiscoveryRegions,
  listPublicPersonProfiles,
  parseAppDiscoveryQuery,
} from '../services/app-discovery'
import { appApiError, appApiListSuccess, appApiSuccess } from '../utils/app-api-v2'
import { appAuthRoutes, appAccountError } from './app-auth'
import {
  authenticateAppAccessToken,
  getAppAccount,
  getAppAuthRuntimeConfig,
  listAppDevices,
  readBearerToken,
  requireAppAuthEnabled,
  revokeAppDevice,
  type AppSessionPrincipal,
} from '../services/app-account-access'
import {
  AppViewerInteractionError,
  getViewerInteractionState,
  listViewerInteractions,
  parseAppViewerInteractionQuery,
  setViewerInteraction,
} from '../services/app-viewer-interactions'
import {
  APP_FOLLOW_UPDATE_MAX_PAGE_SIZE,
  APP_FOLLOW_UPDATE_POLICY_ID,
  AppFollowUpdateError,
  getAppFollowUpdateRuntimeConfig,
  listAppFollowUpdates,
  parseAppFollowUpdateListQuery,
  resolveAppFollowUpdateCapability,
} from '../services/app-follow-updates'
import {
  createAppFavoriteFolder,
  deleteAppFavoriteFolder,
  getAppFavoriteState,
  listAppFavoriteFolders,
  listAppFavorites,
  parseAppFavoriteListQuery,
  setAppFavoriteFolderItem,
  setAppGlobalFavorite,
  updateAppFavoriteFolder,
  type CreateAppFavoriteFolderInput,
  type UpdateAppFavoriteFolderInput,
} from '../services/app-favorites'
import {
  APP_FAVORITE_DEFAULT_FOLDER_LABEL,
  APP_FAVORITE_MAX_FOLDER_NAME_LENGTH,
  APP_FAVORITE_MAX_ITEMS_PER_FOLDER,
  APP_INTERACTION_COLLECTION_POLICY_ID,
  AppInteractionCollectionError,
  getAppInteractionCollectionRuntimeConfig,
  resolveAppInteractionCollectionCapabilities,
} from '../services/app-interaction-collections'
import {
  clearAppViewHistory,
  deleteAppViewHistoryItem,
  getAppViewHistorySettings,
  listAppViewHistory,
  parseAppViewHistoryListQuery,
  recordAppProfileView,
  updateAppViewHistorySettings,
  type ClearAppViewHistoryInput,
  type RecordAppProfileViewInput,
  type UpdateAppViewHistorySettingsInput,
} from '../services/app-view-history'
import {
  AppMembershipError,
  getAppMembershipCatalog,
  getAppMembershipRuntimeConfig,
  requireAppMembershipEnabled,
  resolveAppMembershipSnapshot,
} from '../services/app-membership'
import {
  APP_MEMBERSHIP_APPLICATION_CONTACT_WINDOWS,
  APP_MEMBERSHIP_APPLICATION_DISCLOSURE_TEXT,
  APP_MEMBERSHIP_APPLICATION_DISCLOSURE_VERSION,
  APP_MEMBERSHIP_APPLICATION_MAX_STATEMENT_LENGTH,
  cancelAppMembershipApplication,
  getAppMembershipApplication,
  listAppMembershipApplications,
  requireAppMembershipApplicationsEnabled,
  resubmitAppMembershipApplication,
  submitAppMembershipApplication,
  type ResubmitAppMembershipApplicationInput,
  type SubmitAppMembershipApplicationInput,
} from '../services/app-membership-applications'
import {
  AppMessagingError,
  APP_MESSAGING_DISCLOSURE_TEXT,
  APP_MESSAGING_MAX_TEXT_LENGTH,
  APP_MESSAGING_RECEIVER_LABEL,
  createAppConversation,
  getAppConversation,
  getAppMessagingRuntimeConfig,
  listAppConversationMessages,
  listAppConversations,
  markAppConversationRead,
  parseAppConversationListQuery,
  parseAppMessageListQuery,
  requireAppMessagingEnabled,
  sendAppViewerMessage,
  type CreateAppConversationInput,
  type SendAppMessageInput,
} from '../services/app-messaging'
import {
  APP_SAFETY_MAX_DESCRIPTION_LENGTH,
  APP_SAFETY_MAX_APPEAL_STATEMENT_LENGTH,
  APP_SAFETY_REASONS,
  APP_SAFETY_REPORT_TARGETS,
  AppSafetyError,
  closeAppConversationForViewer,
  createAppSafetyReport,
  getAppProfileBlockState,
  getAppSafetyReport,
  getAppSafetyRuntimeConfig,
  listAppProfileBlocks,
  listAppSafetyReports,
  parseAppBlockListQuery,
  parseAppReportListQuery,
  requireAppSafetyEnabled,
  requireAppSafetyAppealsEnabled,
  setAppProfileBlock,
  type CreateAppSafetyReportInput,
} from '../services/app-safety'
import {
  createAppSafetyAppeal,
  getAppSafetyAppeal,
  listAppSafetyAppeals,
  parseAppAppealListQuery,
  type CreateAppSafetyAppealInput,
} from '../services/app-safety-appeals'
import {
  APP_NOTIFICATION_CATEGORIES,
  APP_NOTIFICATION_MAX_PAGE_SIZE,
  AppNotificationError,
  getAppNotification,
  getAppNotificationPreferences,
  getAppNotificationRuntimeConfig,
  getAppNotificationUnreadCounts,
  listAppNotifications,
  markAppNotificationRead,
  markAppNotificationsReadAll,
  parseAppNotificationListQuery,
  requireAppNotificationsEnabled,
  updateAppNotificationPreferences,
  type UpdateAppNotificationPreferencesInput,
} from '../services/app-notifications'
import {
  APP_WALLET_DISCLAIMER,
  APP_WALLET_MAX_PAGE_SIZE,
  AppWalletError,
  getAppWalletEntry,
  getAppWalletRuntimeConfig,
  getAppWalletSummary,
  listAppWalletEntries,
  parseAppWalletEntryListQuery,
  requireAppWalletEnabled,
} from '../services/app-wallet'

export const appV2Routes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

appV2Routes.use('*', async (c, next) => {
  await next()
  c.header('Cache-Control', 'no-store')
})

appV2Routes.get('/app/bootstrap', async (c) => {
  return appApiSuccess(c, await bootstrapConfig(c.env))
})

appV2Routes.route('/auth', appAuthRoutes)

// 发现页保持匿名可用；登录客户端携带 Bearer token 时启用服务端个性化安全过滤。
appV2Routes.use('/discovery/feed', async (c, next) => {
  if (!c.req.header('Authorization')) {
    await next()
    return
  }

  try {
    const config = getAppAuthRuntimeConfig(c.env)
    requireAppAuthEnabled(config)
    const principal = await authenticateAppAccessToken(
      c.env.DB,
      readBearerToken(c.req.header('Authorization')),
      new Date(),
      config.documentVersions,
    )
    c.set('appAccountId', principal.accountInternalId)
    c.set('appAccountPublicId', principal.accountId)
    c.set('appSessionId', principal.sessionId)
    c.set('appDeviceId', principal.deviceId)
    c.set('appAccountEmail', principal.email)
    c.set('appAccountNickname', principal.nickname)
    c.set('appAccountRole', principal.role)
    await next()
  }
  catch (error) {
    return appAccountError(c, error)
  }
})

for (const path of [
  '/me',
  '/me/*',
  '/person-profiles/:profileId/interactions',
  '/person-profiles/:profileId/like',
  '/person-profiles/:profileId/follow',
  '/person-profiles/:profileId/favorite',
  '/person-profiles/:profileId/view-history',
  '/person-profiles/:profileId/safety',
  '/person-profiles/:profileId/block',
  '/reports',
  '/reports/*',
  '/appeals',
  '/appeals/*',
  '/conversations',
  '/conversations/*',
  '/membership-applications',
  '/membership-applications/*',
  '/notifications',
  '/notifications/*',
]) {
  appV2Routes.use(path, async (c, next) => {
    try {
      const config = getAppAuthRuntimeConfig(c.env)
      requireAppAuthEnabled(config)
      const token = readBearerToken(c.req.header('Authorization'))
      const principal = await authenticateAppAccessToken(
        c.env.DB,
        token,
        new Date(),
        config.documentVersions,
      )
      c.set('appAccountId', principal.accountInternalId)
      c.set('appAccountPublicId', principal.accountId)
      c.set('appSessionId', principal.sessionId)
      c.set('appDeviceId', principal.deviceId)
      c.set('appAccountEmail', principal.email)
      c.set('appAccountNickname', principal.nickname)
      c.set('appAccountRole', principal.role)
      await next()
    }
    catch (error) {
      return appAccountError(c, error)
    }
  })
}

appV2Routes.get('/notifications', async (c) => {
  try {
    const principal = appPrincipal(c)
    const config = notificationConfig(c.env)
    const query = parseAppNotificationListQuery({
      category: c.req.query('category'),
      limit: c.req.query('limit'),
      cursor: c.req.query('cursor'),
      accountScope: principal.accountId,
    })
    const result = await listAppNotifications(
      c.env.DB,
      principal.accountInternalId,
      principal.accountId,
      config,
      notificationTargetCapabilities(c.env),
      query,
    )
    return appApiListSuccess(c, result.data, {
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
    })
  }
  catch (error) {
    return appNotificationError(c, error)
  }
})

appV2Routes.get('/notifications/unread-counts', async (c) => {
  try {
    const principal = appPrincipal(c)
    return appApiSuccess(c, await getAppNotificationUnreadCounts(
      c.env.DB,
      principal.accountInternalId,
      notificationConfig(c.env),
    ))
  }
  catch (error) {
    return appNotificationError(c, error)
  }
})

appV2Routes.post('/notifications/read-all', async (c) => {
  try {
    const principal = appPrincipal(c)
    const body = await c.req.json<{ category?: unknown }>()
    return appApiSuccess(c, await markAppNotificationsReadAll(
      c.env.DB,
      principal.accountInternalId,
      body.category,
      notificationConfig(c.env),
      { deviceId: principal.deviceId, requestId: c.get('appRequestId')! },
    ))
  }
  catch (error) {
    return appNotificationError(c, error)
  }
})

appV2Routes.get('/notifications/:notificationId', async (c) => {
  try {
    const principal = appPrincipal(c)
    return appApiSuccess(c, await getAppNotification(
      c.env.DB,
      principal.accountInternalId,
      c.req.param('notificationId'),
      notificationConfig(c.env),
      notificationTargetCapabilities(c.env),
    ))
  }
  catch (error) {
    return appNotificationError(c, error)
  }
})

appV2Routes.post('/notifications/:notificationId/read', async (c) => {
  try {
    const principal = appPrincipal(c)
    return appApiSuccess(c, await markAppNotificationRead(
      c.env.DB,
      principal.accountInternalId,
      c.req.param('notificationId'),
      notificationConfig(c.env),
      { deviceId: principal.deviceId, requestId: c.get('appRequestId')! },
    ))
  }
  catch (error) {
    return appNotificationError(c, error)
  }
})

appV2Routes.get('/me/notification-preferences', async (c) => {
  try {
    const principal = appPrincipal(c)
    return appApiSuccess(c, await getAppNotificationPreferences(
      c.env.DB,
      principal.accountInternalId,
      notificationConfig(c.env),
    ))
  }
  catch (error) {
    return appNotificationError(c, error)
  }
})

appV2Routes.put('/me/notification-preferences', async (c) => {
  try {
    const principal = appPrincipal(c)
    const body = await c.req.json<UpdateAppNotificationPreferencesInput>()
    return appApiSuccess(c, await updateAppNotificationPreferences(
      c.env.DB,
      principal.accountInternalId,
      body,
      notificationConfig(c.env),
      { deviceId: principal.deviceId, requestId: c.get('appRequestId')! },
    ))
  }
  catch (error) {
    return appNotificationError(c, error)
  }
})

appV2Routes.get('/me/wallet', async (c) => {
  try {
    const principal = appPrincipal(c)
    return appApiSuccess(c, await getAppWalletSummary(
      c.env.DB,
      principal.accountInternalId,
      walletConfig(c.env),
    ))
  }
  catch (error) {
    return appWalletError(c, error)
  }
})

appV2Routes.get('/me/wallet/entries', async (c) => {
  try {
    const principal = appPrincipal(c)
    const query = parseAppWalletEntryListQuery({
      direction: c.req.query('direction'),
      limit: c.req.query('limit'),
      cursor: c.req.query('cursor'),
      accountScope: principal.accountId,
    })
    const result = await listAppWalletEntries(
      c.env.DB,
      principal.accountInternalId,
      principal.accountId,
      walletConfig(c.env),
      query,
    )
    return appApiListSuccess(c, result.data, {
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
    })
  }
  catch (error) {
    return appWalletError(c, error)
  }
})

appV2Routes.get('/me/wallet/entries/:entryId', async (c) => {
  try {
    const principal = appPrincipal(c)
    return appApiSuccess(c, await getAppWalletEntry(
      c.env.DB,
      principal.accountInternalId,
      c.req.param('entryId'),
      walletConfig(c.env),
    ))
  }
  catch (error) {
    return appWalletError(c, error)
  }
})

appV2Routes.get('/me', async (c) => {
  try {
    const membership = getAppMembershipRuntimeConfig(c.env)
    return appApiSuccess(c, await getAppAccount(
      c.env.DB,
      appPrincipal(c),
      membership.enabled && membership.catalogVersionId
        ? {
            catalogVersionId: membership.catalogVersionId,
            requireProductionReady: membership.requireProductionReady,
          }
        : null,
    ))
  }
  catch (error) {
    return appMembershipError(c, error)
  }
})

appV2Routes.get('/membership/catalog', async (c) => {
  try {
    const config = getAppMembershipRuntimeConfig(c.env)
    requireAppMembershipEnabled(config)
    return appApiSuccess(c, await getAppMembershipCatalog(
      c.env.DB,
      config.catalogVersionId,
      {
        requireProductionReady: config.requireProductionReady,
        applicationEnabled: config.applicationsEnabled && getAppAuthRuntimeConfig(c.env).enabled,
      },
    ))
  }
  catch (error) {
    return appMembershipError(c, error)
  }
})

appV2Routes.get('/me/membership-applications', async (c) => {
  try {
    const config = getAppMembershipRuntimeConfig(c.env)
    requireAppMembershipApplicationsEnabled(config)
    return appApiListSuccess(
      c,
      await listAppMembershipApplications(c.env.DB, appPrincipal(c).accountInternalId),
      { nextCursor: null, hasMore: false },
    )
  }
  catch (error) {
    return appMembershipError(c, error)
  }
})

appV2Routes.get('/membership-applications/:applicationId', async (c) => {
  try {
    const config = getAppMembershipRuntimeConfig(c.env)
    requireAppMembershipApplicationsEnabled(config)
    return appApiSuccess(c, await getAppMembershipApplication(
      c.env.DB,
      appPrincipal(c).accountInternalId,
      c.req.param('applicationId'),
    ))
  }
  catch (error) {
    return appMembershipError(c, error)
  }
})

appV2Routes.post('/membership-applications', async (c) => {
  try {
    const config = getAppMembershipRuntimeConfig(c.env)
    requireAppMembershipApplicationsEnabled(config)
    const result = await submitAppMembershipApplication(
      c.env.DB,
      appPrincipal(c).accountInternalId,
      config.catalogVersionId,
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<SubmitAppMembershipApplicationInput>(),
      new Date(),
      config.requireProductionReady,
    )
    return appApiSuccess(c, result, result.created ? 201 : 200)
  }
  catch (error) {
    return appMembershipError(c, error)
  }
})

appV2Routes.post('/membership-applications/:applicationId/resubmit', async (c) => {
  try {
    const config = getAppMembershipRuntimeConfig(c.env)
    requireAppMembershipApplicationsEnabled(config)
    return appApiSuccess(c, await resubmitAppMembershipApplication(
      c.env.DB,
      appPrincipal(c).accountInternalId,
      c.req.param('applicationId'),
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<ResubmitAppMembershipApplicationInput>(),
    ))
  }
  catch (error) {
    return appMembershipError(c, error)
  }
})

appV2Routes.post('/membership-applications/:applicationId/cancel', async (c) => {
  try {
    const config = getAppMembershipRuntimeConfig(c.env)
    requireAppMembershipApplicationsEnabled(config)
    const body = await c.req.json<{ expectedVersion?: unknown }>()
    return appApiSuccess(c, await cancelAppMembershipApplication(
      c.env.DB,
      appPrincipal(c).accountInternalId,
      c.req.param('applicationId'),
      c.req.header('Idempotency-Key') ?? null,
      body.expectedVersion,
    ))
  }
  catch (error) {
    return appMembershipError(c, error)
  }
})

appV2Routes.get('/me/entitlements', async (c) => {
  try {
    const config = getAppMembershipRuntimeConfig(c.env)
    requireAppMembershipEnabled(config)
    return appApiSuccess(c, await resolveAppMembershipSnapshot(
      c.env.DB,
      appPrincipal(c).accountInternalId,
      config.catalogVersionId,
      new Date(),
      { requireProductionReady: config.requireProductionReady },
    ))
  }
  catch (error) {
    return appMembershipError(c, error)
  }
})

appV2Routes.get('/me/devices', async (c) => {
  return appApiSuccess(c, await listAppDevices(c.env.DB, appPrincipal(c)))
})

appV2Routes.post('/conversations', async (c) => {
  try {
    const config = messagingConfig(c.env)
    const principal = appPrincipal(c)
    const data = await createAppConversation(
      c.env.DB,
      principal.accountInternalId,
      principal.accountId,
      config.catalogVersionId,
      config.disclosureVersion,
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<CreateAppConversationInput>(),
      c.req.url,
      new Date(),
      config.requireProductionReady,
    )
    return appApiSuccess(c, data, data.created ? 201 : 200)
  }
  catch (error) {
    return appMessagingError(c, error)
  }
})

appV2Routes.get('/conversations', async (c) => {
  try {
    const config = messagingConfig(c.env)
    const principal = appPrincipal(c)
    const query = parseAppConversationListQuery({
      limit: c.req.query('limit'),
      cursor: c.req.query('cursor'),
      accountScope: principal.accountId,
    })
    const result = await listAppConversations(
      c.env.DB,
      principal.accountInternalId,
      principal.accountId,
      config.catalogVersionId,
      c.req.url,
      query,
      new Date(),
      config.requireProductionReady,
    )
    return appApiListSuccess(c, result.data, {
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
    })
  }
  catch (error) {
    return appMessagingError(c, error)
  }
})

appV2Routes.get('/conversations/:conversationId', async (c) => {
  try {
    const config = messagingConfig(c.env)
    const principal = appPrincipal(c)
    return appApiSuccess(c, await getAppConversation(
      c.env.DB,
      principal.accountInternalId,
      principal.accountId,
      c.req.param('conversationId'),
      config.catalogVersionId,
      c.req.url,
      new Date(),
      config.requireProductionReady,
    ))
  }
  catch (error) {
    return appMessagingError(c, error)
  }
})

appV2Routes.get('/conversations/:conversationId/messages', async (c) => {
  try {
    messagingConfig(c.env)
    const query = parseAppMessageListQuery({
      afterSequence: c.req.query('afterSequence'),
      limit: c.req.query('limit'),
    })
    return appApiSuccess(c, await listAppConversationMessages(
      c.env.DB,
      appPrincipal(c).accountInternalId,
      c.req.param('conversationId'),
      query,
    ))
  }
  catch (error) {
    return appMessagingError(c, error)
  }
})

appV2Routes.post('/conversations/:conversationId/messages', async (c) => {
  try {
    const config = messagingConfig(c.env)
    const data = await sendAppViewerMessage(
      c.env.DB,
      appPrincipal(c).accountInternalId,
      c.req.param('conversationId'),
      config.catalogVersionId,
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<SendAppMessageInput>(),
      new Date(),
      config.requireProductionReady,
    )
    return appApiSuccess(c, data, data.replayed ? 200 : 201)
  }
  catch (error) {
    return appMessagingError(c, error)
  }
})

appV2Routes.post('/conversations/:conversationId/read', async (c) => {
  try {
    messagingConfig(c.env)
    const body = await c.req.json<{ sequence?: unknown }>()
    return appApiSuccess(c, await markAppConversationRead(
      c.env.DB,
      appPrincipal(c).accountInternalId,
      c.req.param('conversationId'),
      body.sequence,
    ))
  }
  catch (error) {
    return appMessagingError(c, error)
  }
})

appV2Routes.post('/conversations/:conversationId/close', async (c) => {
  try {
    const messaging = messagingConfig(c.env)
    safetyConfig(c.env)
    const principal = appPrincipal(c)
    const result = await closeAppConversationForViewer(
      c.env.DB,
      principal.accountInternalId,
      c.req.param('conversationId'),
      c.req.header('Idempotency-Key') ?? null,
      new Date(),
    )
    return appApiSuccess(c, {
      conversation: await getAppConversation(
        c.env.DB,
        principal.accountInternalId,
        principal.accountId,
        result.conversationId,
        messaging.catalogVersionId,
        c.req.url,
        new Date(),
        messaging.requireProductionReady,
      ),
      replayed: result.replayed,
    })
  }
  catch (error) {
    return appSafetyError(c, error)
  }
})

appV2Routes.delete('/me/devices/:deviceId', async (c) => {
  try {
    return appApiSuccess(c, await revokeAppDevice(
      c.env.DB,
      appPrincipal(c),
      c.req.param('deviceId'),
      c.get('appRequestId') || crypto.randomUUID(),
    ))
  }
  catch (error) {
    return appAccountError(c, error)
  }
})

appV2Routes.get('/discovery/feed', async (c) => {
  try {
    const query = parseAppDiscoveryQuery({
      sort: c.req.query('sort'),
      region: c.req.query('region'),
      limit: c.req.query('limit'),
      cursor: c.req.query('cursor'),
    })
    const result = await listPublicPersonProfiles(
      c.env.DB,
      query,
      c.req.url,
      new Date(),
      c.get('appAccountId') ?? null,
    )
    return appApiListSuccess(c, result.data, {
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
    })
  } catch (error) {
    if (error instanceof AppDiscoveryQueryError) {
      return appApiError(c, 400, error.code, error.message)
    }
    throw error
  }
})

appV2Routes.get('/discovery/regions', async (c) => {
  const regions = await listPublicDiscoveryRegions(c.env.DB)
  return appApiSuccess(c, regions)
})

appV2Routes.get('/person-profiles/:profileId', async (c) => {
  const profile = await getPublicPersonProfile(c.env.DB, c.req.param('profileId'), c.req.url)
  if (!profile) {
    return appApiError(c, 404, 'PROFILE_NOT_AVAILABLE', '人物资料不存在或当前不可见')
  }
  return appApiSuccess(c, profile)
})

appV2Routes.get('/person-profiles/:profileId/interactions', async (c) => {
  try {
    return appApiSuccess(c, await getViewerInteractionState(
      c.env.DB,
      appPrincipal(c).accountInternalId,
      c.req.param('profileId'),
      c.req.url,
    ))
  }
  catch (error) {
    return appInteractionError(c, error)
  }
})

appV2Routes.get('/person-profiles/:profileId/safety', async (c) => {
  try {
    safetyConfig(c.env)
    return appApiSuccess(c, await getAppProfileBlockState(
      c.env.DB,
      appPrincipal(c).accountInternalId,
      c.req.param('profileId'),
    ))
  }
  catch (error) {
    return appSafetyError(c, error)
  }
})

appV2Routes.put('/person-profiles/:profileId/block', async (c) => {
  try {
    safetyConfig(c.env)
    return appApiSuccess(c, await setAppProfileBlock(
      c.env.DB,
      appPrincipal(c).accountInternalId,
      c.req.param('profileId'),
      true,
      c.req.header('Idempotency-Key') ?? null,
      new Date(),
    ))
  }
  catch (error) {
    return appSafetyError(c, error)
  }
})

appV2Routes.delete('/person-profiles/:profileId/block', async (c) => {
  try {
    safetyConfig(c.env)
    return appApiSuccess(c, await setAppProfileBlock(
      c.env.DB,
      appPrincipal(c).accountInternalId,
      c.req.param('profileId'),
      false,
      c.req.header('Idempotency-Key') ?? null,
      new Date(),
    ))
  }
  catch (error) {
    return appSafetyError(c, error)
  }
})

appV2Routes.get('/me/blocks', async (c) => {
  try {
    safetyConfig(c.env)
    const principal = appPrincipal(c)
    const query = parseAppBlockListQuery({
      limit: c.req.query('limit'),
      cursor: c.req.query('cursor'),
      accountScope: principal.accountId,
    })
    const result = await listAppProfileBlocks(
      c.env.DB,
      principal.accountInternalId,
      principal.accountId,
      c.req.url,
      query,
      new Date(),
    )
    return appApiListSuccess(c, result.data, {
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
    })
  }
  catch (error) {
    return appSafetyError(c, error)
  }
})

appV2Routes.post('/reports', async (c) => {
  try {
    const config = safetyConfig(c.env)
    const result = await createAppSafetyReport(
      c.env.DB,
      appPrincipal(c).accountInternalId,
      config.reasonCatalogId,
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<CreateAppSafetyReportInput>(),
      new Date(),
      config.requireProductionReady,
      appealEligibilityOptions(config),
    )
    return appApiSuccess(c, result, result.replayed ? 200 : 201)
  }
  catch (error) {
    return appSafetyError(c, error)
  }
})

appV2Routes.get('/me/reports', async (c) => {
  try {
    safetyConfig(c.env)
    const principal = appPrincipal(c)
    const query = parseAppReportListQuery({
      limit: c.req.query('limit'),
      cursor: c.req.query('cursor'),
      accountScope: principal.accountId,
    })
    const result = await listAppSafetyReports(
      c.env.DB,
      principal.accountInternalId,
      principal.accountId,
      query,
    )
    return appApiListSuccess(c, result.data, {
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
    })
  }
  catch (error) {
    return appSafetyError(c, error)
  }
})

appV2Routes.get('/me/reports/:reportId', async (c) => {
  try {
    const config = safetyConfig(c.env)
    return appApiSuccess(c, await getAppSafetyReport(
      c.env.DB,
      appPrincipal(c).accountInternalId,
      c.req.param('reportId'),
      appealEligibilityOptions(config),
    ))
  }
  catch (error) {
    return appSafetyError(c, error)
  }
})

appV2Routes.post('/appeals', async (c) => {
  try {
    const config = appealConfig(c.env)
    const result = await createAppSafetyAppeal(
      c.env.DB,
      appPrincipal(c).accountInternalId,
      config.appealPolicyId,
      c.req.header('Idempotency-Key') ?? null,
      await c.req.json<CreateAppSafetyAppealInput>(),
      new Date(),
      config.requireAppealsProductionReady,
    )
    return appApiSuccess(c, result, result.replayed ? 200 : 201)
  }
  catch (error) {
    return appSafetyError(c, error)
  }
})

appV2Routes.get('/me/appeals', async (c) => {
  try {
    appealConfig(c.env)
    const principal = appPrincipal(c)
    const query = parseAppAppealListQuery({
      limit: c.req.query('limit'),
      cursor: c.req.query('cursor'),
      accountScope: principal.accountId,
    })
    const result = await listAppSafetyAppeals(
      c.env.DB,
      principal.accountInternalId,
      principal.accountId,
      query,
    )
    return appApiListSuccess(c, result.data, {
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
    })
  }
  catch (error) {
    return appSafetyError(c, error)
  }
})

appV2Routes.get('/me/appeals/:appealId', async (c) => {
  try {
    appealConfig(c.env)
    return appApiSuccess(c, await getAppSafetyAppeal(
      c.env.DB,
      appPrincipal(c).accountInternalId,
      c.req.param('appealId'),
    ))
  }
  catch (error) {
    return appSafetyError(c, error)
  }
})

for (const interactionType of ['like', 'follow'] as const) {
  appV2Routes.put(`/person-profiles/:profileId/${interactionType}`, async (c) => {
    try {
      return appApiSuccess(c, await setViewerInteraction(
        c.env.DB,
        appPrincipal(c).accountInternalId,
        c.req.param('profileId'),
        interactionType,
        true,
      ))
    }
    catch (error) {
      return appInteractionError(c, error)
    }
  })

  appV2Routes.delete(`/person-profiles/:profileId/${interactionType}`, async (c) => {
    try {
      return appApiSuccess(c, await setViewerInteraction(
        c.env.DB,
        appPrincipal(c).accountInternalId,
        c.req.param('profileId'),
        interactionType,
        false,
      ))
    }
    catch (error) {
      return appInteractionError(c, error)
    }
  })
}

for (const [path, interactionType] of [
  ['/me/likes', 'like'],
  ['/me/follows', 'follow'],
] as const) {
  appV2Routes.get(path, async (c) => {
    try {
      const principal = appPrincipal(c)
      const query = parseAppViewerInteractionQuery({
        limit: c.req.query('limit'),
        cursor: c.req.query('cursor'),
        accountScope: principal.accountId,
        interactionType,
      })
      const result = await listViewerInteractions(
        c.env.DB,
        principal.accountInternalId,
        principal.accountId,
        interactionType,
        query,
        c.req.url,
      )
      return appApiListSuccess(c, result.data, {
        nextCursor: result.nextCursor,
        hasMore: result.hasMore,
      })
    }
    catch (error) {
      return appInteractionError(c, error)
    }
  })
}

appV2Routes.get('/me/follow-updates', async (c) => {
  try {
    const principal = appPrincipal(c)
    const query = parseAppFollowUpdateListQuery({
      limit: c.req.query('limit'),
      cursor: c.req.query('cursor'),
      accountScope: principal.accountId,
    })
    const result = await listAppFollowUpdates(
      c.env.DB,
      principal.accountInternalId,
      principal.accountId,
      c.req.url,
      getAppFollowUpdateRuntimeConfig(c.env),
      query,
    )
    return appApiListSuccess(c, result.data, {
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
    })
  }
  catch (error) {
    return appInteractionError(c, error)
  }
})

appV2Routes.get('/person-profiles/:profileId/favorite', async (c) => {
  try {
    return appApiSuccess(c, await getAppFavoriteState(
      c.env.DB,
      appPrincipal(c).accountInternalId,
      c.req.param('profileId'),
      interactionCollectionConfig(c.env),
    ))
  }
  catch (error) {
    return appInteractionError(c, error)
  }
})

appV2Routes.put('/person-profiles/:profileId/favorite', async (c) => {
  try {
    return appApiSuccess(c, await setAppGlobalFavorite(
      c.env.DB,
      appPrincipal(c).accountInternalId,
      c.req.param('profileId'),
      true,
      interactionCollectionConfig(c.env),
    ))
  }
  catch (error) {
    return appInteractionError(c, error)
  }
})

appV2Routes.delete('/person-profiles/:profileId/favorite', async (c) => {
  try {
    return appApiSuccess(c, await setAppGlobalFavorite(
      c.env.DB,
      appPrincipal(c).accountInternalId,
      c.req.param('profileId'),
      false,
      interactionCollectionConfig(c.env),
    ))
  }
  catch (error) {
    return appInteractionError(c, error)
  }
})

appV2Routes.get('/me/favorites', async (c) => {
  try {
    const principal = appPrincipal(c)
    const query = parseAppFavoriteListQuery({
      limit: c.req.query('limit'),
      cursor: c.req.query('cursor'),
      accountScope: principal.accountId,
    })
    const result = await listAppFavorites(
      c.env.DB,
      principal.accountInternalId,
      principal.accountId,
      null,
      interactionCollectionConfig(c.env),
      query,
      c.req.url,
    )
    return appApiListSuccess(c, result.data, {
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
    })
  }
  catch (error) {
    return appInteractionError(c, error)
  }
})

appV2Routes.get('/me/favorite-folders', async (c) => {
  try {
    return appApiSuccess(c, await listAppFavoriteFolders(
      c.env.DB,
      appPrincipal(c).accountInternalId,
      interactionCollectionConfig(c.env),
      getAppMembershipRuntimeConfig(c.env),
    ))
  }
  catch (error) {
    return appInteractionError(c, error)
  }
})

appV2Routes.put('/me/favorite-folders/:folderId', async (c) => {
  try {
    return appApiSuccess(c, await createAppFavoriteFolder(
      c.env.DB,
      appPrincipal(c).accountInternalId,
      c.req.param('folderId'),
      await c.req.json<CreateAppFavoriteFolderInput>(),
      interactionCollectionConfig(c.env),
      getAppMembershipRuntimeConfig(c.env),
    ), 201)
  }
  catch (error) {
    return appInteractionError(c, error)
  }
})

appV2Routes.patch('/me/favorite-folders/:folderId', async (c) => {
  try {
    return appApiSuccess(c, await updateAppFavoriteFolder(
      c.env.DB,
      appPrincipal(c).accountInternalId,
      c.req.param('folderId'),
      await c.req.json<UpdateAppFavoriteFolderInput>(),
      interactionCollectionConfig(c.env),
    ))
  }
  catch (error) {
    return appInteractionError(c, error)
  }
})

appV2Routes.delete('/me/favorite-folders/:folderId', async (c) => {
  try {
    return appApiSuccess(c, await deleteAppFavoriteFolder(
      c.env.DB,
      appPrincipal(c).accountInternalId,
      c.req.param('folderId'),
      c.req.query('expectedVersion'),
      interactionCollectionConfig(c.env),
    ))
  }
  catch (error) {
    return appInteractionError(c, error)
  }
})

appV2Routes.get('/me/favorite-folders/:folderId/items', async (c) => {
  try {
    const principal = appPrincipal(c)
    const folderId = c.req.param('folderId')
    const query = parseAppFavoriteListQuery({
      limit: c.req.query('limit'),
      cursor: c.req.query('cursor'),
      accountScope: principal.accountId,
      folderId,
    })
    const result = await listAppFavorites(
      c.env.DB,
      principal.accountInternalId,
      principal.accountId,
      folderId,
      interactionCollectionConfig(c.env),
      query,
      c.req.url,
    )
    return appApiListSuccess(c, result.data, {
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
    })
  }
  catch (error) {
    return appInteractionError(c, error)
  }
})

for (const active of [true, false] as const) {
  const method = active ? 'put' : 'delete'
  appV2Routes[method]('/me/favorite-folders/:folderId/items/:profileId', async (c) => {
    try {
      return appApiSuccess(c, await setAppFavoriteFolderItem(
        c.env.DB,
        appPrincipal(c).accountInternalId,
        c.req.param('folderId'),
        c.req.param('profileId'),
        active,
        interactionCollectionConfig(c.env),
      ))
    }
    catch (error) {
      return appInteractionError(c, error)
    }
  })
}

appV2Routes.get('/me/view-history/settings', async (c) => {
  try {
    return appApiSuccess(c, await getAppViewHistorySettings(
      c.env.DB,
      appPrincipal(c).accountInternalId,
      interactionCollectionConfig(c.env),
      getAppMembershipRuntimeConfig(c.env),
    ))
  }
  catch (error) {
    return appInteractionError(c, error)
  }
})

appV2Routes.put('/me/view-history/settings', async (c) => {
  try {
    return appApiSuccess(c, await updateAppViewHistorySettings(
      c.env.DB,
      appPrincipal(c).accountInternalId,
      await c.req.json<UpdateAppViewHistorySettingsInput>(),
      interactionCollectionConfig(c.env),
      getAppMembershipRuntimeConfig(c.env),
    ))
  }
  catch (error) {
    return appInteractionError(c, error)
  }
})

appV2Routes.post('/person-profiles/:profileId/view-history', async (c) => {
  try {
    return appApiSuccess(c, await recordAppProfileView(
      c.env.DB,
      appPrincipal(c).accountInternalId,
      c.req.param('profileId'),
      await c.req.json<RecordAppProfileViewInput>(),
      interactionCollectionConfig(c.env),
      getAppMembershipRuntimeConfig(c.env),
    ))
  }
  catch (error) {
    return appInteractionError(c, error)
  }
})

appV2Routes.get('/me/view-history', async (c) => {
  try {
    const principal = appPrincipal(c)
    const query = parseAppViewHistoryListQuery({
      limit: c.req.query('limit'),
      cursor: c.req.query('cursor'),
      accountScope: principal.accountId,
    })
    const result = await listAppViewHistory(
      c.env.DB,
      principal.accountInternalId,
      principal.accountId,
      interactionCollectionConfig(c.env),
      getAppMembershipRuntimeConfig(c.env),
      query,
      c.req.url,
    )
    return appApiListSuccess(c, result.data, {
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
    })
  }
  catch (error) {
    return appInteractionError(c, error)
  }
})

appV2Routes.post('/me/view-history/clear', async (c) => {
  try {
    return appApiSuccess(c, await clearAppViewHistory(
      c.env.DB,
      appPrincipal(c).accountInternalId,
      await c.req.json<ClearAppViewHistoryInput>(),
      interactionCollectionConfig(c.env),
    ))
  }
  catch (error) {
    return appInteractionError(c, error)
  }
})

appV2Routes.delete('/me/view-history/:profileId', async (c) => {
  try {
    return appApiSuccess(c, await deleteAppViewHistoryItem(
      c.env.DB,
      appPrincipal(c).accountInternalId,
      c.req.param('profileId'),
      interactionCollectionConfig(c.env),
    ))
  }
  catch (error) {
    return appInteractionError(c, error)
  }
})

async function bootstrapConfig(env: Bindings): Promise<AppBootstrapConfig> {
  const auth = getAppAuthRuntimeConfig(env)
  const membership = getAppMembershipRuntimeConfig(env)
  const messaging = getAppMessagingRuntimeConfig(env)
  const safety = getAppSafetyRuntimeConfig(env)
  const notifications = getAppNotificationRuntimeConfig(env)
  const wallet = getAppWalletRuntimeConfig(env)
  const interactionCollections = getAppInteractionCollectionRuntimeConfig(env)
  const followUpdates = getAppFollowUpdateRuntimeConfig(env)
  const [interactionCollectionCapabilities, followUpdatesCapability] = auth.enabled
    ? await Promise.all([
        resolveAppInteractionCollectionCapabilities(env.DB, interactionCollections),
        resolveAppFollowUpdateCapability(env.DB, followUpdates),
      ])
    : [{ favorite: false, history: false }, false]
  return {
    product: 'meigallery',
    appVersion: '1.0',
    capabilities: {
      discovery: true,
      auth: auth.enabled,
      interactions: {
        like: auth.enabled,
        follow: auth.enabled,
        followUpdates: followUpdatesCapability,
        favorite: interactionCollectionCapabilities.favorite,
        history: interactionCollectionCapabilities.history,
      },
      membership: {
        catalog: membership.enabled,
        entitlements: membership.enabled && auth.enabled,
        applications: membership.applicationsEnabled && auth.enabled,
      },
      messaging: auth.enabled && messaging.enabled,
      notifications: auth.enabled && notifications.enabled,
      wallet: auth.enabled && wallet.enabled,
      safety: {
        reports: auth.enabled && safety.enabled,
        blocks: auth.enabled && safety.enabled,
        conversationClose: auth.enabled && safety.enabled && messaging.enabled,
        appeals: auth.enabled && safety.appealsEnabled,
      },
      payments: false,
      systemPush: false,
    },
    discovery: {
      defaultSort: 'recommended',
      allowedSorts: APP_DISCOVERY_SORTS,
      defaultPageSize: APP_DISCOVERY_DEFAULT_PAGE_SIZE,
      maxPageSize: APP_DISCOVERY_MAX_PAGE_SIZE,
    },
    interactionCollections: {
      policyVersion: interactionCollections.policyId || APP_INTERACTION_COLLECTION_POLICY_ID,
      defaultFolderLabel: APP_FAVORITE_DEFAULT_FOLDER_LABEL,
      maxFolderNameLength: APP_FAVORITE_MAX_FOLDER_NAME_LENGTH,
      maxItemsPerFolder: APP_FAVORITE_MAX_ITEMS_PER_FOLDER,
      historyRecordingDefault: false,
    },
    followUpdates: {
      policyVersion: followUpdates.policyId || APP_FOLLOW_UPDATE_POLICY_ID,
      transport: 'http_pull',
      maxPageSize: APP_FOLLOW_UPDATE_MAX_PAGE_SIZE,
      notificationMode: 'in_app_only',
    },
    auth: {
      methods: auth.methods,
      registrationEnabled: auth.registrationEnabled,
      deviceManagementEnabled: auth.enabled,
      accessTokenTtlSeconds: auth.accessTokenTtlSeconds,
      challenge: auth.enabled ? auth.challenge : { type: 'none' },
      documents: auth.enabled && auth.documentVersions && auth.documentUrls
        ? {
            termsVersion: auth.documentVersions.terms,
            privacyVersion: auth.documentVersions.privacy,
            platformOperationVersion: auth.documentVersions.platformOperation,
            eligibilityVersion: auth.documentVersions.eligibility,
            termsUrl: auth.documentUrls.terms,
            privacyUrl: auth.documentUrls.privacy,
            platformOperationUrl: auth.documentUrls.platformOperation,
            eligibilityUrl: auth.documentUrls.eligibility,
          }
        : null,
    },
    membershipApplications: {
      disclosureVersion: APP_MEMBERSHIP_APPLICATION_DISCLOSURE_VERSION,
      disclosureText: APP_MEMBERSHIP_APPLICATION_DISCLOSURE_TEXT,
      contactMethod: 'verified_email',
      maxStatementLength: APP_MEMBERSHIP_APPLICATION_MAX_STATEMENT_LENGTH,
      contactWindows: [...APP_MEMBERSHIP_APPLICATION_CONTACT_WINDOWS],
    },
    messaging: {
      receiverLabel: APP_MESSAGING_RECEIVER_LABEL,
      disclosureVersion: messaging.disclosureVersion,
      disclosureText: APP_MESSAGING_DISCLOSURE_TEXT,
      transport: 'http_pull',
      maxTextLength: APP_MESSAGING_MAX_TEXT_LENGTH,
    },
    notifications: {
      policyVersion: notifications.policyId,
      transport: 'http_pull',
      maxPageSize: APP_NOTIFICATION_MAX_PAGE_SIZE,
      categories: [...APP_NOTIFICATION_CATEGORIES],
    },
    wallet: {
      policyVersion: wallet.policyId,
      currencyCode: 'mei_coin',
      displayName: '金币',
      minorUnit: 0,
      maxPageSize: APP_WALLET_MAX_PAGE_SIZE,
      directions: ['credit', 'debit'],
      disclaimer: APP_WALLET_DISCLAIMER,
      payments: false,
      recharge: false,
      spending: false,
      transfer: false,
      withdrawal: false,
    },
    safety: {
      reasonCatalogVersion: safety.reasonCatalogId,
      appealPolicyVersion: safety.appealPolicyId,
      maxDescriptionLength: APP_SAFETY_MAX_DESCRIPTION_LENGTH,
      maxAppealStatementLength: APP_SAFETY_MAX_APPEAL_STATEMENT_LENGTH,
      reportTargets: APP_SAFETY_REPORT_TARGETS,
      reasons: APP_SAFETY_REASONS,
    },
  }
}

function notificationConfig(env: Bindings) {
  const config = getAppNotificationRuntimeConfig(env)
  requireAppNotificationsEnabled(config)
  return config
}

function notificationTargetCapabilities(env: Bindings) {
  const auth = getAppAuthRuntimeConfig(env)
  const membership = getAppMembershipRuntimeConfig(env)
  const messaging = getAppMessagingRuntimeConfig(env)
  const safety = getAppSafetyRuntimeConfig(env)
  const wallet = getAppWalletRuntimeConfig(env)
  return {
    messaging: auth.enabled && messaging.enabled,
    profiles: true,
    membership: auth.enabled && membership.enabled,
    membershipApplications: auth.enabled && membership.applicationsEnabled,
    safetyReports: auth.enabled && safety.enabled,
    safetyAppeals: auth.enabled && safety.appealsEnabled,
    accountSecurity: auth.enabled,
    wallet: auth.enabled && wallet.enabled,
  }
}

function walletConfig(env: Bindings) {
  const config = getAppWalletRuntimeConfig(env)
  requireAppWalletEnabled(config)
  return config
}

function messagingConfig(env: Bindings) {
  const config = getAppMessagingRuntimeConfig(env)
  requireAppMessagingEnabled(config)
  return config
}

function safetyConfig(env: Bindings) {
  const config = getAppSafetyRuntimeConfig(env)
  requireAppSafetyEnabled(config)
  return config
}

function appealConfig(env: Bindings) {
  const config = getAppSafetyRuntimeConfig(env)
  requireAppSafetyAppealsEnabled(config)
  return config
}

function appealEligibilityOptions(config: ReturnType<typeof getAppSafetyRuntimeConfig>) {
  return {
    enabled: config.appealsEnabled,
    policyId: config.appealPolicyId,
    requireProductionReady: config.requireAppealsProductionReady,
  }
}

function appSafetyError(
  c: Parameters<typeof appApiError>[0],
  error: unknown,
) {
  if (error instanceof AppSafetyError) {
    return appApiError(c, error.status, error.code, error.message, error.retryable)
  }
  return appMessagingError(c, error)
}

function appMessagingError(
  c: Parameters<typeof appApiError>[0],
  error: unknown,
) {
  if (error instanceof AppMessagingError) {
    return appApiError(c, error.status, error.code, error.message, error.retryable)
  }
  return appMembershipError(c, error)
}

function appNotificationError(
  c: Parameters<typeof appApiError>[0],
  error: unknown,
) {
  if (error instanceof AppNotificationError) {
    return appApiError(c, error.status, error.code, error.message, error.retryable)
  }
  throw error
}

function appWalletError(
  c: Parameters<typeof appApiError>[0],
  error: unknown,
) {
  if (error instanceof AppWalletError) {
    return appApiError(c, error.status, error.code, error.message, error.retryable)
  }
  throw error
}

function appMembershipError(
  c: Parameters<typeof appApiError>[0],
  error: unknown,
) {
  if (error instanceof AppMembershipError) {
    return appApiError(c, error.status, error.code, error.message, error.retryable)
  }
  throw error
}

function appInteractionError(
  c: Parameters<typeof appApiError>[0],
  error: unknown,
) {
  if (error instanceof AppViewerInteractionError) {
    return appApiError(c, error.status, error.code, error.message)
  }
  if (error instanceof AppInteractionCollectionError) {
    return appApiError(c, error.status, error.code, error.message, error.retryable)
  }
  if (error instanceof AppFollowUpdateError) {
    return appApiError(c, error.status, error.code, error.message, error.retryable)
  }
  throw error
}

function interactionCollectionConfig(env: Bindings) {
  return getAppInteractionCollectionRuntimeConfig(env)
}

function appPrincipal(c: {
  get(name: 'appAccountId'): number | undefined
  get(name: 'appAccountPublicId'): string | undefined
  get(name: 'appSessionId'): string | undefined
  get(name: 'appDeviceId'): string | undefined
  get(name: 'appAccountEmail'): string | undefined
  get(name: 'appAccountNickname'): string | null | undefined
  get(name: 'appAccountRole'): string | undefined
}): AppSessionPrincipal {
  return {
    accountInternalId: c.get('appAccountId')!,
    accountId: c.get('appAccountPublicId')!,
    sessionId: c.get('appSessionId')!,
    deviceId: c.get('appDeviceId')!,
    email: c.get('appAccountEmail')!,
    nickname: c.get('appAccountNickname') ?? null,
    role: c.get('appAccountRole')!,
  }
}
