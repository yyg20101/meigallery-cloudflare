import { readFileSync } from 'node:fs'
import { Miniflare } from 'miniflare'
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest'
import type { AttributionBindings } from './env'
import {
  app,
  attributionServiceApp,
} from './index'
import {
  readAttributionRuntimeState,
  transitionAttributionRuntimeMode,
} from './services/runtime-state'

const migration = readFileSync(
  new URL('../migrations/0004_runtime_state.sql', import.meta.url),
  'utf8',
)
const origin = 'https://616618.xyz'
let miniflare: Miniflare
let db: D1Database

const queue = {
  send: async () => {},
} as unknown as Queue

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-05-26',
    d1Databases: { DB: 'runtime-mode' },
  })
  db = (await miniflare.getBindings<{ DB: D1Database }>()).DB
  await db.exec(migration.replace(/\s*\r?\n\s*/g, ' '))
})

afterAll(async () => {
  await miniflare.dispose()
})

beforeEach(async () => {
  await db.prepare(`
    UPDATE attribution_runtime_state
    SET mode = 'shadow',
        activated_at = NULL,
        updated_at = '2026-07-24T00:00:00.000Z'
    WHERE id = 'global'
  `).run()
})

describe('Attribution Worker 运行模式', () => {
  it('默认 shadow 且只能按顺序单向切换，重复命令幂等', async () => {
    expect(await readAttributionRuntimeState(db)).toMatchObject({
      mode: 'shadow',
      activatedAt: null,
    })

    await expect(
      transitionAttributionRuntimeMode(db, 'active'),
    ).rejects.toThrow('ATTRIBUTION_RUNTIME_TRANSITION_INVALID')

    await transitionAttributionRuntimeMode(db, 'bridge')
    await transitionAttributionRuntimeMode(db, 'bridge')
    expect((await readAttributionRuntimeState(db)).mode).toBe('bridge')

    await transitionAttributionRuntimeMode(db, 'active')
    await transitionAttributionRuntimeMode(db, 'active')
    expect(await readAttributionRuntimeState(db)).toMatchObject({
      mode: 'active',
      activatedAt: expect.any(String),
    })

    await expect(
      transitionAttributionRuntimeMode(db, 'bridge'),
    ).rejects.toThrow('ATTRIBUTION_RUNTIME_TRANSITION_INVALID')
  })

  it('shadow 拒绝公开事实与普通内部事实，health 暴露当前模式', async () => {
    const env = bindings()

    const health = await app.request('/health', {}, env)
    expect(health.status).toBe(200)
    expect(await health.json()).toMatchObject({
      status: 'ok',
      runtimeMode: 'shadow',
    })

    const publicFact = await app.request('/v1/events/contact', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
      },
      body: '{}',
    }, env)
    expect(publicFact.status).toBe(503)
    expect(await publicFact.json()).toMatchObject({
      code: 'ATTRIBUTION_NOT_ACTIVE',
      runtimeMode: 'shadow',
    })

    const internalFact = await attributionServiceApp.request(
      '/internal/v1/registration-events',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      },
      env,
    )
    expect(internalFact.status).toBe(503)
    expect(await internalFact.json()).toMatchObject({
      code: 'ATTRIBUTION_NOT_ACTIVE',
      runtimeMode: 'shadow',
    })
  })

  it('active 放行到既有请求校验，不用 Git revision 决策', async () => {
    await transitionAttributionRuntimeMode(db, 'bridge')
    await transitionAttributionRuntimeMode(db, 'active')
    const env = bindings()

    const publicFact = await app.request('/v1/events/contact', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
      },
      body: '{}',
    }, env)
    expect(publicFact.status).toBe(400)
    expect(await publicFact.json()).toMatchObject({
      code: 'ATTRIBUTION_CONTACT_REQUEST_INVALID',
    })

    const internalFact = await attributionServiceApp.request(
      '/internal/v1/registration-events',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      },
      env,
    )
    expect(internalFact.status).toBe(400)
    expect(await internalFact.json()).toMatchObject({
      code: 'ATTRIBUTION_REGISTRATION_EVENT_INVALID',
    })
  })
})

function bindings(): AttributionBindings {
  return {
    DB: db,
    APP_ENV: 'production',
    ATTRIBUTION_PUBLIC_ORIGINS: origin,
    ATTRIBUTION_COOKIE_DOMAIN: '.616618.xyz',
    ATTRIBUTION_CREDENTIAL_MASTER_KEY_CURRENT:
      'runtime-mode-credential-master-key-current',
    ATTRIBUTION_SIGNING_KEY_CURRENT:
      'runtime-mode-signing-key-current-at-least-32-bytes',
    ATTRIBUTION_DATA_ENCRYPTION_KEY_CURRENT:
      'runtime-mode-data-encryption-key-current',
    META_QUEUE: queue,
    TIKTOK_QUEUE: queue,
    GOOGLE_QUEUE: queue,
    ATTRIBUTION_CANDIDATE_VALIDATION_WORKFLOW: {
      createBatch: async () => [],
    } as unknown as AttributionBindings[
      'ATTRIBUTION_CANDIDATE_VALIDATION_WORKFLOW'
    ],
  }
}
