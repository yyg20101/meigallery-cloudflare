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

export const appV2Routes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

appV2Routes.use('*', async (c, next) => {
  await next()
  c.header('Cache-Control', 'no-store')
})

const bootstrapConfig: AppBootstrapConfig = {
  product: 'meigallery',
  appVersion: '1.0',
  capabilities: {
    discovery: true,
    auth: false,
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
}

appV2Routes.get('/app/bootstrap', (c) => {
  return appApiSuccess(c, bootstrapConfig)
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
