import { Hono } from 'hono'
import type { Bindings, Variables } from '../index'

export const healthRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

healthRoutes.get('/', async (c) => {
  let dbStatus: 'ok' | 'error' | 'unavailable'

  try {
    const result = await c.env.DB.prepare('SELECT 1 as ok').first<{ ok: number }>()
    dbStatus = result?.ok === 1 ? 'ok' : 'error'
  } catch {
    dbStatus = 'unavailable'
  }

  const environment = String(c.env.APP_ENV || '').trim()
  const releaseCommit = String(c.env.RELEASE_COMMIT || '').trim()
  const environmentValid = /^(production|dev|test|development)$/.test(environment)
  const commitValid = /^[0-9a-f]{40}$/i.test(releaseCommit)
  const healthy = dbStatus === 'ok' && environmentValid && commitValid

  c.header('Cache-Control', 'no-store')
  return c.json({
    status: healthy ? 'ok' : 'unhealthy',
    timestamp: new Date().toISOString(),
    db: dbStatus,
    environment: environmentValid ? environment : null,
    commit: commitValid ? releaseCommit.toLowerCase() : null,
    errors: [
      ...(dbStatus === 'ok' ? [] : ['DB_UNHEALTHY']),
      ...(environmentValid ? [] : ['APP_ENV_INVALID']),
      ...(commitValid ? [] : ['RELEASE_COMMIT_INVALID']),
    ],
  })
})
