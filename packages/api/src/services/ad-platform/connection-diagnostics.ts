import type { AdAttributionProvider } from '@meigallery/shared'
import type { PlatformConnectionServiceEnv } from './connection-service'
import { readAttributionConnectionSnapshot } from './connections'
import { readAttributionCredential } from './credential-vault'
import {
  getPlatformConnectionTestAdapter,
  PlatformConnectionTestError,
} from './connection-test-adapter'

export interface PlatformConnectionDiagnostic {
  provider: AdAttributionProvider
  ok: true
  testedAt: string
  testEventsSent: number
  externalEventIds: string[]
  requestIds: string[]
}

type DiagnosticEnv = PlatformConnectionServiceEnv & { SITE_URL?: string }

export async function testPlatformConnection(
  env: DiagnosticEnv,
  input: { provider: AdAttributionProvider; testEventCode?: string },
): Promise<PlatformConnectionDiagnostic> {
  const adapter = getPlatformConnectionTestAdapter(input.provider)
  if (!adapter) throw new PlatformConnectionTestError('AD_PLATFORM_CONNECTION_TEST_INPUT_INVALID')
  const testEventCode = adapter.normalizeTestEventCode(input.testEventCode)
  if (testEventCode === null) {
    throw new PlatformConnectionTestError(input.testEventCode
      ? 'AD_PLATFORM_CONNECTION_TEST_INPUT_INVALID'
      : 'AD_PLATFORM_CONNECTION_TEST_CODE_REQUIRED')
  }

  const snapshot = await readAttributionConnectionSnapshot(env.DB, input.provider)
  if (snapshot.state !== 'ready') throw new Error('AD_PLATFORM_CONNECTION_INVALID')
  const credential = await readAttributionCredential(env, {
    connectionId: snapshot.connection.id,
    provider: input.provider,
    credentialType: snapshot.credential.type,
    encryptionContext: snapshot.credential.encryptionContext,
  })
  const diagnosticId = await deterministicDiagnosticId(
    input.provider,
    snapshot.connection.outboxScope,
    snapshot.credential.encryptionContext,
    testEventCode,
  )
  const evidence = await adapter.test({
    testId: diagnosticId,
    provider: input.provider,
    publicConfig: snapshot.connection.publicConfig,
    eventBindings: [...snapshot.bindings.entries()].map(([canonicalEvent, binding]) => ({
      canonicalEvent,
      ...binding,
    })),
    credential,
    testEventCode,
    siteUrl: String(env.SITE_URL || ''),
  })
  return {
    provider: input.provider,
    ok: true,
    testedAt: evidence.checkedAt,
    testEventsSent: evidence.testEventsSent,
    externalEventIds: evidence.externalEventIds,
    requestIds: evidence.requestIds,
  }
}

async function deterministicDiagnosticId(
  provider: AdAttributionProvider,
  outboxScope: string,
  encryptionContext: string,
  testEventCode: string | undefined,
) {
  const digest = new Uint8Array(await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode([provider, outboxScope, encryptionContext, testEventCode || ''].join('\0')),
  ))
  return `diag_${provider}_${Array.from(digest.slice(0, 16), byte => byte.toString(16).padStart(2, '0')).join('')}`
}
