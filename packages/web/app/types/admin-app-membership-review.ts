export type AdminMembershipReviewStatus =
  | 'pending_review'
  | 'executing'
  | 'approved'
  | 'rejected'
  | 'stale'
  | 'cancelled'

export type AdminMembershipRiskCode =
  | 'POLICY_UNRESOLVED_ALL_REVIEW'
  | 'POLICY_REVIEW_ALL'
  | 'RANK_THRESHOLD'
  | 'DURATION_THRESHOLD'
  | 'LOWER_THAN_CURRENT_TIER'
  | 'REVOCATION'

export interface AdminMembershipReviewRequest {
  requestId: string
  operation: 'grant' | 'revoke'
  account: {
    userId: number
    accountId: string | null
    emailMasked: string
    status: string
  }
  grantChange: null | {
    action: 'grant' | 'renew'
    catalogVersionId: string
    tierId: string
    tierCode: string
    tierName: string
    rank: number
    startsAt: string
    expiresAt: string
    durationDays: number
  }
  revokeTarget: null | {
    grantId: string
    tierName: string
    rank: number
    startsAt: string
    expiresAt: string
    revoked: boolean
  }
  reasonCode: string
  userVisibleNote: string
  internalNote: string | null
  businessReference: string
  source: {
    type: 'direct_admin' | 'membership_application'
    applicationId: string | null
    applicationVersion: number | null
  }
  baseline: {
    grantId: string | null
    rank: number
    expiresAt: string | null
  }
  currentMembership: {
    status: 'free' | 'active'
    tier: null | { tierId: string; displayName: string; rank: number }
    grant: null | { grantId: string; startsAt: string; expiresAt: string; userVisibleNote: string }
  }
  policy: {
    policyId: string | null
    versionCode: string
    mode: 'conservative_review_all' | 'review_all' | 'risk_based'
    riskCodes: AdminMembershipRiskCode[]
  }
  status: AdminMembershipReviewStatus
  version: number
  requestedBy: { id: number; label: string }
  reviewedBy: { id: number; label: string } | null
  reviewNote: string | null
  resultGrantId: string | null
  createdAt: string
  updatedAt: string
  reviewedAt: string | null
  appliedAt: string | null
  canReview: boolean
}
