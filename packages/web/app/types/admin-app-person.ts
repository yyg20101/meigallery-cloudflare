export type PersonWorkflowGate = {
  code: string
  label: string
  passed: boolean
  detail: string
}

export type AdminAuthorizationRecord = {
  id: string
  profileVersion: number
  storedStatus: string
  effectiveStatus: string
  purpose: string
  evidenceRef: string
  validFrom: string
  validUntil: string | null
  reasonCode: string | null
  note: string | null
  createdAt: string
  reviewedAt: string
  revokedAt: string | null
}

export type AdminVerificationRecord = {
  id: string
  profileVersion: number
  storedStatus: string
  effectiveStatus: string
  evidenceRef: string
  verificationItems: string[]
  policyVersion: string
  validUntil: string | null
  reasonCode: string | null
  note: string | null
  submittedAt: string
  reviewedAt: string | null
  revokedAt: string | null
}

export type AdminPublicationRecord = {
  id: string
  profileVersion: number
  status: string
  reasonCode: string | null
  note: string | null
  projectionVersion: number | null
  submittedAt: string
  reviewedAt: string | null
}

export type AdminPersonDetail = {
  personId: string
  profileId: string
  lifecycleStatus: string
  sourceGallery: { id: string; title: string; status: string; hasCover: boolean }
  displayName: string
  summary: string | null
  tags: string[]
  operation: { mode: string; label: string }
  region: { code: string; label: string; precision: string } | null
  recommendation: { score: number; heatScore: number; reasonCode: string }
  verificationStatus: string
  publicationStatus: string
  authorizationStatus: string
  safetyStatus: string
  contentVersion: number
  liveContentVersion: number | null
  lockVersion: number
  liveProjection: {
    visible: boolean
    publicationStatus: string
    visibilityStatus: string
    projectionVersion: number
    profileVersion: number | null
    authorizationId: string | null
    verificationId: string | null
    publicationId: string | null
  } | null
  gates: PersonWorkflowGate[]
  currentAuthorization: AdminAuthorizationRecord | null
  currentVerification: AdminVerificationRecord | null
  history: {
    authorizations: AdminAuthorizationRecord[]
    verifications: AdminVerificationRecord[]
    publications: AdminPublicationRecord[]
  }
  createdAt: string
  updatedAt: string
}

export type AdminPersonListItem = {
  personId: string
  profileId: string
  displayName: string
  sourceGalleryTitle: string
  verificationStatus: string
  authorizationStatus: string
  publicationStatus: string
  contentVersion: number
  liveContentVersion: number | null
  lockVersion: number
  liveVisible: boolean
  updatedAt: string
}

export type AdminPersonListResponse = {
  data: AdminPersonListItem[]
  pagination: { page: number; pageSize: number; total: number; totalPages: number }
}

export const PERSON_STATUS_LABELS: Record<string, string> = {
  unverified: '未认证',
  pending: '待复核',
  verified: '认证有效',
  rejected: '已退回',
  expired: '已过期',
  revoked: '已撤销',
  missing: '未登记',
  active: '有效',
  draft: '草稿',
  pending_review: '待发布复核',
  published: '已发布',
  suspended: '已暂停',
  archived: '已归档',
}

export const VERIFICATION_ITEM_LABELS: Record<string, string> = {
  identity_existence: '身份与真实存在检查',
  authorization_agency: '用途授权或代理关系检查',
  profile_consistency: '资料一致性检查',
  media_rights: '媒体版权与使用范围检查',
}

export function personStatusClass(status: string) {
  if (['verified', 'active', 'published'].includes(status)) return 'bg-emerald-50 text-emerald-700 ring-emerald-200'
  if (['pending', 'pending_review'].includes(status)) return 'bg-amber-50 text-amber-700 ring-amber-200'
  if (['rejected', 'revoked', 'expired', 'suspended'].includes(status)) return 'bg-red-50 text-red-700 ring-red-200'
  return 'bg-gray-100 text-gray-700 ring-gray-200'
}

export function formatAdminDate(value: string | null | undefined) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isFinite(date.getTime())
    ? date.toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })
    : value
}
