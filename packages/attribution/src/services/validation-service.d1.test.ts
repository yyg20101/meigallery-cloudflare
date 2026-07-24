import { readFileSync } from 'node:fs'
import type { AttributionProvider } from '@meigallery/shared'
import { Miniflare } from 'miniflare'
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import type {
  AttributionProviderAdapter,
  CandidateValidationInput,
  ServerDeliveryInput,
} from '../adapters/types'
import { clearAttributionRuntimeDatabase } from '../test/attribution-schema'
import {
  createAttributionConnectionCommands,
  type CreateCandidateInput,
} from './connection-commands'
import {
  consumeAttributionQueue,
  type AttributionQueueConsumerEnvironment,
} from './queue-consumer'
import type { AttributionQueueMessage } from './secure-outbox'
import {
  activateValidatedCandidate,
  completeCandidateValidation,
  createCandidateSyntheticFacts,
  destroyValidationSecret,
  failCandidateValidation,
  prepareCandidateValidation,
  readCandidateDeliveryState,
  startCandidateValidation,
  verifyCandidateBrowserPairing,
  type CandidateValidationEnvironment,
} from './validation-service'

const MIGRATIONS = [
  '../../migrations/0001_attribution_runtime.sql',
  '../../migrations/0002_event_delivery.sql',
  '../../migrations/0003_queue_runtime.sql',
].map(path => readFileSync(new URL(path, import.meta.url), 'utf8'))
const NOW = new Date('2026-07-24T08:00:00.000Z')
const CREDENTIAL_KEYS = {
  current: 'validation-credential-key-current-20260724',
}
const DATA_KEYS = {
  current: 'validation-data-key-current-20260724',
}
const SIGNING_KEYS = {
  current: 'validation-signing-key-current-20260724',
}
const TEST_CODE = 'TEST12345'

let miniflare: Miniflare
let db: D1Database
let queued: AttributionQueueMessage[]
let idSequence: number

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-05-26',
    d1Databases: { DB: 'candidate-validation' },
  })
  db = (await miniflare.getBindings<{ DB: D1Database }>()).DB
  for (const migration of MIGRATIONS) {
    await db.exec(migration.replace(/\s*\r?\n\s*/g, ' '))
  }
})

afterAll(async () => {
  await miniflare.dispose()
})

beforeEach(async () => {
  await clearAttributionRuntimeDatabase(db)
  queued = []
  idSequence = 0
})

describe('候选版本全链路验证', () => {
  it('配置验证失败时旧 Active 与运行策略保持不变并销毁测试码', async () => {
    const { candidateId, oldActiveId } = await seedConnection()
    const beforePolicy = await policy()
    const rejectingAdapter = adapter({
      validateCandidate: vi.fn().mockRejectedValue(
        new Error('invalid credential'),
      ),
    })
    const environment = validationEnvironment(rejectingAdapter)
    const started = await startCandidateValidation(environment, {
      connectionId: 'conn_meta',
      candidateId,
      actorId: 1,
      testEventCode: TEST_CODE,
    })

    await expect(prepareCandidateValidation(
      environment,
      started.validationId,
    )).rejects.toThrow()
    await failCandidateValidation(
      environment,
      started.validationId,
      'candidate_configuration_invalid',
    )
    await destroyValidationSecret(environment, started.validationId)

    expect(await activeVersionId()).toBe(oldActiveId)
    expect(await policy()).toEqual(beforePolicy)
    expect(await versionStatus(candidateId)).toEqual({
      status: 'failed',
      failure_code: 'candidate_configuration_invalid',
    })
    expect(await validation(started.validationId)).toMatchObject({
      status: 'failed',
      failure_code: 'candidate_configuration_invalid',
    })
    expect(await validationSecret(started.validationId)).toBeNull()
  })

  it('正常事实、Planner、Queue 和 Adapter 通过后自动激活候选', async () => {
    const { candidateId } = await seedConnection()
    const deliver = vi.fn().mockResolvedValue({
      provider: 'meta',
      classification: 'accepted',
      httpStatus: 200,
      requestId: 'request_validation',
    })
    const providerAdapter = adapter({ deliverServerEvent: deliver })
    const environment = validationEnvironment(providerAdapter)
    const started = await startCandidateValidation(environment, {
      connectionId: 'conn_meta',
      candidateId,
      actorId: 1,
      testEventCode: TEST_CODE,
    })

    await prepareCandidateValidation(environment, started.validationId)
    const facts = await createCandidateSyntheticFacts(
      environment,
      started.validationId,
    )
    expect(facts).toHaveLength(2)
    expect(queued).toHaveLength(2)
    expect(await syntheticCount(candidateId)).toEqual({
      facts: 2,
      browser: 2,
      server: 2,
    })

    await consumeAttributionQueue(
      queueBatch('meigallery-attribution-meta', queued),
      queueEnvironment(providerAdapter),
    )

    expect(deliver).toHaveBeenCalledTimes(2)
    expect(deliver.mock.calls.map(call => call[0])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          canonicalEvent: 'Contact',
          validateOnly: true,
          testEventCode: TEST_CODE,
        }),
        expect.objectContaining({
          canonicalEvent: 'CompleteRegistration',
          validateOnly: true,
          testEventCode: TEST_CODE,
        }),
      ]),
    )
    expect(await readCandidateDeliveryState(
      environment,
      started.validationId,
    )).toEqual({ status: 'accepted', accepted: 2, total: 2 })

    const browserEvidence = await verifyCandidateBrowserPairing(
      environment,
      started.validationId,
    )
    expect(browserEvidence.pairedEvents).toBe(2)
    expect(browserEvidence.externalEventIds).toHaveLength(2)

    await activateValidatedCandidate(environment, started.validationId)
    await completeCandidateValidation(environment, started.validationId)
    await destroyValidationSecret(environment, started.validationId)

    expect(await activeVersionId()).toBe(candidateId)
    expect(await versionStatus(candidateId)).toMatchObject({
      status: 'active',
      failure_code: '',
    })
    expect(await validation(started.validationId)).toMatchObject({
      status: 'verified',
      failure_code: '',
    })
    expect(await validationSecret(started.validationId)).toBeNull()
    expect(JSON.stringify(await auditRows())).not.toContain(TEST_CODE)
  })

  it('重复开始验证复用同一 validation 和 Workflow 实例', async () => {
    const { candidateId } = await seedConnection()
    const status = vi.fn().mockResolvedValue({ status: 'running' })
    const get = vi.fn().mockResolvedValue({ status })
    const createBatch = vi.fn()
      .mockResolvedValueOnce([{ id: 'workflow' }])
      .mockRejectedValueOnce(new Error('instance already exists'))
    const environment = validationEnvironment(adapter(), {
      workflow: { createBatch, get } as unknown as Workflow<{
        validationId: string
      }>,
    })
    const input = {
      connectionId: 'conn_meta',
      candidateId,
      actorId: 1,
      testEventCode: TEST_CODE,
    }

    const first = await startCandidateValidation(environment, input)
    const second = await startCandidateValidation(environment, input)

    expect(second).toEqual(first)
    expect(createBatch).toHaveBeenCalledTimes(2)
    expect(get).toHaveBeenCalledWith(
      `candidate-validation-${first.validationId}`,
    )
    expect(status).toHaveBeenCalledTimes(1)
    expect(await scalar(
      'SELECT COUNT(*) AS value FROM attribution_validations',
    )).toBe(1)
  })

  it('Workflow 重放复用稳定事实且不会重复发送 Queue', async () => {
    const { candidateId } = await seedConnection()
    let now = NOW
    const environment = validationEnvironment(adapter(), {
      now: () => now,
    })
    const started = await startCandidateValidation(environment, {
      connectionId: 'conn_meta',
      candidateId,
      actorId: 1,
      testEventCode: TEST_CODE,
    })
    await prepareCandidateValidation(environment, started.validationId)

    const first = await createCandidateSyntheticFacts(
      environment,
      started.validationId,
    )
    now = new Date(NOW.getTime() + 60_000)
    const replayed = await createCandidateSyntheticFacts(
      environment,
      started.validationId,
    )

    expect(replayed.map(fact => fact.factId)).toEqual(
      first.map(fact => fact.factId),
    )
    expect(queued).toHaveLength(2)
    expect(await syntheticCount(candidateId)).toEqual({
      facts: 2,
      browser: 2,
      server: 2,
    })
  })

  it('Queue 首次发送失败时保留 retrying 并等待 D1 恢复', async () => {
    const { candidateId } = await seedConnection()
    const failingQueue = {
      send: vi.fn().mockRejectedValue(new Error('queue unavailable')),
    } as unknown as Queue<AttributionQueueMessage>
    const environment = validationEnvironment(adapter(), {
      queues: {
        meta: failingQueue,
        tiktok: queue(),
        google: queue(),
      },
    })
    const started = await startCandidateValidation(environment, {
      connectionId: 'conn_meta',
      candidateId,
      actorId: 1,
      testEventCode: TEST_CODE,
    })
    await prepareCandidateValidation(environment, started.validationId)

    await expect(createCandidateSyntheticFacts(
      environment,
      started.validationId,
    )).resolves.toHaveLength(2)

    expect(await readCandidateDeliveryState(
      environment,
      started.validationId,
    )).toEqual({ status: 'pending', accepted: 0, total: 2 })
    expect(await scalar(`
      SELECT COUNT(*) AS value
      FROM attribution_deliveries
      WHERE version_id = '${candidateId}'
        AND transport = 'server'
        AND status = 'retrying'
    `)).toBe(2)
  })

  it('验证启动事务失败时保留 candidate 并销毁临时秘密', async () => {
    const { candidateId } = await seedConnection()
    let batchCalls = 0
    const failingDb = {
      prepare: db.prepare.bind(db),
      batch: async (statements: D1PreparedStatement[]) => {
        batchCalls += 1
        if (batchCalls === 2) {
          throw new Error('begin validation unavailable')
        }
        return db.batch(statements)
      },
    } as unknown as D1Database
    const environment = validationEnvironment(adapter(), {
      db: failingDb,
    })

    await expect(startCandidateValidation(environment, {
      connectionId: 'conn_meta',
      candidateId,
      actorId: 1,
      testEventCode: TEST_CODE,
    })).rejects.toThrow()

    expect(await versionStatus(candidateId)).toEqual({
      status: 'candidate',
      failure_code: '',
    })
    expect(await scalar(`
      SELECT COUNT(*) AS value
      FROM attribution_validations
      WHERE candidate_version_id = '${candidateId}'
        AND status = 'failed'
        AND failure_code = 'candidate_validation_start_failed'
    `)).toBe(1)
    expect(await scalar(`
      SELECT COUNT(*) AS value
      FROM attribution_validation_secrets
    `)).toBe(0)
  })

  it('候选测试投递失败不改写旧 Active、rollout 或线上熔断', async () => {
    const { candidateId, oldActiveId } = await seedConnection()
    const beforePolicy = await policy()
    const providerAdapter = adapter({
      deliverServerEvent: vi.fn().mockResolvedValue({
        provider: 'meta',
        classification: 'credential_invalid',
        httpStatus: 401,
      }),
    })
    const environment = validationEnvironment(providerAdapter)
    const started = await startCandidateValidation(environment, {
      connectionId: 'conn_meta',
      candidateId,
      actorId: 1,
      testEventCode: TEST_CODE,
    })

    await prepareCandidateValidation(environment, started.validationId)
    await createCandidateSyntheticFacts(environment, started.validationId)
    await consumeAttributionQueue(
      queueBatch('meigallery-attribution-meta', queued),
      queueEnvironment(providerAdapter),
    )

    expect(await readCandidateDeliveryState(
      environment,
      started.validationId,
    )).toMatchObject({ status: 'failed' })
    expect(await activeVersionId()).toBe(oldActiveId)
    expect(await policy()).toEqual(beforePolicy)
    expect(await scalar(`
      SELECT COUNT(*) AS value
      FROM attribution_incidents
      WHERE connection_id = 'conn_meta'
    `)).toBe(0)
  })
})

function validationEnvironment(
  providerAdapter: AttributionProviderAdapter,
  overrides: Partial<CandidateValidationEnvironment> = {},
): CandidateValidationEnvironment {
  return {
    db,
    appEnvironment: 'production',
    credentialMasterKeys: CREDENTIAL_KEYS,
    dataEncryptionKeys: DATA_KEYS,
    signingKeys: SIGNING_KEYS,
    queues: {
      meta: queue(),
      tiktok: queue(),
      google: queue(),
    },
    workflow: {
      createBatch: vi.fn().mockResolvedValue([{ id: 'workflow' }]),
    } as unknown as Workflow<{ validationId: string }>,
    adapterFor: () => providerAdapter,
    now: () => NOW,
    idFactory: prefix => `${prefix}_${++idSequence}`,
    ...overrides,
  }
}

function queueEnvironment(
  providerAdapter: AttributionProviderAdapter,
): AttributionQueueConsumerEnvironment {
  return {
    db,
    appEnvironment: 'production',
    publicOrigins: ['https://616618.xyz'],
    credentialMasterKeys: CREDENTIAL_KEYS,
    dataEncryptionKeys: DATA_KEYS,
    adapterFor: () => providerAdapter,
    now: () => NOW,
    idFactory: prefix => `${prefix}_validation_consumer`,
  }
}

function queue() {
  return {
    async send(message: AttributionQueueMessage) {
      queued.push(message)
    },
  } as unknown as Queue<AttributionQueueMessage>
}

function queueBatch(
  name: string,
  messages: AttributionQueueMessage[],
): MessageBatch<AttributionQueueMessage> {
  return {
    queue: name,
    messages: messages.map((body, index) => ({
      id: `validation_message_${index}`,
      timestamp: NOW,
      body,
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    })) as unknown as Message<AttributionQueueMessage>[],
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<AttributionQueueMessage>
}

function adapter(
  overrides: Partial<AttributionProviderAdapter> = {},
): AttributionProviderAdapter {
  return {
    provider: 'meta',
    eventName: event => event,
    normalizeTestEventCode: value =>
      typeof value === 'string' && /^TEST\d+$/.test(value)
        ? value
        : null,
    validateCandidate: vi.fn(
      async (input: CandidateValidationInput) => ({
        schemaVersion: 1,
        provider: input.provider,
        connectionId: input.connectionId,
        versionId: input.versionId,
        publicConfigValid: true,
        credentialFormatValid: true,
        bindingsValid: true,
        checkedAt: NOW.toISOString(),
      }),
    ),
    buildBrowserInstruction: input => ({
      schemaVersion: 1,
      deliveryId: input.deliveryId,
      provider: input.provider,
      canonicalEvent: input.canonicalEvent,
      eventName: input.canonicalEvent,
      destination: input.destination,
      externalEventId: input.externalEventId,
      receiptToken: input.receiptToken,
      payload: {},
    }),
    deliverServerEvent: vi.fn(
      async (_input: ServerDeliveryInput) => ({
        provider: 'meta',
        classification: 'accepted',
      }),
    ),
    readQualitySignal: vi.fn(),
    ...overrides,
  }
}

async function seedConnection() {
  const commands = createAttributionConnectionCommands({
    db,
    credentialKeys: CREDENTIAL_KEYS,
    now: () => NOW,
    idFactory: prefix => `${prefix}_seed_${++idSequence}`,
  })
  await commands.createConnection({
    id: 'conn_meta',
    provider: 'meta',
    name: 'Meta validation',
    isDefault: true,
    idempotencyKey: 'create_conn_meta',
    actorId: 1,
  })
  const oldActive = await commands.createCandidate(
    candidate('pixel-old', 'candidate_old'),
  )
  await commands.beginCandidateValidation({
    connectionId: 'conn_meta',
    candidateId: oldActive.id,
    idempotencyKey: 'begin_old',
    actorId: 1,
  })
  await commands.markCandidateReady({
    connectionId: 'conn_meta',
    candidateId: oldActive.id,
    idempotencyKey: 'ready_old',
    actorId: 1,
  })
  await commands.activateCandidate({
    connectionId: 'conn_meta',
    candidateId: oldActive.id,
    expectedBaseActiveVersionId: null,
    idempotencyKey: 'activate_old',
    actorId: 1,
  })
  const next = await commands.createCandidate(
    candidate('pixel-next', 'candidate_next'),
  )
  return { oldActiveId: oldActive.id, candidateId: next.id }
}

function candidate(
  pixelId: string,
  idempotencyKey: string,
): CreateCandidateInput {
  return {
    connectionId: 'conn_meta',
    publicConfig: { pixelId },
    bindings: [
      {
        canonicalEvent: 'Contact',
        enabled: true,
        browserDestination: 'meta_pixel',
        serverDestination: 'meta_capi',
      },
      {
        canonicalEvent: 'CompleteRegistration',
        enabled: true,
        browserDestination: 'meta_pixel',
        serverDestination: 'meta_capi',
      },
    ],
    credential: `token-${pixelId}`,
    idempotencyKey,
    actorId: 1,
  }
}

async function activeVersionId() {
  const row = await db.prepare(`
    SELECT active_version_id
    FROM attribution_connections
    WHERE id = 'conn_meta'
  `).first<{ active_version_id: string | null }>()
  return row?.active_version_id ?? null
}

async function policy() {
  return db.prepare(`
    SELECT
      enabled, browser_enabled, server_enabled,
      server_target_percentage, server_effective_percentage,
      circuit_state, runtime_generation
    FROM attribution_runtime_policies
    WHERE connection_id = 'conn_meta'
  `).first()
}

async function versionStatus(versionId: string) {
  return db.prepare(`
    SELECT status, failure_code
    FROM attribution_connection_versions
    WHERE id = ?
  `).bind(versionId).first()
}

async function validation(validationId: string) {
  return db.prepare(`
    SELECT status, failure_code, evidence_json
    FROM attribution_validations
    WHERE id = ?
  `).bind(validationId).first()
}

async function validationSecret(validationId: string) {
  return db.prepare(`
    SELECT validation_id
    FROM attribution_validation_secrets
    WHERE validation_id = ?
  `).bind(validationId).first()
}

async function syntheticCount(versionId: string) {
  const row = await db.prepare(`
    SELECT
      COUNT(DISTINCT fact.id) AS facts,
      SUM(CASE WHEN delivery.transport = 'browser' THEN 1 ELSE 0 END)
        AS browser,
      SUM(CASE WHEN delivery.transport = 'server' THEN 1 ELSE 0 END)
        AS server
    FROM attribution_facts AS fact
    INNER JOIN attribution_deliveries AS delivery
      ON delivery.fact_id = fact.id
    WHERE fact.version_id = ?
      AND fact.fact_origin = 'synthetic'
  `).bind(versionId).first<{
    facts: number
    browser: number
    server: number
  }>()
  return {
    facts: Number(row?.facts ?? 0),
    browser: Number(row?.browser ?? 0),
    server: Number(row?.server ?? 0),
  }
}

async function auditRows() {
  return (await db.prepare(`
    SELECT command_type, detail_json
    FROM attribution_audit_logs
    ORDER BY created_at
  `).all()).results
}

async function scalar(sql: string) {
  const row = await db.prepare(sql).first<{ value: number }>()
  return Number(row?.value ?? 0)
}
