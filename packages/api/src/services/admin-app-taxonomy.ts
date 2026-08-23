import type { AppTaxonomyType } from '@meigallery/shared'
import { generateId } from '../utils/db'
import { containsUnsafeInvisibleCharacter } from '../utils/text-safety'
import {
  AppTaxonomyError,
  isAppTaxonomyType,
  normalizeTaxonomyTermId,
} from './app-taxonomy'

const TERM_STATUSES = [
  'draft',
  'pending_review',
  'active',
  'hidden',
  'deprecated',
  'merged',
  'archived',
] as const

type TermStatus = typeof TERM_STATUSES[number]
type TermVisibility = 'public' | 'internal'
type TermSensitivity = 'standard' | 'restricted'

type TermRow = {
  term_id: string
  type: string
  parent_term_id: string | null
  display_name: string
  slug: string
  description: string | null
  aliases_json: string
  lifecycle_status: string
  visibility: string
  allowed_for_profile: number
  sensitivity: string
  merge_target_term_id: string | null
  sort_order: number
  version: number
  created_by: number
  updated_by: number
  created_at: string
  updated_at: string
}

type CatalogRow = {
  catalog_id: string
  version_code: string
  state: string
  production_ready: number
  effective_at: string
  minimum_client_version: string
  item_count: number
  lock_version: number
  created_by: number | null
  published_by: number | null
  created_at: string
  published_at: string | null
}

type LegacyMappingRow = {
  mapping_id: string
  source_namespace: string
  source_type: string
  source_value: string
  source_normalized_value: string
  mapping_type: string
  target_term_id: string | null
  mapping_rule_version: string
  note: string | null
  version: number
  updated_by: number
  created_at: string
  updated_at: string
}

export type CreateTaxonomyTermInput = {
  type: unknown
  parentTermId?: unknown
  displayName: unknown
  slug: unknown
  description?: unknown
  aliases?: unknown
  visibility?: unknown
  allowedForProfile?: unknown
  sensitivity?: unknown
  sortOrder?: unknown
  changeReason?: unknown
}

export type UpdateTaxonomyTermInput = Partial<CreateTaxonomyTermInput> & {
  expectedVersion: unknown
}

export type ReviewTaxonomyTermInput = {
  expectedVersion: unknown
  decision: unknown
  reason: unknown
}

export type MergeTaxonomyTermInput = {
  expectedVersion: unknown
  targetTermId: unknown
  reason: unknown
}

export type ChangeTaxonomyTermLifecycleInput = {
  expectedVersion: unknown
  action: unknown
  reason: unknown
}

export type CreateTaxonomyCatalogInput = {
  versionCode: unknown
  effectiveAt?: unknown
  minimumClientVersion?: unknown
}

export type PublishTaxonomyCatalogInput = {
  expectedVersion: unknown
  productionReady?: unknown
}

export type UpsertTaxonomyLegacyMappingInput = {
  sourceNamespace: unknown
  sourceType: unknown
  sourceValue: unknown
  mappingType: unknown
  targetTermId?: unknown
  mappingRuleVersion: unknown
  note?: unknown
  expectedVersion?: unknown
}

export async function listAdminTaxonomyTerms(
  db: D1Database,
  input: { type?: string; status?: string; q?: string; page?: string; pageSize?: string },
) {
  const page = positiveInteger(input.page, 1, 10_000)
  const pageSize = positiveInteger(input.pageSize, 30, 100)
  const type = input.type ? normalizeType(input.type) : null
  const status = input.status ? normalizeStatus(input.status) : null
  const q = optionalText(input.q, 80)
  const conditions: string[] = []
  const params: unknown[] = []
  if (type) {
    conditions.push('type = ?')
    params.push(type)
  }
  if (status) {
    conditions.push('lifecycle_status = ?')
    params.push(status)
  }
  if (q) {
    const like = `%${escapeLike(q)}%`
    conditions.push(`(
      display_name LIKE ? ESCAPE '\\'
      OR slug LIKE ? ESCAPE '\\'
      OR term_id LIKE ? ESCAPE '\\'
    )`)
    params.push(like, like, like)
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const [count, rows] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS count FROM app_taxonomy_terms ${where}`)
      .bind(...params).first<{ count: number }>(),
    db.prepare(`
      SELECT ${TERM_FIELDS}
      FROM app_taxonomy_terms
      ${where}
      ORDER BY type ASC, sort_order ASC, display_name COLLATE NOCASE ASC, term_id ASC
      LIMIT ? OFFSET ?
    `).bind(...params, pageSize, (page - 1) * pageSize).all<TermRow>(),
  ])
  const total = Number(count?.count ?? 0)
  return {
    data: rows.results.map(mapTerm),
    pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  }
}

export async function getAdminTaxonomyTerm(db: D1Database, termId: string) {
  const normalizedTermId = normalizeTaxonomyTermId(termId)
  const [row, revisions, catalogs] = await Promise.all([
    getTermRow(db, normalizedTermId),
    db.prepare(`
      SELECT version, lifecycle_status, change_reason, changed_by, created_at
      FROM app_taxonomy_term_revisions
      WHERE term_id = ?
      ORDER BY version DESC
      LIMIT 30
    `).bind(normalizedTermId).all<{
      version: number
      lifecycle_status: string
      change_reason: string
      changed_by: number
      created_at: string
    }>(),
    db.prepare(`
      SELECT c.catalog_id, c.version_code, c.state, i.public_state, i.term_version
      FROM app_taxonomy_catalog_items i
      JOIN app_taxonomy_catalogs c ON c.catalog_id = i.catalog_id
      WHERE i.term_id = ?
      ORDER BY c.created_at DESC
      LIMIT 30
    `).bind(normalizedTermId).all<{
      catalog_id: string
      version_code: string
      state: string
      public_state: string
      term_version: number
    }>(),
  ])
  if (!row) throw new AppTaxonomyError(404, 'TAXONOMY_TERM_NOT_FOUND', '分类词条不存在')
  return {
    ...mapTerm(row),
    revisions: revisions.results.map(item => ({
      version: item.version,
      lifecycleStatus: item.lifecycle_status,
      changeReason: item.change_reason,
      changedBy: item.changed_by,
      createdAt: item.created_at,
    })),
    catalogs: catalogs.results.map(item => ({
      catalogVersionId: item.catalog_id,
      versionCode: item.version_code,
      state: item.state,
      publicState: item.public_state,
      termVersion: item.term_version,
    })),
  }
}

export async function createAdminTaxonomyTerm(
  db: D1Database,
  input: CreateTaxonomyTermInput,
  adminId: number,
) {
  const term = await normalizeTermDraft(db, input)
  const termId = generateId('txt')
  const token = crypto.randomUUID()
  const now = new Date().toISOString()
  const changeReason = optionalText(input.changeReason, 120) ?? '创建分类词条草稿'
  await db.batch([
    db.prepare(`
      INSERT INTO app_taxonomy_terms (
        term_id, type, parent_term_id, display_name, slug, description,
        aliases_json, lifecycle_status, visibility, allowed_for_profile,
        sensitivity, merge_target_term_id, sort_order, version, mutation_token,
        created_by, updated_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, NULL, ?, 1, ?, ?, ?, ?, ?)
    `).bind(
      termId,
      term.type,
      term.parentTermId,
      term.displayName,
      term.slug,
      term.description,
      JSON.stringify(term.aliases),
      term.visibility,
      term.allowedForProfile ? 1 : 0,
      term.sensitivity,
      term.sortOrder,
      token,
      adminId,
      adminId,
      now,
      now,
    ),
    termRevisionForClaim(db, termId, token, adminId, changeReason, now),
    taxonomyAuditForClaim(db, {
      adminId,
      action: 'app_taxonomy.term_create',
      targetType: 'taxonomy_term',
      targetTable: 'app_taxonomy_terms',
      targetColumn: 'term_id',
      targetId: termId,
      token,
      after: { termId, type: term.type, displayName: term.displayName, lifecycleStatus: 'draft' },
      now,
    }),
  ])
  return getAdminTaxonomyTerm(db, termId)
}

export async function updateAdminTaxonomyTerm(
  db: D1Database,
  termId: string,
  input: UpdateTaxonomyTermInput,
  adminId: number,
) {
  const current = await requireEditableTerm(db, termId)
  const expectedVersion = expectedVersionValue(input.expectedVersion)
  assertVersion(current.version, expectedVersion)
  const term = await normalizeTermDraft(db, {
    type: input.type ?? current.type,
    parentTermId: input.parentTermId === undefined ? current.parent_term_id : input.parentTermId,
    displayName: input.displayName ?? current.display_name,
    slug: input.slug ?? current.slug,
    description: input.description === undefined ? current.description : input.description,
    aliases: input.aliases === undefined ? parseStringArray(current.aliases_json) : input.aliases,
    visibility: input.visibility ?? current.visibility,
    allowedForProfile: input.allowedForProfile === undefined
      ? current.allowed_for_profile === 1
      : input.allowedForProfile,
    sensitivity: input.sensitivity ?? current.sensitivity,
    sortOrder: input.sortOrder ?? current.sort_order,
  }, current.term_id)
  const changeReason = optionalText(input.changeReason, 120) ?? '更新分类词条草稿'
  const token = crypto.randomUUID()
  const now = new Date().toISOString()
  const results = await db.batch([
    db.prepare(`
      UPDATE app_taxonomy_terms
      SET type = ?, parent_term_id = ?, display_name = ?, slug = ?, description = ?,
          aliases_json = ?, lifecycle_status = 'draft', visibility = ?,
          allowed_for_profile = ?, sensitivity = ?, merge_target_term_id = NULL,
          sort_order = ?, version = version + 1, mutation_token = ?,
          updated_by = ?, updated_at = ?
      WHERE term_id = ? AND version = ? AND lifecycle_status NOT IN ('merged', 'archived')
    `).bind(
      term.type,
      term.parentTermId,
      term.displayName,
      term.slug,
      term.description,
      JSON.stringify(term.aliases),
      term.visibility,
      term.allowedForProfile ? 1 : 0,
      term.sensitivity,
      term.sortOrder,
      token,
      adminId,
      now,
      current.term_id,
      expectedVersion,
    ),
    termRevisionForClaim(db, current.term_id, token, adminId, changeReason, now),
    taxonomyAuditForClaim(db, {
      adminId,
      action: 'app_taxonomy.term_update',
      targetType: 'taxonomy_term',
      targetTable: 'app_taxonomy_terms',
      targetColumn: 'term_id',
      targetId: current.term_id,
      token,
      before: termAuditSnapshot(current),
      after: { ...term, lifecycleStatus: 'draft', version: expectedVersion + 1 },
      now,
    }),
  ])
  assertClaimed(results)
  return getAdminTaxonomyTerm(db, current.term_id)
}

export async function submitAdminTaxonomyTerm(
  db: D1Database,
  termId: string,
  expectedVersion: unknown,
  reason: unknown,
  adminId: number,
) {
  return transitionTerm(db, termId, expectedVersion, 'draft', 'pending_review', reason, adminId)
}

export async function reviewAdminTaxonomyTerm(
  db: D1Database,
  termId: string,
  input: ReviewTaxonomyTermInput,
  adminId: number,
) {
  const decision = requiredEnum(input.decision, ['active', 'rejected'], '审核决定')
  if (decision === 'active') {
    const term = await getTermRow(db, normalizeTaxonomyTermId(termId))
    if (term?.sensitivity === 'restricted') {
      throw new AppTaxonomyError(
        422,
        'TAXONOMY_SENSITIVE_REVIEW_REQUIRED',
        '受限敏感词条尚未接入隐私/法务升级审批，当前不能激活',
      )
    }
  }
  return transitionTerm(
    db,
    termId,
    input.expectedVersion,
    'pending_review',
    decision === 'active' ? 'active' : 'draft',
    input.reason,
    adminId,
  )
}

export async function changeAdminTaxonomyTermLifecycle(
  db: D1Database,
  termId: string,
  input: ChangeTaxonomyTermLifecycleInput,
  adminId: number,
) {
  const current = await getTermRow(db, normalizeTaxonomyTermId(termId))
  if (!current) throw new AppTaxonomyError(404, 'TAXONOMY_TERM_NOT_FOUND', '分类词条不存在')
  const expectedVersion = expectedVersionValue(input.expectedVersion)
  assertVersion(current.version, expectedVersion)
  const action = requiredEnum(input.action, ['hide', 'deprecate', 'archive', 'restore'], '生命周期操作')
  const transitions: Record<typeof action, { from: TermStatus[]; to: TermStatus }> = {
    hide: { from: ['active'], to: 'hidden' },
    deprecate: { from: ['active', 'hidden'], to: 'deprecated' },
    archive: { from: ['draft', 'hidden', 'deprecated'], to: 'archived' },
    restore: { from: ['hidden', 'deprecated'], to: 'draft' },
  }
  const transition = transitions[action]
  if (!transition.from.includes(current.lifecycle_status as TermStatus)) {
    throw new AppTaxonomyError(409, 'TAXONOMY_TERM_STATE_CONFLICT', '当前词条状态不允许执行该生命周期操作')
  }
  if (action === 'archive') {
    const references = await db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM person_profile_taxonomy_assignments WHERE term_id = ?) AS profile_count,
        (SELECT COUNT(*) FROM profile_public_taxonomy_terms WHERE term_id = ?) AS public_count,
        (SELECT COUNT(*) FROM app_taxonomy_catalog_items WHERE term_id = ?) AS catalog_count,
        (SELECT COUNT(*) FROM app_taxonomy_terms WHERE parent_term_id = ? AND lifecycle_status <> 'archived') AS child_count,
        (SELECT COUNT(*) FROM app_taxonomy_terms WHERE merge_target_term_id = ? AND lifecycle_status = 'merged') AS redirect_count
    `).bind(
      current.term_id,
      current.term_id,
      current.term_id,
      current.term_id,
      current.term_id,
    ).first<{
      profile_count: number
      public_count: number
      catalog_count: number
      child_count: number
      redirect_count: number
    }>()
    if (references && Object.values(references).some(count => Number(count) > 0)) {
      throw new AppTaxonomyError(
        422,
        'TAXONOMY_TERM_STILL_REFERENCED',
        '词条仍被资料、目录、子级或重定向引用，不能归档',
        {
          profileCount: Number(references.profile_count),
          publicCount: Number(references.public_count),
          catalogCount: Number(references.catalog_count),
          childCount: Number(references.child_count),
          redirectCount: Number(references.redirect_count),
        },
      )
    }
  }
  const reason = requiredText(input.reason, '变更原因', 120)
  const token = crypto.randomUUID()
  const now = new Date().toISOString()
  const results = await db.batch([
    db.prepare(`
      UPDATE app_taxonomy_terms
      SET lifecycle_status = ?, version = version + 1, mutation_token = ?,
          updated_by = ?, updated_at = ?
      WHERE term_id = ? AND version = ? AND lifecycle_status = ?
    `).bind(
      transition.to,
      token,
      adminId,
      now,
      current.term_id,
      expectedVersion,
      current.lifecycle_status,
    ),
    termRevisionForClaim(db, current.term_id, token, adminId, reason, now),
    taxonomyAuditForClaim(db, {
      adminId,
      action: `app_taxonomy.term_${action}`,
      targetType: 'taxonomy_term',
      targetTable: 'app_taxonomy_terms',
      targetColumn: 'term_id',
      targetId: current.term_id,
      token,
      before: { lifecycleStatus: current.lifecycle_status, version: current.version },
      after: { lifecycleStatus: transition.to, version: current.version + 1, reason },
      now,
    }),
  ])
  assertClaimed(results)
  return getAdminTaxonomyTerm(db, current.term_id)
}

export async function mergeAdminTaxonomyTerm(
  db: D1Database,
  termId: string,
  input: MergeTaxonomyTermInput,
  adminId: number,
) {
  const source = await requireEditableTerm(db, termId)
  const expectedVersion = expectedVersionValue(input.expectedVersion)
  assertVersion(source.version, expectedVersion)
  if (!['active', 'deprecated', 'hidden'].includes(source.lifecycle_status)) {
    throw new AppTaxonomyError(409, 'TAXONOMY_TERM_NOT_MERGEABLE', '只有已生效、已弃用或已隐藏词条可以合并')
  }
  const targetId = normalizeTaxonomyTermId(input.targetTermId)
  const target = await getTermRow(db, targetId)
  if (!target || target.lifecycle_status !== 'active') {
    throw new AppTaxonomyError(422, 'TAXONOMY_MERGE_TARGET_INVALID', '合并目标必须是已生效词条')
  }
  if (source.term_id === target.term_id || source.type !== target.type) {
    throw new AppTaxonomyError(422, 'TAXONOMY_MERGE_TARGET_INVALID', '合并目标不能是自身，且必须属于相同分类类型')
  }
  const reasonText = requiredText(input.reason, '合并原因', 120)
  const token = crypto.randomUUID()
  const now = new Date().toISOString()
  const results = await db.batch([
    db.prepare(`
      UPDATE app_taxonomy_terms
      SET lifecycle_status = 'merged', merge_target_term_id = ?, version = version + 1,
          mutation_token = ?, updated_by = ?, updated_at = ?
      WHERE term_id = ? AND version = ?
        AND lifecycle_status IN ('active', 'deprecated', 'hidden')
    `).bind(target.term_id, token, adminId, now, source.term_id, expectedVersion),
    termRevisionForClaim(db, source.term_id, token, adminId, reasonText, now),
    taxonomyAuditForClaim(db, {
      adminId,
      action: 'app_taxonomy.term_merge',
      targetType: 'taxonomy_term',
      targetTable: 'app_taxonomy_terms',
      targetColumn: 'term_id',
      targetId: source.term_id,
      token,
      before: termAuditSnapshot(source),
      after: { lifecycleStatus: 'merged', redirectTargetTermId: target.term_id, reason: reasonText },
      now,
    }),
  ])
  assertClaimed(results)
  return getAdminTaxonomyTerm(db, source.term_id)
}

export async function listAdminTaxonomyCatalogs(db: D1Database) {
  const rows = await db.prepare(`
    SELECT ${CATALOG_FIELDS}
    FROM app_taxonomy_catalogs
    ORDER BY created_at DESC, catalog_id ASC
    LIMIT 100
  `).all<CatalogRow>()
  return rows.results.map(mapCatalog)
}

export async function getAdminTaxonomyCatalog(db: D1Database, catalogId: string) {
  const row = await db.prepare(`
    SELECT ${CATALOG_FIELDS}
    FROM app_taxonomy_catalogs
    WHERE catalog_id = ?
    LIMIT 1
  `).bind(normalizeCatalogId(catalogId)).first<CatalogRow>()
  if (!row) throw new AppTaxonomyError(404, 'TAXONOMY_CATALOG_NOT_FOUND', '分类目录不存在')
  const items = await db.prepare(`
    SELECT term_id, term_version, type, parent_term_id, display_name, slug,
           aliases_json, public_state, redirect_target_term_id, visibility,
           allowed_for_profile, sensitivity, sort_order
    FROM app_taxonomy_catalog_items
    WHERE catalog_id = ?
    ORDER BY type ASC, sort_order ASC, display_name COLLATE NOCASE ASC, term_id ASC
  `).bind(row.catalog_id).all<{
    term_id: string
    term_version: number
    type: string
    parent_term_id: string | null
    display_name: string
    slug: string
    aliases_json: string
    public_state: string
    redirect_target_term_id: string | null
    visibility: string
    allowed_for_profile: number
    sensitivity: string
    sort_order: number
  }>()
  return {
    ...mapCatalog(row),
    items: items.results.map(item => ({
      termId: item.term_id,
      termVersion: item.term_version,
      type: item.type,
      parentTermId: item.parent_term_id,
      displayName: item.display_name,
      slug: item.slug,
      aliases: parseStringArray(item.aliases_json),
      publicState: item.public_state,
      redirectTargetTermId: item.redirect_target_term_id,
      visibility: item.visibility,
      allowedForProfile: item.allowed_for_profile === 1,
      sensitivity: item.sensitivity,
      sortOrder: item.sort_order,
    })),
  }
}

export async function createAdminTaxonomyCatalog(
  db: D1Database,
  input: CreateTaxonomyCatalogInput,
  adminId: number,
) {
  const versionCode = versionText(input.versionCode, '目录版本号')
  const minimumClientVersion = versionText(input.minimumClientVersion ?? '1.0.0', '最低客户端版本')
  const effectiveAt = isoDate(input.effectiveAt, '生效时间') ?? new Date().toISOString()
  const blockers = await db.prepare(`
    SELECT term_id, lifecycle_status, parent_term_id, merge_target_term_id
    FROM app_taxonomy_terms t
    WHERE t.lifecycle_status IN ('active', 'deprecated', 'merged')
      AND (
        (t.parent_term_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM app_taxonomy_terms p
          WHERE p.term_id = t.parent_term_id
            AND p.lifecycle_status IN ('active', 'deprecated', 'merged')
        ))
        OR (
          t.visibility = 'public' AND t.sensitivity = 'standard'
          AND t.parent_term_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM app_taxonomy_terms p
            WHERE p.term_id = t.parent_term_id
              AND (p.visibility <> 'public' OR p.sensitivity <> 'standard')
          )
        )
        OR (t.lifecycle_status = 'merged' AND NOT EXISTS (
          SELECT 1 FROM app_taxonomy_terms target
          WHERE target.term_id = t.merge_target_term_id
            AND target.lifecycle_status = 'active'
            AND target.type = t.type
        ))
        OR (
          t.lifecycle_status = 'merged'
          AND t.visibility = 'public' AND t.sensitivity = 'standard'
          AND EXISTS (
            SELECT 1 FROM app_taxonomy_terms target
            WHERE target.term_id = t.merge_target_term_id
              AND (target.visibility <> 'public' OR target.sensitivity <> 'standard')
          )
        )
      )
    LIMIT 30
  `).all<{ term_id: string }>()
  if (blockers.results.length) {
    throw new AppTaxonomyError(
      422,
      'TAXONOMY_CATALOG_GRAPH_INVALID',
      '存在父级或合并目标不完整的词条，不能生成目录快照',
      { blockerTermIds: blockers.results.map(item => item.term_id) },
    )
  }
  const catalogId = generateId('txc')
  const now = new Date().toISOString()
  try {
    await db.batch([
      db.prepare(`
        INSERT INTO app_taxonomy_catalogs (
          catalog_id, version_code, state, production_ready, effective_at,
          minimum_client_version, item_count, lock_version, created_by, created_at
        ) VALUES (?, ?, 'development', 0, ?, ?, 0, 1, ?, ?)
      `).bind(catalogId, versionCode, effectiveAt, minimumClientVersion, adminId, now),
      db.prepare(`
        INSERT INTO app_taxonomy_catalog_items (
          catalog_id, term_id, term_version, type, parent_term_id, display_name,
          slug, description, aliases_json, public_state, redirect_target_term_id,
          visibility, allowed_for_profile, sensitivity, sort_order
        )
        SELECT ?, term_id, version, type, parent_term_id, display_name,
               slug, description, aliases_json,
               CASE lifecycle_status
                 WHEN 'merged' THEN 'redirect'
                 WHEN 'deprecated' THEN 'deprecated'
                 ELSE 'active'
               END,
               merge_target_term_id, visibility, allowed_for_profile, sensitivity, sort_order
        FROM app_taxonomy_terms
        WHERE lifecycle_status IN ('active', 'deprecated', 'merged')
        ORDER BY type ASC, sort_order ASC, display_name COLLATE NOCASE ASC, term_id ASC
      `).bind(catalogId),
      db.prepare(`
        INSERT INTO app_taxonomy_catalog_closure (
          catalog_id, ancestor_term_id, descendant_term_id
        )
        WITH RECURSIVE closure(catalog_id, ancestor_term_id, descendant_term_id) AS (
          SELECT catalog_id, term_id, term_id
          FROM app_taxonomy_catalog_items
          WHERE catalog_id = ?

          UNION

          SELECT catalog_id, parent_term_id, term_id
          FROM app_taxonomy_catalog_items
          WHERE catalog_id = ? AND parent_term_id IS NOT NULL

          UNION

          SELECT catalog_id, redirect_target_term_id, term_id
          FROM app_taxonomy_catalog_items
          WHERE catalog_id = ?
            AND public_state = 'redirect'
            AND redirect_target_term_id IS NOT NULL

          UNION

          SELECT c.catalog_id, c.ancestor_term_id, edge.descendant_term_id
          FROM closure c
          JOIN (
            SELECT catalog_id, parent_term_id AS ancestor_term_id, term_id AS descendant_term_id
            FROM app_taxonomy_catalog_items
            WHERE catalog_id = ? AND parent_term_id IS NOT NULL
            UNION
            SELECT catalog_id, redirect_target_term_id AS ancestor_term_id, term_id AS descendant_term_id
            FROM app_taxonomy_catalog_items
            WHERE catalog_id = ?
              AND public_state = 'redirect'
              AND redirect_target_term_id IS NOT NULL
          ) edge
            ON edge.catalog_id = c.catalog_id
           AND edge.ancestor_term_id = c.descendant_term_id
        )
        SELECT catalog_id, ancestor_term_id, descendant_term_id
        FROM closure
      `).bind(catalogId, catalogId, catalogId, catalogId, catalogId),
      db.prepare(`
        UPDATE app_taxonomy_catalogs
        SET item_count = (
          SELECT COUNT(*) FROM app_taxonomy_catalog_items WHERE catalog_id = ?
        )
        WHERE catalog_id = ?
      `).bind(catalogId, catalogId),
      directAudit(db, {
        adminId,
        action: 'app_taxonomy.catalog_create',
        targetType: 'taxonomy_catalog',
        targetId: catalogId,
        after: { catalogId, versionCode, effectiveAt, minimumClientVersion },
        now,
      }),
    ])
  }
  catch (error) {
    if (String(error).includes('UNIQUE')) {
      throw new AppTaxonomyError(409, 'TAXONOMY_CATALOG_VERSION_EXISTS', '目录版本号已存在')
    }
    throw error
  }
  return getAdminTaxonomyCatalog(db, catalogId)
}

export async function publishAdminTaxonomyCatalog(
  db: D1Database,
  catalogId: string,
  input: PublishTaxonomyCatalogInput,
  adminId: number,
) {
  const current = await db.prepare(`
    SELECT ${CATALOG_FIELDS}
    FROM app_taxonomy_catalogs
    WHERE catalog_id = ?
    LIMIT 1
  `).bind(normalizeCatalogId(catalogId)).first<CatalogRow>()
  if (!current) throw new AppTaxonomyError(404, 'TAXONOMY_CATALOG_NOT_FOUND', '分类目录不存在')
  const expectedVersion = expectedVersionValue(input.expectedVersion)
  assertVersion(current.lock_version, expectedVersion)
  if (current.state !== 'development') {
    throw new AppTaxonomyError(409, 'TAXONOMY_CATALOG_IMMUTABLE', '只有开发态目录可以发布')
  }
  if (current.item_count < 1) {
    throw new AppTaxonomyError(422, 'TAXONOMY_CATALOG_EMPTY', '空目录不能发布')
  }
  const productionReady = optionalBoolean(input.productionReady, false)
  const now = new Date().toISOString()
  const results = await db.batch([
    db.prepare(`
      UPDATE app_taxonomy_catalogs
      SET state = 'published', production_ready = ?, lock_version = lock_version + 1,
          published_by = ?, published_at = ?
      WHERE catalog_id = ? AND lock_version = ? AND state = 'development'
    `).bind(productionReady ? 1 : 0, adminId, now, current.catalog_id, expectedVersion),
    directAudit(db, {
      adminId,
      action: 'app_taxonomy.catalog_publish',
      targetType: 'taxonomy_catalog',
      targetId: current.catalog_id,
      before: mapCatalog(current),
      after: { state: 'published', productionReady, lockVersion: expectedVersion + 1 },
      now,
      guardCatalogVersion: { catalogId: current.catalog_id, version: expectedVersion + 1 },
    }),
  ])
  assertClaimed(results)
  return getAdminTaxonomyCatalog(db, current.catalog_id)
}

export async function listAdminTaxonomyLegacyMappings(
  db: D1Database,
  input: { mappingType?: string; sourceNamespace?: string; page?: string; pageSize?: string },
) {
  const page = positiveInteger(input.page, 1, 10_000)
  const pageSize = positiveInteger(input.pageSize, 30, 100)
  const conditions: string[] = []
  const params: unknown[] = []
  if (input.mappingType) {
    conditions.push('mapping_type = ?')
    params.push(requiredEnum(
      input.mappingType,
      ['exact', 'alias', 'split_required', 'unsupported', 'pending_review'],
      '映射类型',
    ))
  }
  if (input.sourceNamespace) {
    conditions.push('source_namespace = ?')
    params.push(namespaceText(input.sourceNamespace))
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const [count, rows] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS count FROM app_taxonomy_legacy_mappings ${where}`)
      .bind(...params).first<{ count: number }>(),
    db.prepare(`
      SELECT ${LEGACY_MAPPING_FIELDS}
      FROM app_taxonomy_legacy_mappings
      ${where}
      ORDER BY updated_at DESC, mapping_id ASC
      LIMIT ? OFFSET ?
    `).bind(...params, pageSize, (page - 1) * pageSize).all<LegacyMappingRow>(),
  ])
  const total = Number(count?.count ?? 0)
  return {
    data: rows.results.map(mapLegacyMapping),
    pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  }
}

export async function upsertAdminTaxonomyLegacyMapping(
  db: D1Database,
  input: UpsertTaxonomyLegacyMappingInput,
  adminId: number,
) {
  const sourceNamespace = namespaceText(input.sourceNamespace)
  const sourceType = requiredText(input.sourceType, '来源类型', 40)
  const sourceValue = requiredText(input.sourceValue, '来源值', 120)
  const sourceNormalizedValue = normalizeLegacyValue(sourceValue)
  const mappingType = requiredEnum(
    input.mappingType,
    ['exact', 'alias', 'split_required', 'unsupported', 'pending_review'],
    '映射类型',
  )
  const targetTermId = ['exact', 'alias'].includes(mappingType)
    ? normalizeTaxonomyTermId(input.targetTermId)
    : null
  if (targetTermId) {
    const target = await getTermRow(db, targetTermId)
    if (!target || target.lifecycle_status !== 'active') {
      throw new AppTaxonomyError(422, 'TAXONOMY_MAPPING_TARGET_INVALID', '映射目标必须是已生效词条')
    }
  }
  const mappingRuleVersion = requiredText(input.mappingRuleVersion, '映射规则版本', 40)
  const note = optionalText(input.note, 300)
  const current = await db.prepare(`
    SELECT ${LEGACY_MAPPING_FIELDS}
    FROM app_taxonomy_legacy_mappings
    WHERE source_namespace = ? AND source_type = ? AND source_normalized_value = ?
    LIMIT 1
  `).bind(sourceNamespace, sourceType, sourceNormalizedValue).first<LegacyMappingRow>()
  const now = new Date().toISOString()
  if (!current) {
    if (input.expectedVersion !== undefined && input.expectedVersion !== null) {
      throw new AppTaxonomyError(409, 'TAXONOMY_MAPPING_VERSION_CONFLICT', '映射尚不存在，不能携带 expectedVersion 更新')
    }
    const mappingId = generateId('txm')
    await db.batch([
      db.prepare(`
        INSERT INTO app_taxonomy_legacy_mappings (
          mapping_id, source_namespace, source_type, source_value,
          source_normalized_value, mapping_type, target_term_id,
          mapping_rule_version, note, version, updated_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
      `).bind(
        mappingId,
        sourceNamespace,
        sourceType,
        sourceValue,
        sourceNormalizedValue,
        mappingType,
        targetTermId,
        mappingRuleVersion,
        note,
        adminId,
        now,
        now,
      ),
      directAudit(db, {
        adminId,
        action: 'app_taxonomy.legacy_mapping_create',
        targetType: 'taxonomy_legacy_mapping',
        targetId: mappingId,
        after: { sourceNamespace, sourceType, mappingType, targetTermId, mappingRuleVersion },
        now,
      }),
    ])
    return getLegacyMapping(db, mappingId)
  }

  const expectedVersion = expectedVersionValue(input.expectedVersion)
  assertVersion(current.version, expectedVersion)
  const results = await db.batch([
    db.prepare(`
      UPDATE app_taxonomy_legacy_mappings
      SET source_value = ?, mapping_type = ?, target_term_id = ?,
          mapping_rule_version = ?, note = ?, version = version + 1,
          updated_by = ?, updated_at = ?
      WHERE mapping_id = ? AND version = ?
    `).bind(
      sourceValue,
      mappingType,
      targetTermId,
      mappingRuleVersion,
      note,
      adminId,
      now,
      current.mapping_id,
      expectedVersion,
    ),
    directAudit(db, {
      adminId,
      action: 'app_taxonomy.legacy_mapping_update',
      targetType: 'taxonomy_legacy_mapping',
      targetId: current.mapping_id,
      before: mapLegacyMapping(current),
      after: { mappingType, targetTermId, mappingRuleVersion, version: expectedVersion + 1 },
      now,
      guardMappingVersion: { mappingId: current.mapping_id, version: expectedVersion + 1 },
    }),
  ])
  assertClaimed(results)
  return getLegacyMapping(db, current.mapping_id)
}

async function transitionTerm(
  db: D1Database,
  termId: string,
  expectedVersion: unknown,
  from: TermStatus,
  to: TermStatus,
  reason: unknown,
  adminId: number,
) {
  const current = await getTermRow(db, normalizeTaxonomyTermId(termId))
  if (!current) throw new AppTaxonomyError(404, 'TAXONOMY_TERM_NOT_FOUND', '分类词条不存在')
  const normalizedVersion = expectedVersionValue(expectedVersion)
  assertVersion(current.version, normalizedVersion)
  if (current.lifecycle_status !== from) {
    throw new AppTaxonomyError(409, 'TAXONOMY_TERM_STATE_CONFLICT', `词条当前不是 ${from} 状态`)
  }
  const reasonText = requiredText(reason, '变更原因', 120)
  const token = crypto.randomUUID()
  const now = new Date().toISOString()
  const results = await db.batch([
    db.prepare(`
      UPDATE app_taxonomy_terms
      SET lifecycle_status = ?, version = version + 1, mutation_token = ?,
          updated_by = ?, updated_at = ?
      WHERE term_id = ? AND version = ? AND lifecycle_status = ?
    `).bind(to, token, adminId, now, current.term_id, normalizedVersion, from),
    termRevisionForClaim(db, current.term_id, token, adminId, reasonText, now),
    taxonomyAuditForClaim(db, {
      adminId,
      action: to === 'pending_review'
        ? 'app_taxonomy.term_submit'
        : to === 'active'
          ? 'app_taxonomy.term_approve'
          : 'app_taxonomy.term_reject',
      targetType: 'taxonomy_term',
      targetTable: 'app_taxonomy_terms',
      targetColumn: 'term_id',
      targetId: current.term_id,
      token,
      before: { lifecycleStatus: from, version: normalizedVersion },
      after: { lifecycleStatus: to, version: normalizedVersion + 1, reason: reasonText },
      now,
    }),
  ])
  assertClaimed(results)
  return getAdminTaxonomyTerm(db, current.term_id)
}

async function normalizeTermDraft(
  db: D1Database,
  input: CreateTaxonomyTermInput,
  currentTermId?: string,
) {
  const type = normalizeType(input.type)
  const parentTermId = optionalTermId(input.parentTermId)
  if (parentTermId === currentTermId) {
    throw new AppTaxonomyError(422, 'TAXONOMY_PARENT_INVALID', '词条不能把自身设为父级')
  }
  if (parentTermId) {
    const parent = await getTermRow(db, parentTermId)
    if (!parent || parent.lifecycle_status === 'archived' || parent.lifecycle_status === 'merged') {
      throw new AppTaxonomyError(422, 'TAXONOMY_PARENT_INVALID', '父级词条不存在或已失效')
    }
    if (!isAllowedParentType(type, parent.type as AppTaxonomyType)) {
      throw new AppTaxonomyError(422, 'TAXONOMY_PARENT_TYPE_INVALID', '父子词条类型关系无效')
    }
    if (currentTermId) {
      const cycle = await db.prepare(`
        WITH RECURSIVE ancestors(term_id) AS (
          SELECT ?
          UNION
          SELECT t.parent_term_id
          FROM app_taxonomy_terms t
          JOIN ancestors a ON a.term_id = t.term_id
          WHERE t.parent_term_id IS NOT NULL
        )
        SELECT term_id FROM ancestors WHERE term_id = ? LIMIT 1
      `).bind(parentTermId, currentTermId).first<{ term_id: string }>()
      if (cycle) {
        throw new AppTaxonomyError(422, 'TAXONOMY_PARENT_CYCLE', '父级调整会形成分类层级循环')
      }
    }
  }
  const normalized = {
    type,
    parentTermId,
    displayName: requiredText(input.displayName, '展示名称', 40),
    slug: slugText(input.slug),
    description: optionalText(input.description, 300),
    aliases: aliasesValue(input.aliases),
    visibility: optionalEnum(input.visibility, ['public', 'internal'], '可见范围', 'public') as TermVisibility,
    allowedForProfile: optionalBoolean(input.allowedForProfile, true),
    sensitivity: optionalEnum(input.sensitivity, ['standard', 'restricted'], '敏感级别', 'standard') as TermSensitivity,
    sortOrder: integerValue(input.sortOrder, 0, -1_000_000, 1_000_000, '排序值'),
  }
  if (normalized.aliases.some(alias => normalizedName(alias) === normalizedName(normalized.displayName))) {
    throw new AppTaxonomyError(422, 'TAXONOMY_ALIAS_DUPLICATE', '别名不能与当前展示名称相同')
  }
  await assertTermNamesAvailable(
    db,
    normalized.type,
    normalized.displayName,
    normalized.aliases,
    currentTermId,
  )
  return normalized
}

async function assertTermNamesAvailable(
  db: D1Database,
  type: AppTaxonomyType,
  displayName: string,
  aliases: string[],
  currentTermId?: string,
) {
  const rows = await db.prepare(`
    SELECT term_id, display_name, aliases_json
    FROM app_taxonomy_terms
    WHERE type = ? AND lifecycle_status <> 'archived'
      AND (? IS NULL OR term_id <> ?)
  `).bind(type, currentTermId ?? null, currentTermId ?? null).all<{
    term_id: string
    display_name: string
    aliases_json: string
  }>()
  const candidateNames = new Set([displayName, ...aliases].map(normalizedName))
  const conflict = rows.results.find((row) => {
    const existingNames = [row.display_name, ...parseStringArray(row.aliases_json)].map(normalizedName)
    return existingNames.some(name => candidateNames.has(name))
  })
  if (conflict) {
    throw new AppTaxonomyError(
      409,
      'TAXONOMY_NAME_CONFLICT',
      '同类型词条的展示名称或别名已存在',
      { conflictTermId: conflict.term_id },
    )
  }
}

function isAllowedParentType(child: AppTaxonomyType, parent: AppTaxonomyType) {
  if (child === parent) return true
  if (child === 'region_group') return parent === 'region_scope'
  if (child === 'city_country') {
    return parent === 'region_scope' || parent === 'region_group'
  }
  return false
}

function normalizedName(value: string) {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('zh-CN')
}

async function requireEditableTerm(db: D1Database, termId: string) {
  const row = await getTermRow(db, normalizeTaxonomyTermId(termId))
  if (!row) throw new AppTaxonomyError(404, 'TAXONOMY_TERM_NOT_FOUND', '分类词条不存在')
  if (row.lifecycle_status === 'merged' || row.lifecycle_status === 'archived') {
    throw new AppTaxonomyError(409, 'TAXONOMY_TERM_IMMUTABLE', '已合并或已归档词条不能继续编辑')
  }
  return row
}

function getTermRow(db: D1Database, termId: string) {
  return db.prepare(`
    SELECT ${TERM_FIELDS}
    FROM app_taxonomy_terms
    WHERE term_id = ?
    LIMIT 1
  `).bind(termId).first<TermRow>()
}

async function getLegacyMapping(db: D1Database, mappingId: string) {
  const row = await db.prepare(`
    SELECT ${LEGACY_MAPPING_FIELDS}
    FROM app_taxonomy_legacy_mappings
    WHERE mapping_id = ?
    LIMIT 1
  `).bind(mappingId).first<LegacyMappingRow>()
  if (!row) throw new AppTaxonomyError(404, 'TAXONOMY_MAPPING_NOT_FOUND', '兼容映射不存在')
  return mapLegacyMapping(row)
}

function termRevisionForClaim(
  db: D1Database,
  termId: string,
  token: string,
  adminId: number,
  changeReason: string,
  now: string,
) {
  return db.prepare(`
    INSERT INTO app_taxonomy_term_revisions (
      term_id, version, type, parent_term_id, display_name, slug, description,
      aliases_json, lifecycle_status, visibility, allowed_for_profile, sensitivity,
      merge_target_term_id, sort_order, change_reason, changed_by, created_at
    )
    SELECT term_id, version, type, parent_term_id, display_name, slug, description,
           aliases_json, lifecycle_status, visibility, allowed_for_profile, sensitivity,
           merge_target_term_id, sort_order, ?, ?, ?
    FROM app_taxonomy_terms
    WHERE term_id = ? AND mutation_token = ?
  `).bind(changeReason, adminId, now, termId, token)
}

function taxonomyAuditForClaim(
  db: D1Database,
  input: {
    adminId: number
    action: string
    targetType: string
    targetTable: 'app_taxonomy_terms'
    targetColumn: 'term_id'
    targetId: string
    token: string
    before?: unknown
    after?: unknown
    now: string
  },
) {
  return db.prepare(`
    INSERT INTO admin_audit_logs (
      id, admin_id, action, target_type, target_id, before_value, after_value, created_at
    )
    SELECT ?, ?, ?, ?, ${input.targetColumn}, ?, ?, ?
    FROM ${input.targetTable}
    WHERE ${input.targetColumn} = ? AND mutation_token = ?
  `).bind(
    generateId('log'),
    input.adminId,
    input.action,
    input.targetType,
    input.before === undefined ? null : JSON.stringify(input.before),
    input.after === undefined ? null : JSON.stringify(input.after),
    input.now,
    input.targetId,
    input.token,
  )
}

function directAudit(
  db: D1Database,
  input: {
    adminId: number
    action: string
    targetType: string
    targetId: string
    before?: unknown
    after?: unknown
    now: string
    guardCatalogVersion?: { catalogId: string; version: number }
    guardMappingVersion?: { mappingId: string; version: number }
  },
) {
  if (input.guardCatalogVersion) {
    return db.prepare(`
      INSERT INTO admin_audit_logs (
        id, admin_id, action, target_type, target_id, before_value, after_value, created_at
      )
      SELECT ?, ?, ?, ?, catalog_id, ?, ?, ?
      FROM app_taxonomy_catalogs
      WHERE catalog_id = ? AND lock_version = ?
    `).bind(
      generateId('log'), input.adminId, input.action, input.targetType,
      serializeOptional(input.before), serializeOptional(input.after), input.now,
      input.guardCatalogVersion.catalogId, input.guardCatalogVersion.version,
    )
  }
  if (input.guardMappingVersion) {
    return db.prepare(`
      INSERT INTO admin_audit_logs (
        id, admin_id, action, target_type, target_id, before_value, after_value, created_at
      )
      SELECT ?, ?, ?, ?, mapping_id, ?, ?, ?
      FROM app_taxonomy_legacy_mappings
      WHERE mapping_id = ? AND version = ?
    `).bind(
      generateId('log'), input.adminId, input.action, input.targetType,
      serializeOptional(input.before), serializeOptional(input.after), input.now,
      input.guardMappingVersion.mappingId, input.guardMappingVersion.version,
    )
  }
  return db.prepare(`
    INSERT INTO admin_audit_logs (
      id, admin_id, action, target_type, target_id, before_value, after_value, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    generateId('log'), input.adminId, input.action, input.targetType, input.targetId,
    serializeOptional(input.before), serializeOptional(input.after), input.now,
  )
}

function mapTerm(row: TermRow) {
  return {
    termId: row.term_id,
    type: row.type as AppTaxonomyType,
    parentTermId: row.parent_term_id,
    displayName: row.display_name,
    slug: row.slug,
    description: row.description,
    aliases: parseStringArray(row.aliases_json),
    lifecycleStatus: row.lifecycle_status,
    visibility: row.visibility,
    allowedForProfile: row.allowed_for_profile === 1,
    sensitivity: row.sensitivity,
    mergeTargetTermId: row.merge_target_term_id,
    sortOrder: row.sort_order,
    version: row.version,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapCatalog(row: CatalogRow) {
  return {
    catalogVersionId: row.catalog_id,
    versionCode: row.version_code,
    state: row.state,
    productionReady: row.production_ready === 1,
    effectiveAt: row.effective_at,
    minimumClientVersion: row.minimum_client_version,
    itemCount: row.item_count,
    lockVersion: row.lock_version,
    createdBy: row.created_by,
    publishedBy: row.published_by,
    createdAt: row.created_at,
    publishedAt: row.published_at,
  }
}

function mapLegacyMapping(row: LegacyMappingRow) {
  return {
    mappingId: row.mapping_id,
    sourceNamespace: row.source_namespace,
    sourceType: row.source_type,
    sourceValue: row.source_value,
    sourceNormalizedValue: row.source_normalized_value,
    mappingType: row.mapping_type,
    targetTermId: row.target_term_id,
    mappingRuleVersion: row.mapping_rule_version,
    note: row.note,
    version: row.version,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function termAuditSnapshot(row: TermRow) {
  return {
    termId: row.term_id,
    type: row.type,
    parentTermId: row.parent_term_id,
    displayName: row.display_name,
    slug: row.slug,
    lifecycleStatus: row.lifecycle_status,
    visibility: row.visibility,
    allowedForProfile: row.allowed_for_profile === 1,
    sensitivity: row.sensitivity,
    mergeTargetTermId: row.merge_target_term_id,
    sortOrder: row.sort_order,
    version: row.version,
  }
}

function normalizeType(value: unknown): AppTaxonomyType {
  if (!isAppTaxonomyType(value)) {
    throw new AppTaxonomyError(400, 'TAXONOMY_TYPE_INVALID', '分类类型无效')
  }
  return value
}

function normalizeStatus(value: unknown): TermStatus {
  if (typeof value !== 'string' || !TERM_STATUSES.includes(value as TermStatus)) {
    throw new AppTaxonomyError(400, 'TAXONOMY_STATUS_INVALID', '词条状态无效')
  }
  return value as TermStatus
}

function optionalTermId(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  return normalizeTaxonomyTermId(value)
}

function normalizeCatalogId(value: unknown): string {
  if (typeof value !== 'string' || !/^txc_[A-Za-z0-9_-]{4,92}$/u.test(value)) {
    throw new AppTaxonomyError(400, 'TAXONOMY_CATALOG_ID_INVALID', '分类目录 ID 格式无效')
  }
  return value
}

function requiredText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') {
    throw new AppTaxonomyError(400, 'TAXONOMY_INPUT_INVALID', `${label}必须为字符串`)
  }
  const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' ')
  if (!normalized || [...normalized].length > maxLength || hasControlCharacters(normalized)) {
    throw new AppTaxonomyError(400, 'TAXONOMY_INPUT_INVALID', `${label}必须为 1 至 ${maxLength} 个有效字符`)
  }
  return normalized
}

function optionalText(value: unknown, maxLength: number): string | null {
  if (value === undefined || value === null || value === '') return null
  return requiredText(value, '文本', maxLength)
}

function slugText(value: unknown): string {
  if (typeof value !== 'string') {
    throw new AppTaxonomyError(400, 'TAXONOMY_SLUG_INVALID', 'slug 必须为字符串')
  }
  const normalized = value.trim().toLowerCase()
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(normalized) || normalized.length > 64) {
    throw new AppTaxonomyError(400, 'TAXONOMY_SLUG_INVALID', 'slug 只能由小写字母、数字和单个连字符组成')
  }
  return normalized
}

function aliasesValue(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new AppTaxonomyError(400, 'TAXONOMY_ALIASES_INVALID', 'aliases 必须为数组')
  }
  const aliases = [...new Set(value.map(item => requiredText(item, '别名', 40)))]
  if (aliases.length > 20) {
    throw new AppTaxonomyError(400, 'TAXONOMY_ALIASES_INVALID', '别名最多 20 个')
  }
  return aliases
}

function expectedVersionValue(value: unknown): number {
  const parsed = typeof value === 'string' && /^[1-9]\d{0,9}$/u.test(value) ? Number(value) : value
  if (!Number.isSafeInteger(parsed) || Number(parsed) <= 0) {
    throw new AppTaxonomyError(400, 'EXPECTED_VERSION_INVALID', 'expectedVersion 必须为正整数')
  }
  return Number(parsed)
}

function integerValue(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  label: string,
) {
  if (value === undefined || value === null || value === '') return fallback
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) {
    throw new AppTaxonomyError(400, 'TAXONOMY_INPUT_INVALID', `${label}必须为 ${min} 至 ${max} 的整数`)
  }
  return Number(value)
}

function optionalBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') {
    throw new AppTaxonomyError(400, 'TAXONOMY_INPUT_INVALID', '布尔字段格式无效')
  }
  return value
}

function optionalEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
  fallback: T,
): T {
  if (value === undefined || value === null || value === '') return fallback
  return requiredEnum(value, allowed, label)
}

function requiredEnum<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new AppTaxonomyError(400, 'TAXONOMY_INPUT_INVALID', `${label}无效`)
  }
  return value as T
}

function versionText(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new AppTaxonomyError(400, 'TAXONOMY_VERSION_INVALID', `${label}格式无效`)
  }
  const normalized = value.trim()
  if (!/^\d+(?:\.\d+){1,3}$/u.test(normalized) || normalized.length > 40) {
    throw new AppTaxonomyError(400, 'TAXONOMY_VERSION_INVALID', `${label}必须为数字点分版本`)
  }
  return normalized
}

function isoDate(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new AppTaxonomyError(400, 'TAXONOMY_DATE_INVALID', `${label}格式无效`)
  }
  return new Date(value).toISOString()
}

function namespaceText(value: unknown): string {
  if (typeof value !== 'string') {
    throw new AppTaxonomyError(400, 'TAXONOMY_NAMESPACE_INVALID', '来源命名空间格式无效')
  }
  const normalized = value.trim()
  if (!/^[A-Za-z0-9_.-]{1,40}$/u.test(normalized)) {
    throw new AppTaxonomyError(400, 'TAXONOMY_NAMESPACE_INVALID', '来源命名空间格式无效')
  }
  return normalized
}

function normalizeLegacyValue(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('zh-CN')
}

function positiveInteger(value: string | undefined, fallback: number, max: number) {
  if (value === undefined || value === '') return fallback
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new AppTaxonomyError(400, 'PAGINATION_INVALID', '分页参数必须为正整数')
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed > max) {
    throw new AppTaxonomyError(400, 'PAGINATION_INVALID', `分页参数不能超过 ${max}`)
  }
  return parsed
}

function assertVersion(current: number, expected: number) {
  if (current !== expected) {
    throw new AppTaxonomyError(409, 'VERSION_CONFLICT', '记录已被其他操作更新，请刷新后重试', {
      expectedVersion: expected,
      currentVersion: current,
    })
  }
}

function assertClaimed(results: D1Result<unknown>[]) {
  if (Number(results[0]?.meta?.changes ?? 0) !== 1) {
    throw new AppTaxonomyError(409, 'VERSION_CONFLICT', '记录已被其他操作更新，请刷新后重试')
  }
}

function parseStringArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) && parsed.every(item => typeof item === 'string') ? parsed : []
  }
  catch {
    return []
  }
}

function hasControlCharacters(value: string) {
  return containsUnsafeInvisibleCharacter(value)
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/gu, match => `\\${match}`)
}

function serializeOptional(value: unknown) {
  return value === undefined ? null : JSON.stringify(value)
}

const TERM_FIELDS = `
  term_id, type, parent_term_id, display_name, slug, description, aliases_json,
  lifecycle_status, visibility, allowed_for_profile, sensitivity,
  merge_target_term_id, sort_order, version, created_by, updated_by,
  created_at, updated_at
`

const CATALOG_FIELDS = `
  catalog_id, version_code, state, production_ready, effective_at,
  minimum_client_version, item_count, lock_version, created_by, published_by,
  created_at, published_at
`

const LEGACY_MAPPING_FIELDS = `
  mapping_id, source_namespace, source_type, source_value, source_normalized_value,
  mapping_type, target_term_id, mapping_rule_version, note, version,
  updated_by, created_at, updated_at
`
