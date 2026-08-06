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
  AppMembershipError,
  getAppMembershipCatalog,
  getAppMembershipRuntimeConfig,
  requireAppMembershipEnabled,
  resolveAppMembershipSnapshot,
} from '../services/app-membership'
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
  setAppProfileBlock,
  type CreateAppSafetyReportInput,
} from '../services/app-safety'

export const appV2Routes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

appV2Routes.use('*', async (c, next) => {
  await next()
  c.header('Cache-Control', 'no-store')
})

appV2Routes.get('/app/bootstrap', (c) => {
  return appApiSuccess(c, bootstrapConfig(c.env))
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
  '/person-profiles/:profileId/safety',
  '/person-profiles/:profileId/block',
  '/reports',
  '/reports/*',
  '/conversations',
  '/conversations/*',
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
      { requireProductionReady: config.requireProductionReady },
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
    safetyConfig(c.env)
    return appApiSuccess(c, await getAppSafetyReport(
      c.env.DB,
      appPrincipal(c).accountInternalId,
      c.req.param('reportId'),
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

function bootstrapConfig(env: Bindings): AppBootstrapConfig {
  const auth = getAppAuthRuntimeConfig(env)
  const membership = getAppMembershipRuntimeConfig(env)
  const messaging = getAppMessagingRuntimeConfig(env)
  const safety = getAppSafetyRuntimeConfig(env)
  return {
    product: 'meigallery',
    appVersion: '1.0',
    capabilities: {
      discovery: true,
      auth: auth.enabled,
      interactions: {
        like: auth.enabled,
        follow: auth.enabled,
        favorite: false,
        history: false,
      },
      membership: {
        catalog: membership.enabled,
        entitlements: membership.enabled && auth.enabled,
        applications: false,
      },
      messaging: auth.enabled && messaging.enabled,
      safety: {
        reports: auth.enabled && safety.enabled,
        blocks: auth.enabled && safety.enabled,
        conversationClose: auth.enabled && safety.enabled && messaging.enabled,
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
    messaging: {
      receiverLabel: APP_MESSAGING_RECEIVER_LABEL,
      disclosureVersion: messaging.disclosureVersion,
      disclosureText: APP_MESSAGING_DISCLOSURE_TEXT,
      transport: 'http_pull',
      maxTextLength: APP_MESSAGING_MAX_TEXT_LENGTH,
    },
    safety: {
      reasonCatalogVersion: safety.reasonCatalogId,
      maxDescriptionLength: APP_SAFETY_MAX_DESCRIPTION_LENGTH,
      reportTargets: APP_SAFETY_REPORT_TARGETS,
      reasons: APP_SAFETY_REASONS,
    },
  }
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
  throw error
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
