export const TAXONOMY_TYPES = [
  'region_scope',
  'region_group',
  'city_country',
  'identity',
  'personality',
  'style',
  'occupation',
  'hair',
  'clothing',
  'scene',
  'content_type',
] as const

export type TaxonomyType = typeof TAXONOMY_TYPES[number]
export type TaxonomyTermStatus =
  | 'draft'
  | 'pending_review'
  | 'active'
  | 'hidden'
  | 'deprecated'
  | 'merged'
  | 'archived'
export type TaxonomyTermVisibility = 'public' | 'internal'
export type TaxonomyTermSensitivity = 'standard' | 'restricted'
export type TaxonomyCatalogState = 'development' | 'published' | 'retired'
export type TaxonomyPublicState = 'active' | 'deprecated' | 'redirect'
export type TaxonomyLegacyMappingType =
  | 'exact'
  | 'alias'
  | 'split_required'
  | 'unsupported'
  | 'pending_review'

export type TaxonomyPagination = {
  page: number
  pageSize: number
  total: number
  totalPages: number
}

export type TaxonomyTerm = {
  termId: string
  type: TaxonomyType
  parentTermId: string | null
  displayName: string
  slug: string
  description: string | null
  aliases: string[]
  lifecycleStatus: TaxonomyTermStatus
  visibility: TaxonomyTermVisibility
  allowedForProfile: boolean
  sensitivity: TaxonomyTermSensitivity
  mergeTargetTermId: string | null
  sortOrder: number
  version: number
  createdBy: number
  updatedBy: number
  createdAt: string
  updatedAt: string
}

export type TaxonomyTermRevision = {
  version: number
  lifecycleStatus: TaxonomyTermStatus
  changeReason: string
  changedBy: number
  createdAt: string
}

export type TaxonomyTermCatalogReference = {
  catalogVersionId: string
  versionCode: string
  state: TaxonomyCatalogState
  publicState: TaxonomyPublicState
  termVersion: number
}

export type TaxonomyTermDetail = TaxonomyTerm & {
  revisions: TaxonomyTermRevision[]
  catalogs: TaxonomyTermCatalogReference[]
}

export type TaxonomyCatalog = {
  catalogVersionId: string
  versionCode: string
  state: TaxonomyCatalogState
  productionReady: boolean
  effectiveAt: string
  minimumClientVersion: string
  itemCount: number
  lockVersion: number
  createdBy: number | null
  publishedBy: number | null
  createdAt: string
  publishedAt: string | null
}

export type TaxonomyCatalogItem = {
  termId: string
  termVersion: number
  type: TaxonomyType
  parentTermId: string | null
  displayName: string
  slug: string
  aliases: string[]
  publicState: TaxonomyPublicState
  redirectTargetTermId: string | null
  visibility: TaxonomyTermVisibility
  allowedForProfile: boolean
  sensitivity: TaxonomyTermSensitivity
  sortOrder: number
}

export type TaxonomyCatalogDetail = TaxonomyCatalog & {
  items: TaxonomyCatalogItem[]
}

export type TaxonomyLegacyMapping = {
  mappingId: string
  sourceNamespace: string
  sourceType: string
  sourceValue: string
  sourceNormalizedValue: string
  mappingType: TaxonomyLegacyMappingType
  targetTermId: string | null
  mappingRuleVersion: string
  note: string | null
  version: number
  updatedBy: number
  createdAt: string
  updatedAt: string
}

export const TAXONOMY_TYPE_LABELS: Record<TaxonomyType, string> = {
  region_scope: '地区范围',
  region_group: '地区组',
  city_country: '城市 / 国家',
  identity: '身份',
  personality: '性格',
  style: '风格',
  occupation: '职业',
  hair: '发型',
  clothing: '服饰',
  scene: '场景',
  content_type: '内容类型',
}

export const TAXONOMY_STATUS_LABELS: Record<TaxonomyTermStatus, string> = {
  draft: '草稿',
  pending_review: '待复核',
  active: '已生效',
  hidden: '已隐藏',
  deprecated: '已弃用',
  merged: '已合并',
  archived: '已归档',
}

export const TAXONOMY_CATALOG_STATE_LABELS: Record<TaxonomyCatalogState, string> = {
  development: '开发快照',
  published: '已发布',
  retired: '已退役',
}

export const TAXONOMY_PUBLIC_STATE_LABELS: Record<TaxonomyPublicState, string> = {
  active: '公开生效',
  deprecated: '公开弃用',
  redirect: '稳定重定向',
}

export const TAXONOMY_MAPPING_TYPE_LABELS: Record<TaxonomyLegacyMappingType, string> = {
  exact: '精确映射',
  alias: '别名映射',
  split_required: '需要拆分',
  unsupported: '不支持迁移',
  pending_review: '待人工判断',
}

export function taxonomyStatusClass(status: string) {
  if (status === 'active' || status === 'published') return 'bg-emerald-50 text-emerald-700 ring-emerald-200'
  if (status === 'pending_review' || status === 'development') return 'bg-amber-50 text-amber-800 ring-amber-200'
  if (status === 'hidden' || status === 'deprecated' || status === 'redirect') return 'bg-orange-50 text-orange-800 ring-orange-200'
  if (status === 'merged') return 'bg-blue-50 text-blue-700 ring-blue-200'
  if (status === 'archived' || status === 'retired') return 'bg-gray-100 text-gray-600 ring-gray-200'
  return 'bg-gray-50 text-gray-700 ring-gray-200'
}

export function formatTaxonomyDate(value: string | null | undefined) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isFinite(date.getTime())
    ? date.toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })
    : value
}

export function taxonomyApiError(error: unknown, fallback: string) {
  if (!error || typeof error !== 'object') return fallback
  const candidate = error as { data?: unknown; message?: unknown }
  const body = parseTaxonomyErrorBody(candidate.data)
  if (body?.message) return body.message
  if (typeof candidate.message === 'string' && candidate.message.length < 180) return candidate.message
  return fallback
}

export function taxonomyApiErrorDetail(error: unknown) {
  if (!error || typeof error !== 'object') return null
  return parseTaxonomyErrorBody((error as { data?: unknown }).data)?.detail ?? null
}

function parseTaxonomyErrorBody(value: unknown): { message?: string; detail?: unknown } | null {
  if (value && typeof value === 'object') return value as { message?: string; detail?: unknown }
  if (typeof value !== 'string') return null
  try {
    return JSON.parse(value) as { message?: string; detail?: unknown }
  }
  catch {
    return null
  }
}
