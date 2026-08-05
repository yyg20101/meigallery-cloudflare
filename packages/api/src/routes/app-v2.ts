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

export const appV2Routes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

appV2Routes.use('*', async (c, next) => {
  await next()
  c.header('Cache-Control', 'no-store')
})

appV2Routes.get('/app/bootstrap', (c) => {
  return appApiSuccess(c, bootstrapConfig(c.env))
})

appV2Routes.route('/auth', appAuthRoutes)

for (const path of [
  '/me',
  '/me/*',
  '/person-profiles/:profileId/interactions',
  '/person-profiles/:profileId/like',
  '/person-profiles/:profileId/follow',
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
  return appApiSuccess(c, await getAppAccount(c.env.DB, appPrincipal(c)))
})

appV2Routes.get('/me/devices', async (c) => {
  return appApiSuccess(c, await listAppDevices(c.env.DB, appPrincipal(c)))
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
    const result = await listPublicPersonProfiles(c.env.DB, query, c.req.url)
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
      messaging: false,
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
  }
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
