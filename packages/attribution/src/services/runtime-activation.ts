import { ATTRIBUTION_SERVICE_BINDING } from '@meigallery/shared/constants'
import {
  readAttributionRuntimeState,
  type AttributionRuntimeState,
} from './runtime-state'

export interface AttributionRuntimeWriteOwnership {
  owner: 'draining' | 'new'
  epoch: number
}

export interface AttributionRuntimeDispatchOwnership {
  owner: 'draining' | 'new' | 'synthetic'
  epoch: number
}

export async function readSyntheticRuntimeDispatchOwnership(
  db: D1Database,
): Promise<AttributionRuntimeDispatchOwnership> {
  const state = await readAttributionRuntimeState(db)
  if (state.mode === 'shadow') {
    return { owner: 'synthetic', epoch: 2 }
  }
  if (state.mode === 'bridge' && state.bridgeOwnerEpoch !== null) {
    return {
      owner: 'synthetic',
      epoch: state.bridgeOwnerEpoch,
    }
  }
  if (state.mode === 'active' && state.activeOwnerEpoch !== null) {
    return {
      owner: 'synthetic',
      epoch: state.activeOwnerEpoch,
    }
  }
  throw new Error('ATTRIBUTION_RUNTIME_WRITE_OWNERSHIP_REJECTED')
}

export async function assertAttributionRuntimeWriteOwnership(
  db: D1Database,
  ownership: AttributionRuntimeWriteOwnership,
): Promise<AttributionRuntimeState> {
  validateOwnership(ownership)
  const state = await readAttributionRuntimeState(db)

  const bridgeAccepted = ownership.owner === 'draining'
    && state.bridgeOwnerEpoch === ownership.epoch
    && (state.mode === 'bridge' || state.mode === 'active')
  const activeAccepted = ownership.owner === 'new'
    && state.mode === 'active'
    && state.activeOwnerEpoch === ownership.epoch
  if (!bridgeAccepted && !activeAccepted) {
    throw new Error('ATTRIBUTION_RUNTIME_WRITE_OWNERSHIP_REJECTED')
  }
  return state
}

export async function assertAttributionRuntimeBridgeReadable(
  db: D1Database,
): Promise<AttributionRuntimeState> {
  const state = await readAttributionRuntimeState(db)
  if (state.mode !== 'bridge' && state.mode !== 'active') {
    throw new Error('ATTRIBUTION_RUNTIME_BRIDGE_NOT_READY')
  }
  return state
}

export function readAttributionRuntimeWriteOwnership(
  request: Request,
): AttributionRuntimeWriteOwnership {
  const owner = request.headers.get(
    ATTRIBUTION_SERVICE_BINDING.HEADERS.RUNTIME_OWNER,
  )
  const epochValue = request.headers.get(
    ATTRIBUTION_SERVICE_BINDING.HEADERS.RUNTIME_EPOCH,
  )
  const epoch = Number(epochValue)
  if (
    (owner !== 'draining' && owner !== 'new')
    || !Number.isSafeInteger(epoch)
    || epoch < 2
  ) {
    throw new Error('ATTRIBUTION_RUNTIME_WRITE_OWNERSHIP_INVALID')
  }
  return { owner, epoch }
}

function validateOwnership(
  ownership: AttributionRuntimeWriteOwnership,
): void {
  if (
    (ownership.owner !== 'draining' && ownership.owner !== 'new')
    || !Number.isSafeInteger(ownership.epoch)
    || ownership.epoch < 2
  ) {
    throw new Error('ATTRIBUTION_RUNTIME_WRITE_OWNERSHIP_INVALID')
  }
}
