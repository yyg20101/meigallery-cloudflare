import type { Bindings } from '../../index'
import { getPlatformConnection, savePlatformConnection } from './connection-service'

export type WorkerSecretMigrationResult =
  | { status: 'already_completed' }
  | { status: 'source_unavailable' }
  | { status: 'migrated', data: Awaited<ReturnType<typeof savePlatformConnection>> }

/** 临时迁移器：只在生产发布窗口内将旧 Worker Secret 写入统一凭证库。 */
export async function migrateMetaWorkerSecret(
  env: Bindings,
  input: { pixelId: string, actorId: number },
): Promise<WorkerSecretMigrationResult> {
  if (await getPlatformConnection(env, 'meta')) return { status: 'already_completed' }
  const accessToken = String(env.META_CAPI_ACCESS_TOKEN || '').trim()
  if (!accessToken) return { status: 'source_unavailable' }

  const data = await savePlatformConnection(env, {
    provider: 'meta',
    enabled: true,
    mode: 'test',
    browserEnabled: true,
    serverEnabled: true,
    publicConfig: { provider: 'meta', pixelId: input.pixelId },
    eventBindings: [
      { canonicalEvent: 'Contact', enabled: true },
      { canonicalEvent: 'CompleteRegistration', enabled: true },
    ],
    credential: { type: 'access_token', plaintext: accessToken },
    rolloutTargetPercentage: 0,
    actorId: input.actorId,
  })
  return { status: 'migrated', data }
}
