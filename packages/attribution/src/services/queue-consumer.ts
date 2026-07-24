import type { AttributionProvider } from '@meigallery/shared'
import { getProviderAdapter } from '../adapters/registry'
import { AttributionDomainError } from '../domain/errors'
import type { AttributionQueueMessage } from '../domain/queue'
import { openServerCircuitForFailure } from './circuit-breaker'
import { openCredential } from './credential-vault'
import {
  assertPayloadMatchesSnapshot,
  hashedEmail,
  isIdentifier,
  isQueueMessage,
  openValidationTestEventCode,
  openServerPayload,
  outboxExpired,
  pageUrl,
  retryDelay,
  timestamp,
  trustedNow,
} from './queue-contract'
import {
  cancelForRuntimePolicy,
  claimDelivery,
  deleteResidualOutbox,
  markDeadLetter,
  parkForOpenCircuit,
  persistRetryableResult,
  persistTerminalResult,
  reconcileTerminalCircuit,
  recordQueueIncident,
  rejectLocally,
} from './queue-repository'
import {
  providerConsistent,
  readDeliveryHeader,
  readDeliverySnapshot,
} from './queue-snapshot'
import type {
  AttributionQueueConsumerEnvironment,
  AttributionQueueConsumerResult,
  DeliveryHeader,
  DeliverySnapshot,
} from './queue-types'
import { physicalQueue } from './secure-outbox'
import { isServerRolloutEligible } from './server-rollout'

export type {
  AttributionQueueConsumerEnvironment,
  AttributionQueueConsumerResult,
} from './queue-types'

type ItemOutcome = keyof AttributionQueueConsumerResult

const TERMINAL_STATUSES = new Set([
  'accepted',
  'processed',
  'rejected',
  'cancelled',
])
const PROCESSING_LEASE_MS = 5 * 60 * 1_000

export async function consumeAttributionQueue(
  batch: MessageBatch<AttributionQueueMessage>,
  environment: AttributionQueueConsumerEnvironment,
): Promise<AttributionQueueConsumerResult> {
  const result: AttributionQueueConsumerResult = {
    accepted: 0,
    retried: 0,
    rejected: 0,
    deadLettered: 0,
    skipped: 0,
  }
  const queue = physicalQueue(
    batch.queue,
    environment.appEnvironment,
  )
  if (!queue) {
    for (const message of batch.messages) {
      message.retry({ delaySeconds: 300 })
      result.retried += 1
    }
    return result
  }

  for (const message of batch.messages) {
    try {
      const outcome = queue.deadLetter
        ? await consumeDeadLetter(message, queue.provider, environment)
        : await consumePrimary(message, queue.provider, environment)
      result[outcome] += 1
    } catch {
      message.retry({
        delaySeconds: retryDelay(message.attempts),
      })
      result.retried += 1
    }
  }
  return result
}

async function consumePrimary(
  message: Message<AttributionQueueMessage>,
  physicalProvider: AttributionProvider,
  environment: AttributionQueueConsumerEnvironment,
): Promise<ItemOutcome> {
  if (!isQueueMessage(message.body)) {
    return ackInvalidMessage(
      message,
      physicalProvider,
      environment,
    )
  }
  if (message.body.provider !== physicalProvider) {
    const header = await readDeliveryHeader(
      environment.db,
      message.body.deliveryId,
    )
    return ackProviderMismatch(
      message,
      physicalProvider,
      header,
      environment,
    )
  }

  const header = await readDeliveryHeader(
    environment.db,
    message.body.deliveryId,
  )
  if (!header) {
    await recordQueueIncident(environment, {
      provider: physicalProvider,
      connectionId: null,
      code: 'queue_delivery_not_found',
    })
    message.ack()
    return 'skipped'
  }
  if (header.provider !== physicalProvider) {
    return ackProviderMismatch(
      message,
      physicalProvider,
      header,
      environment,
    )
  }
  if (TERMINAL_STATUSES.has(header.status)) {
    await finishTerminalDuplicate(message, header, environment)
    return 'skipped'
  }
  if (header.status === 'dead_letter') {
    message.ack()
    return 'skipped'
  }

  const row = await readDeliverySnapshot(
    environment.db,
    message.body.deliveryId,
  )
  if (!row) {
    await recordQueueIncident(environment, {
      provider: physicalProvider,
      connectionId: header.connectionId,
      code: 'queue_state_invalid',
    })
    message.ack()
    return 'skipped'
  }
  if (!providerConsistent(row, physicalProvider)) {
    return ackProviderMismatch(
      message,
      physicalProvider,
      header,
      environment,
    )
  }
  if (!row.bindingValid) {
    return rejectAndOpenCircuit(
      message,
      row,
      environment,
      'binding_state_invalid',
    )
  }
  if (row.factOrigin === 'synthetic' && !row.candidateValidationValid) {
    return rejectAndOpenCircuit(
      message,
      row,
      environment,
      'candidate_validation_state_invalid',
    )
  }
  if (
    row.factOrigin === 'live'
    && row.circuitState === 'server_open'
  ) {
    await parkForOpenCircuit(
      environment.db,
      row,
      trustedNow(environment.now),
    )
    message.ack()
    return 'skipped'
  }
  if (
    row.factOrigin === 'live'
    && !await runtimeAllowsDelivery(row)
  ) {
    await cancelForRuntimePolicy(
      environment.db,
      row,
      trustedNow(environment.now),
    )
    message.ack()
    return 'skipped'
  }
  if (
    outboxExpired(
      row.outboxExpiresAt,
      trustedNow(environment.now),
    )
  ) {
    await rejectLocally(
      environment,
      row,
      'outbox_expired',
      undefined,
      row.factOrigin === 'live',
    )
    message.ack()
    return 'rejected'
  }

  if (
    environment.appEnvironment !== 'production'
    && !environment.adapterFor
  ) {
    return rejectAndOpenCircuit(
      message,
      row,
      environment,
      'nonproduction_real_adapter_forbidden',
    )
  }

  const attempt = await claimForDelivery(message, row, environment)
  if (attempt === null) return 'retried'

  let payload
  let credential: string
  let testEventCode: string | undefined
  try {
    payload = await openServerPayload(
      environment.dataEncryptionKeys,
      row,
    )
    assertPayloadMatchesSnapshot(payload, row)
    credential = await openCredential(
      environment.credentialMasterKeys,
      {
        provider: row.provider,
        versionId: row.versionId,
        envelope: row.credentialEnvelope,
      },
    )
    testEventCode = await openValidationTestEventCode(
      environment.dataEncryptionKeys,
      row,
      trustedNow(environment.now),
    )
  } catch (error) {
    const code = error instanceof AttributionDomainError
      && error.code === 'ATTRIBUTION_CREDENTIAL_AAD_MISMATCH'
      ? 'credential_integrity_invalid'
      : 'outbox_integrity_invalid'
    return rejectAndOpenCircuit(
      message,
      row,
      environment,
      code,
      attempt,
    )
  }

  const adapter = (environment.adapterFor ?? getProviderAdapter)(
    row.provider,
  )
  if (adapter.provider !== row.provider) {
    return rejectAndOpenCircuit(
      message,
      row,
      environment,
      'adapter_provider_mismatch',
      attempt,
    )
  }

  let providerResult
  try {
    providerResult = await adapter.deliverServerEvent({
      provider: row.provider,
      connectionId: row.connectionId,
      versionId: row.versionId,
      deliveryId: row.deliveryId,
      canonicalEvent: row.eventName,
      externalEventId: row.externalEventId,
      occurredAt: payload.occurredAt,
      pageUrl: pageUrl(
        environment.publicOrigins,
        payload.pagePath,
        environment.appEnvironment,
      ),
      destination: row.destination,
      publicConfig: row.publicConfig,
      credential,
      identifiers: payload.context.identifiers,
      contextIssuedAt: payload.context.issuedAt,
      ...hashedEmail(payload),
      ...payload.requestMetadata,
      consent: payload.consent,
      validateOnly: row.factOrigin === 'synthetic',
      ...(testEventCode ? { testEventCode } : {}),
    })
  } catch (error) {
    if (error instanceof AttributionDomainError) {
      return rejectAndOpenCircuit(
        message,
        row,
        environment,
        'adapter_input_invalid',
        attempt,
      )
    }
    await retryProviderDelivery(
      message,
      row,
      attempt,
      environment,
    )
    return 'retried'
  }

  if (providerResult.provider !== row.provider) {
    return rejectAndOpenCircuit(
      message,
      row,
      environment,
      'adapter_provider_mismatch',
      attempt,
    )
  }
  if (
    providerResult.classification === 'accepted'
    || providerResult.classification === 'processed'
  ) {
    await persistTerminalResult(
      environment,
      row,
      attempt,
      providerResult,
      providerResult.classification,
      '',
    )
    await reconcileTerminalCircuit(environment, {
      deliveryId: row.deliveryId,
      connectionId: row.connectionId,
      provider: row.provider,
      status: providerResult.classification,
      factOrigin: row.factOrigin,
    })
    message.ack()
    return 'accepted'
  }
  if (providerResult.classification === 'retryable') {
    const opened = await persistRetryableResult(
      environment,
      row,
      attempt,
      {
        ...providerResult,
        classification: 'retryable',
      },
      row.factOrigin === 'live',
    )
    if (opened) {
      message.ack()
    } else {
      message.retry({ delaySeconds: retryDelay(attempt) })
    }
    return 'retried'
  }

  const code = `provider_${providerResult.classification}`
  await persistTerminalResult(
    environment,
    row,
    attempt,
    providerResult,
    'rejected',
    code,
  )
  if (
    row.factOrigin === 'live'
    && (
    providerResult.classification === 'credential_invalid'
    || providerResult.classification === 'destination_invalid'
    )
  ) {
    await openServerCircuitForFailure(environment, {
      connectionId: row.connectionId,
      provider: row.provider,
      code,
    })
  }
  message.ack()
  return 'rejected'
}

async function consumeDeadLetter(
  message: Message<AttributionQueueMessage>,
  physicalProvider: AttributionProvider,
  environment: AttributionQueueConsumerEnvironment,
): Promise<ItemOutcome> {
  if (
    !isQueueMessage(message.body)
    || message.body.provider !== physicalProvider
  ) {
    return ackProviderMismatch(
      message,
      physicalProvider,
      null,
      environment,
    )
  }
  const header = await readDeliveryHeader(
    environment.db,
    message.body.deliveryId,
  )
  if (!header || header.provider !== physicalProvider) {
    return ackProviderMismatch(
      message,
      physicalProvider,
      header,
      environment,
    )
  }
  if (TERMINAL_STATUSES.has(header.status)) {
    await finishTerminalDuplicate(message, header, environment)
    return 'skipped'
  }
  const row = await readDeliverySnapshot(
    environment.db,
    message.body.deliveryId,
  )
  if (!row || !providerConsistent(row, physicalProvider)) {
    if (row) {
      return ackProviderMismatch(
        message,
        physicalProvider,
        header,
        environment,
      )
    }
    await recordQueueIncident(environment, {
      provider: physicalProvider,
      connectionId: header.connectionId,
      code: 'queue_state_invalid',
    })
    message.ack()
    return 'skipped'
  }
  await markDeadLetter(
    environment,
    row,
    row.factOrigin === 'live',
  )
  message.ack()
  return 'deadLettered'
}

async function runtimeAllowsDelivery(
  row: DeliverySnapshot,
): Promise<boolean> {
  return row.runtimeEnabled
    && row.serverEnabled
    && await isServerRolloutEligible({
      provider: row.provider,
      connectionId: row.connectionId,
      versionId: row.versionId,
      externalEventId: row.externalEventId,
      effectivePercentage: row.serverEffectivePercentage,
    })
}

async function claimForDelivery(
  message: Message<AttributionQueueMessage>,
  row: DeliverySnapshot,
  environment: AttributionQueueConsumerEnvironment,
): Promise<number | null> {
  const now = trustedNow(environment.now)
  if (
    row.status === 'retrying'
    && row.lastErrorCode === 'processing'
    && timestamp(row.updatedAt) > now.getTime() - PROCESSING_LEASE_MS
  ) {
    message.retry({ delaySeconds: 60 })
    return null
  }
  const attempt = await claimDelivery(environment.db, row, now)
  if (attempt !== null) return attempt
  const latest = await readDeliveryHeader(
    environment.db,
    row.deliveryId,
  )
  if (latest && TERMINAL_STATUSES.has(latest.status)) {
    await finishTerminalDuplicate(message, latest, environment)
  } else {
    message.retry({ delaySeconds: 60 })
  }
  return null
}

async function retryProviderDelivery(
  message: Message<AttributionQueueMessage>,
  row: DeliverySnapshot,
  attempt: number,
  environment: AttributionQueueConsumerEnvironment,
): Promise<void> {
  const opened = await persistRetryableResult(
    environment,
    row,
    attempt,
    {
      provider: row.provider,
      classification: 'retryable',
    },
    row.factOrigin === 'live',
  )
  if (opened) {
    message.ack()
  } else {
    message.retry({ delaySeconds: retryDelay(attempt) })
  }
}

async function rejectAndOpenCircuit(
  message: Message<AttributionQueueMessage>,
  row: DeliverySnapshot,
  environment: AttributionQueueConsumerEnvironment,
  code: string,
  attempt?: number,
): Promise<'rejected'> {
  await rejectLocally(
    environment,
    row,
    code,
    attempt,
    row.factOrigin === 'live',
  )
  if (row.factOrigin === 'live') {
    await openServerCircuitForFailure(environment, {
      connectionId: row.connectionId,
      provider: row.provider,
      code,
    })
  }
  message.ack()
  return 'rejected'
}

async function finishTerminalDuplicate(
  message: Message<AttributionQueueMessage>,
  header: DeliveryHeader,
  environment: AttributionQueueConsumerEnvironment,
): Promise<void> {
  await deleteResidualOutbox(
    environment.db,
    header.deliveryId,
    header.provider,
  )
  await reconcileTerminalCircuit(environment, header)
  message.ack()
}

async function ackInvalidMessage(
  message: Message<AttributionQueueMessage>,
  provider: AttributionProvider,
  environment: AttributionQueueConsumerEnvironment,
): Promise<'skipped'> {
  await recordQueueIncident(environment, {
    provider,
    connectionId: null,
    code: 'queue_message_invalid',
  })
  message.ack()
  return 'skipped'
}

async function ackProviderMismatch(
  message: Message<AttributionQueueMessage>,
  provider: AttributionProvider,
  header: DeliveryHeader | null,
  environment: AttributionQueueConsumerEnvironment,
): Promise<'skipped'> {
  await recordQueueIncident(environment, {
    provider,
    connectionId: isIdentifier(header?.connectionId)
      ? header.connectionId
      : null,
    code: 'queue_provider_mismatch',
  })
  message.ack()
  return 'skipped'
}
