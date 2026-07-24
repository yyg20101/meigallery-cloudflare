export type AttributionDomainErrorCode =
  | 'ATTRIBUTION_CANDIDATE_INVALID'
  | 'ATTRIBUTION_CONNECTION_SNAPSHOT_INVALID'
  | 'ATTRIBUTION_CREDENTIAL_INVALID'
  | 'ATTRIBUTION_CREDENTIAL_AAD_MISMATCH'
  | 'ATTRIBUTION_CREDENTIAL_RETENTION_STATE_INVALID'

export class AttributionDomainError extends Error {
  readonly code: AttributionDomainErrorCode

  constructor(code: AttributionDomainErrorCode) {
    super(code)
    this.name = 'AttributionDomainError'
    this.code = code
  }
}
