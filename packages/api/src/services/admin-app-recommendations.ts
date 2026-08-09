import { generateId } from '../utils/db'
import {
  AppRecommendationError,
  normalizeRecommendationExpectedVersion,
  normalizeRecommendationPlacementId,
  normalizeRecommendationRegionCode,
  normalizeRecommendationRuleVersionId,
  type AppRecommendationPolicy,
} from './app-recommendation-policy'
import {
  RECOMMENDATION_RULE_FIELDS,
  assertRecommendationRuleRuntimeDependencies,
  dryRunAppRecommendationRule,
  parseRecommendationReasonMap,
  parseRecommendationWeights,
  type RecommendationRuleRow,
} from './app-recommendations'
import { requireAppOperationalControlAvailable } from './app-operational-safety'

const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7E]{16,128}$/u
const VERSION_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u

type AdminActor = {
  adminId: number
  role: string
  requestId: string
}

type EditorialPlacementRow = {
  placement_id: string
  state: string
  entry_point: string
  profile_id: string
  position_key: string
  priority: number
  region_code: string | null
  channel: string
  disclosure_code: string
  disclosure_label: string
  reason: string
  starts_at: string
  ends_at: string
  version: number
  created_by: number
  updated_by: number
  reviewed_by: number | null
  created_at: string
  updated_at: string
  reviewed_at: string | null
  activated_at: string | null
  paused_at: string | null
}

export type CreateRecommendationRuleInput = {
  mode?: unknown
  name?: unknown
  description?: unknown
  taxonomyCatalogId?: unknown
  heatVersionId?: unknown
  weights?: unknown
  reasonMap?: unknown
  targetRegionCodes?: unknown
  maxConsecutiveSameRegion?: unknown
  maxConsecutiveSameTerm?: unknown
  repeatExposureCap?: unknown
  rolloutPercent?: unknown
  minimumClientVersion?: unknown
  effectiveAt?: unknown
  expiresAt?: unknown
  rollbackRuleVersionId?: unknown
}

export type UpdateRecommendationRuleInput = Omit<CreateRecommendationRuleInput, 'mode'> & {
  expectedVersion?: unknown
}

export type CreateEditorialPlacementInput = {
  profileId?: unknown
  priority?: unknown
  regionCode?: unknown
  reason?: unknown
  startsAt?: unknown
  endsAt?: unknown
}

export type UpdateEditorialPlacementInput = Partial<CreateEditorialPlacementInput> & {
  expectedVersion?: unknown
}

export async function getAdminRecommendationOverview(
  db: D1Database,
  policy: AppRecommendationPolicy,
  now = new Date(),
) {
  const [rules, placements, heat] = await Promise.all([
    db.prepare(`
      SELECT state, COUNT(*) AS count
      FROM app_recommendation_rule_versions
      GROUP BY state
    `).all<{ state: string; count: number }>(),
    db.prepare(`
      SELECT state, COUNT(*) AS count
      FROM app_recommendation_editorial_placements
      GROUP BY state
    `).all<{ state: string; count: number }>(),
    db.prepare(`
      SELECT heat_version_id, version_code, state, production_ready,
             observation_window_days, minimum_sample_size
      FROM app_recommendation_heat_versions
      ORDER BY created_at DESC, heat_version_id ASC
      LIMIT 20
    `).all<{
      heat_version_id: string
      version_code: string
      state: string
      production_ready: number
      observation_window_days: number
      minimum_sample_size: number
    }>(),
  ])
  return {
    policy,
    runtime: {
      effectiveAt: policy.effectiveAt,
      generatedAt: now.toISOString(),
      productionReady: policy.productionReady,
      personalizationReady: policy.personalizationEnabled
        && policy.personalizationDecisionStatus === 'approved',
      evidenceReady: policy.evidenceRecordingEnabled
        && policy.evidenceRetentionDecisionStatus === 'approved'
        && policy.purgeEnabled,
    },
    ruleCounts: Object.fromEntries(rules.results.map(item => [item.state, Number(item.count)])),
    placementCounts: Object.fromEntries(placements.results.map(item => [item.state, Number(item.count)])),
    heatVersions: heat.results.map(item => ({
      heatVersionId: item.heat_version_id,
      versionCode: item.version_code,
      state: item.state,
      productionReady: item.production_ready === 1,
      observationWindowDays: item.observation_window_days,
      minimumSampleSize: item.minimum_sample_size,
    })),
  }
}

export async function listAdminRecommendationRules(
  db: D1Database,
  input: { state?: string; mode?: string },
) {
  const conditions: string[] = []
  const params: unknown[] = []
  if (input.state) {
    if (!RULE_STATES.includes(input.state as typeof RULE_STATES[number])) {
      throw new AppRecommendationError(400, 'RECOMMENDATION_RULE_STATE_INVALID', '推荐规则状态筛选无效')
    }
    conditions.push('state = ?')
    params.push(input.state)
  }
  if (input.mode) {
    if (input.mode !== 'non_personalized' && input.mode !== 'personalized') {
      throw new AppRecommendationError(400, 'RECOMMENDATION_MODE_INVALID', '推荐模式筛选无效')
    }
    conditions.push('mode = ?')
    params.push(input.mode)
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const rows = await db.prepare(`
    SELECT ${RECOMMENDATION_RULE_FIELDS}
    FROM app_recommendation_rule_versions
    ${where}
    ORDER BY updated_at DESC, rule_set_id ASC, version_number DESC
    LIMIT 200
  `).bind(...params).all<RecommendationRuleRow>()
  return rows.results.map(mapRule)
}

export async function getAdminRecommendationRule(db: D1Database, ruleVersionIdValue: unknown) {
  const ruleVersionId = normalizeRecommendationRuleVersionId(ruleVersionIdValue)
  const [row, events] = await Promise.all([
    findRule(db, ruleVersionId),
    db.prepare(`
      SELECT event_id, from_state, to_state, action, reason, actor_id, request_id, created_at
      FROM app_recommendation_rule_events
      WHERE rule_version_id = ?
      ORDER BY created_at DESC, event_id ASC
      LIMIT 100
    `).bind(ruleVersionId).all<{
      event_id: string
      from_state: string | null
      to_state: string
      action: string
      reason: string
      actor_id: number
      request_id: string | null
      created_at: string
    }>(),
  ])
  if (!row) throw ruleNotFound()
  return {
    ...mapRule(row),
    events: events.results.map(item => ({
      eventId: item.event_id,
      fromState: item.from_state,
      toState: item.to_state,
      action: item.action,
      reason: item.reason,
      actorId: item.actor_id,
      requestId: item.request_id,
      createdAt: item.created_at,
    })),
  }
}

export async function createAdminRecommendationRule(
  db: D1Database,
  inputValue: unknown,
  idempotencyKeyValue: string | null,
  actor: AdminActor,
  now = new Date(),
) {
  assertActor(actor)
  const input = requireObject<CreateRecommendationRuleInput>(inputValue, CREATE_RULE_KEYS, '推荐规则草稿')
  const draft = await normalizeRuleDraft(db, input)
  const idempotency = await prepareIdempotency(idempotencyKeyValue, 'recommendation.rule.create', draft)
  const replay = await findAdminRequest(db, actor.adminId, idempotency.keyHash)
  if (replay) return replayRule(db, replay, idempotency)
  const ruleSetId = generateId('rrs')
  const ruleVersionId = generateId('rrv')
  const nowIso = now.toISOString()
  try {
    await db.batch([
      insertRuleStatement(db, {
        ruleSetId,
        ruleVersionId,
        versionNumber: 1,
        draft,
        actor,
        nowIso,
      }),
      insertRuleEvent(db, ruleVersionId, null, 'draft', 'create', '创建推荐规则草稿', actor, nowIso),
      insertAdminRequest(db, actor.adminId, idempotency, 'rule_version', ruleVersionId, nowIso),
      directAudit(db, actor.adminId, 'recommendation_rule_create', 'app_recommendation_rule', ruleVersionId, null, {
        mode: draft.mode,
        name: draft.name,
      }, nowIso),
    ])
  }
  catch (error) {
    const raced = await findAdminRequest(db, actor.adminId, idempotency.keyHash)
    if (raced) return replayRule(db, raced, idempotency)
    throw error
  }
  return { rule: await getAdminRecommendationRule(db, ruleVersionId), replayed: false }
}

export async function copyAdminRecommendationRule(
  db: D1Database,
  sourceRuleVersionIdValue: unknown,
  idempotencyKeyValue: string | null,
  actor: AdminActor,
  now = new Date(),
) {
  assertActor(actor)
  const sourceId = normalizeRecommendationRuleVersionId(sourceRuleVersionIdValue)
  const source = await findRule(db, sourceId)
  if (!source) throw ruleNotFound()
  const idempotency = await prepareIdempotency(
    idempotencyKeyValue,
    'recommendation.rule.copy',
    { sourceRuleVersionId: sourceId, sourceVersion: source.lock_version },
  )
  const replay = await findAdminRequest(db, actor.adminId, idempotency.keyHash)
  if (replay) return replayRule(db, replay, idempotency)
  const latest = await db.prepare(`
    SELECT MAX(version_number) AS version_number
    FROM app_recommendation_rule_versions
    WHERE rule_set_id = ?
  `).bind(source.rule_set_id).first<{ version_number: number }>()
  const nextVersion = Number(latest?.version_number ?? 0) + 1
  const ruleVersionId = generateId('rrv')
  const nowIso = now.toISOString()
  const draft = draftFromRow(source)
  try {
    await db.batch([
      insertRuleStatement(db, {
        ruleSetId: source.rule_set_id,
        ruleVersionId,
        versionNumber: nextVersion,
        draft,
        actor,
        nowIso,
      }),
      insertRuleEvent(db, ruleVersionId, null, 'draft', 'copy', `复制自 ${sourceId}`, actor, nowIso),
      insertAdminRequest(db, actor.adminId, idempotency, 'rule_version', ruleVersionId, nowIso),
      directAudit(db, actor.adminId, 'recommendation_rule_copy', 'app_recommendation_rule', ruleVersionId, null, {
        sourceRuleVersionId: sourceId,
        versionNumber: nextVersion,
      }, nowIso),
    ])
  }
  catch (error) {
    const raced = await findAdminRequest(db, actor.adminId, idempotency.keyHash)
    if (raced) return replayRule(db, raced, idempotency)
    throw error
  }
  return { rule: await getAdminRecommendationRule(db, ruleVersionId), replayed: false }
}

export async function updateAdminRecommendationRule(
  db: D1Database,
  ruleVersionIdValue: unknown,
  inputValue: unknown,
  actor: AdminActor,
  now = new Date(),
) {
  assertActor(actor)
  const ruleVersionId = normalizeRecommendationRuleVersionId(ruleVersionIdValue)
  const input = requireObject<UpdateRecommendationRuleInput>(inputValue, UPDATE_RULE_KEYS, '推荐规则更新')
  const expectedVersion = normalizeRecommendationExpectedVersion(input.expectedVersion)
  const current = await findRule(db, ruleVersionId)
  if (!current) throw ruleNotFound()
  if (current.lock_version !== expectedVersion) throw ruleVersionConflict()
  if (current.state !== 'draft') {
    throw new AppRecommendationError(409, 'RECOMMENDATION_RULE_IMMUTABLE', '只有草稿规则可以编辑；请复制为新版本')
  }
  const draft = await normalizeRuleDraft(db, {
    mode: current.mode,
    name: input.name ?? current.name,
    description: input.description === undefined ? current.description : input.description,
    taxonomyCatalogId: input.taxonomyCatalogId === undefined
      ? current.taxonomy_catalog_id
      : input.taxonomyCatalogId,
    heatVersionId: input.heatVersionId === undefined ? current.heat_version_id : input.heatVersionId,
    weights: input.weights ?? parseJson(current.weights_json),
    reasonMap: input.reasonMap ?? parseJson(current.reason_map_json),
    targetRegionCodes: input.targetRegionCodes ?? parseJson(current.target_region_codes_json),
    maxConsecutiveSameRegion: input.maxConsecutiveSameRegion ?? current.max_consecutive_same_region,
    maxConsecutiveSameTerm: input.maxConsecutiveSameTerm ?? current.max_consecutive_same_term,
    repeatExposureCap: input.repeatExposureCap ?? current.repeat_exposure_cap,
    rolloutPercent: input.rolloutPercent ?? current.rollout_percent,
    minimumClientVersion: input.minimumClientVersion ?? current.minimum_client_version,
    effectiveAt: input.effectiveAt === undefined ? current.effective_at : input.effectiveAt,
    expiresAt: input.expiresAt === undefined ? current.expires_at : input.expiresAt,
    rollbackRuleVersionId: input.rollbackRuleVersionId === undefined
      ? current.rollback_rule_version_id
      : input.rollbackRuleVersionId,
  })
  const token = crypto.randomUUID()
  const nowIso = now.toISOString()
  await db.batch([
    db.prepare(`
      UPDATE app_recommendation_rule_versions
      SET name = ?, description = ?, taxonomy_catalog_id = ?, heat_version_id = ?,
          weights_json = ?, reason_map_json = ?, target_region_codes_json = ?,
          max_consecutive_same_region = ?, max_consecutive_same_term = ?,
          repeat_exposure_cap = ?, rollout_percent = ?, minimum_client_version = ?,
          effective_at = ?, expires_at = ?, rollback_rule_version_id = ?,
          last_dry_run_json = NULL, last_dry_run_at = NULL,
          lock_version = lock_version + 1, mutation_token = ?, updated_by = ?, updated_at = ?
      WHERE rule_version_id = ? AND state = 'draft' AND lock_version = ?
    `).bind(
      draft.name,
      draft.description,
      draft.taxonomyCatalogId,
      draft.heatVersionId,
      JSON.stringify(draft.weights),
      JSON.stringify(draft.reasonMap),
      JSON.stringify(draft.targetRegionCodes),
      draft.maxConsecutiveSameRegion,
      draft.maxConsecutiveSameTerm,
      draft.repeatExposureCap,
      draft.rolloutPercent,
      draft.minimumClientVersion,
      draft.effectiveAt,
      draft.expiresAt,
      draft.rollbackRuleVersionId,
      token,
      actor.adminId,
      nowIso,
      ruleVersionId,
      expectedVersion,
    ),
    guardedRuleAudit(db, ruleVersionId, token, actor.adminId, 'recommendation_rule_update', {
      beforeVersion: expectedVersion,
      afterVersion: expectedVersion + 1,
    }, nowIso),
  ])
  const updated = await findRuleByToken(db, ruleVersionId, token)
  if (!updated) throw ruleVersionConflict()
  return getAdminRecommendationRule(db, ruleVersionId)
}

export async function dryRunAdminRecommendationRule(
  db: D1Database,
  ruleVersionIdValue: unknown,
  inputValue: unknown,
  actor: AdminActor,
  policy: AppRecommendationPolicy,
  apiUrl: string,
  now = new Date(),
) {
  assertActor(actor)
  const ruleVersionId = normalizeRecommendationRuleVersionId(ruleVersionIdValue)
  const input = requireObject<{ expectedVersion?: unknown; regionCode?: unknown }>(
    inputValue,
    ['expectedVersion', 'regionCode'],
    '推荐 Dry-run',
  )
  const expectedVersion = normalizeRecommendationExpectedVersion(input.expectedVersion)
  const current = await findRule(db, ruleVersionId)
  if (!current) throw ruleNotFound()
  if (current.lock_version !== expectedVersion) throw ruleVersionConflict()
  if (!['draft', 'validating', 'approved'].includes(current.state)) {
    throw new AppRecommendationError(409, 'RECOMMENDATION_DRY_RUN_STATE_INVALID', '当前规则状态不能运行 Dry-run')
  }
  const result = await dryRunAppRecommendationRule(db, current, policy, apiUrl, input.regionCode, now)
  const token = crypto.randomUUID()
  const nowIso = now.toISOString()
  await db.batch([
    db.prepare(`
      UPDATE app_recommendation_rule_versions
      SET last_dry_run_json = ?, last_dry_run_at = ?, lock_version = lock_version + 1,
          mutation_token = ?, updated_by = ?, updated_at = ?
      WHERE rule_version_id = ? AND lock_version = ?
        AND state IN ('draft', 'validating', 'approved')
    `).bind(
      JSON.stringify(result),
      nowIso,
      token,
      actor.adminId,
      nowIso,
      ruleVersionId,
      expectedVersion,
    ),
    guardedRuleAudit(db, ruleVersionId, token, actor.adminId, 'recommendation_rule_dry_run', {
      candidateCount: result.candidateCount,
      emptyResultRisk: result.emptyResultRisk,
      producesExposure: false,
    }, nowIso),
  ])
  if (!await findRuleByToken(db, ruleVersionId, token)) throw ruleVersionConflict()
  return {
    result,
    rule: await getAdminRecommendationRule(db, ruleVersionId),
  }
}

export async function submitAdminRecommendationRule(
  db: D1Database,
  ruleVersionIdValue: unknown,
  inputValue: unknown,
  actor: AdminActor,
  now = new Date(),
) {
  const ruleVersionId = normalizeRecommendationRuleVersionId(ruleVersionIdValue)
  const input = transitionInput(inputValue)
  const current = await requireRuleState(db, ruleVersionId, input.expectedVersion, ['draft'])
  const dryRun = parseDryRun(current.last_dry_run_json)
  if (!dryRun || dryRun.emptyResultRisk || dryRun.candidateCount <= 0) {
    throw new AppRecommendationError(422, 'RECOMMENDATION_DRY_RUN_REQUIRED', '提交审核前必须完成有候选结果的 Dry-run')
  }
  return transitionRule(db, current, 'validating', 'submit', input.reason, actor, now)
}

export async function decideAdminRecommendationRule(
  db: D1Database,
  ruleVersionIdValue: unknown,
  inputValue: unknown,
  actor: AdminActor,
  now = new Date(),
) {
  requireOwner(actor)
  const ruleVersionId = normalizeRecommendationRuleVersionId(ruleVersionIdValue)
  const object = requireObject<{ expectedVersion?: unknown; decision?: unknown; reason?: unknown }>(
    inputValue,
    ['expectedVersion', 'decision', 'reason'],
    '推荐规则复核',
  )
  const expectedVersion = normalizeRecommendationExpectedVersion(object.expectedVersion)
  const reason = requiredText(object.reason, 500, '复核原因')
  if (object.decision !== 'approve' && object.decision !== 'reject') {
    throw new AppRecommendationError(400, 'RECOMMENDATION_DECISION_INVALID', '复核决定必须为 approve 或 reject')
  }
  const current = await requireRuleState(db, ruleVersionId, expectedVersion, ['validating'])
  if (current.created_by === actor.adminId) {
    throw new AppRecommendationError(403, 'RECOMMENDATION_REVIEW_SEPARATION_REQUIRED', '规则创建人与复核人必须分离')
  }
  return transitionRule(
    db,
    current,
    object.decision === 'approve' ? 'approved' : 'draft',
    object.decision,
    reason,
    actor,
    now,
    { reviewed: true },
  )
}

export async function activateAdminRecommendationRule(
  db: D1Database,
  ruleVersionIdValue: unknown,
  inputValue: unknown,
  actor: AdminActor,
  policy: AppRecommendationPolicy,
  requireProductionReady: boolean,
  now = new Date(),
) {
  requireOwner(actor)
  await requireRecommendationDeliveryControl(db)
  const ruleVersionId = normalizeRecommendationRuleVersionId(ruleVersionIdValue)
  const input = transitionInput(inputValue)
  const current = await requireRuleState(db, ruleVersionId, input.expectedVersion, ['approved', 'scheduled', 'paused'])
  validateRuleForActivation(current, policy, requireProductionReady, now)
  await assertRecommendationRuleRuntimeDependencies(db, current, requireProductionReady, now, 422)
  await assertRolloutFallback(db, current, requireProductionReady, now)
  const targetState = current.effective_at && Date.parse(current.effective_at) > now.getTime()
    ? 'scheduled'
    : 'active'
  const conflicts = await db.prepare(`
    SELECT ${RECOMMENDATION_RULE_FIELDS}
    FROM app_recommendation_rule_versions
    WHERE entry_point = ? AND mode = ?
      AND rule_version_id <> ?
      AND state IN ('active', 'scheduled')
    ORDER BY state ASC, activated_at DESC, rule_version_id ASC
  `).bind(current.entry_point, current.mode, current.rule_version_id).all<RecommendationRuleRow>()
  const token = crypto.randomUUID()
  const nowIso = now.toISOString()
  const statements: D1PreparedStatement[] = []
  const superseded = conflicts.results.filter(conflict => (
    targetState === 'active' || conflict.state === 'scheduled'
  ))
  for (const conflict of superseded) {
    const conflictToken = crypto.randomUUID()
    statements.push(
      db.prepare(`
        UPDATE app_recommendation_rule_versions
        SET state = 'paused', paused_at = ?, lock_version = lock_version + 1,
            mutation_token = ?, updated_by = ?, updated_at = ?
        WHERE rule_version_id = ? AND state = ? AND lock_version = ?
          AND EXISTS (
            SELECT 1 FROM app_recommendation_rule_versions target
            WHERE target.rule_version_id = ?
              AND target.state IN ('approved', 'scheduled', 'paused')
              AND target.lock_version = ?
          )
          AND EXISTS (
            SELECT 1 FROM app_operational_safety_controls control
            WHERE control.control_key = 'recommendation_delivery' AND control.state = 'available'
          )
      `).bind(
        nowIso,
        conflictToken,
        actor.adminId,
        nowIso,
        conflict.rule_version_id,
        conflict.state,
        conflict.lock_version,
        current.rule_version_id,
        current.lock_version,
      ),
      guardedRuleEvent(
        db,
        conflict.rule_version_id,
        conflictToken,
        conflict.state,
        'paused',
        'superseded',
        `由 ${current.rule_version_id} ${targetState === 'scheduled' ? '计划替换' : '替换'}`,
        actor,
        nowIso,
      ),
    )
  }
  statements.push(
    db.prepare(`
      UPDATE app_recommendation_rule_versions
      SET state = ?, activated_by = ?, activated_at = ?, paused_at = NULL,
          lock_version = lock_version + 1, mutation_token = ?, updated_by = ?, updated_at = ?
      WHERE rule_version_id = ? AND lock_version = ?
        AND state IN ('approved', 'scheduled', 'paused')
        AND EXISTS (
          SELECT 1 FROM app_operational_safety_controls control
          WHERE control.control_key = 'recommendation_delivery' AND control.state = 'available'
        )
    `).bind(
      targetState,
      actor.adminId,
      nowIso,
      token,
      actor.adminId,
      nowIso,
      current.rule_version_id,
      current.lock_version,
    ),
    guardedRuleEvent(
      db,
      current.rule_version_id,
      token,
      current.state,
      targetState,
      targetState === 'scheduled' ? 'schedule' : 'activate',
      input.reason,
      actor,
      nowIso,
    ),
    guardedRuleAudit(db, current.rule_version_id, token, actor.adminId, targetState === 'scheduled'
      ? 'recommendation_rule_schedule'
      : 'recommendation_rule_activate', {
      supersededRuleVersionIds: superseded.map(item => item.rule_version_id),
      retainedActiveRuleVersionIds: targetState === 'scheduled'
        ? conflicts.results.filter(item => item.state === 'active').map(item => item.rule_version_id)
        : [],
      targetState,
      reason: input.reason,
    }, nowIso),
  )
  await db.batch(statements)
  if (!await findRuleByToken(db, current.rule_version_id, token)) throw ruleVersionConflict()
  return getAdminRecommendationRule(db, current.rule_version_id)
}

export async function pauseAdminRecommendationRule(
  db: D1Database,
  ruleVersionIdValue: unknown,
  inputValue: unknown,
  actor: AdminActor,
  now = new Date(),
) {
  requireOwner(actor)
  const ruleVersionId = normalizeRecommendationRuleVersionId(ruleVersionIdValue)
  const input = transitionInput(inputValue)
  const current = await requireRuleState(db, ruleVersionId, input.expectedVersion, ['active', 'scheduled'])
  return transitionRule(db, current, 'paused', 'pause', input.reason, actor, now, { paused: true })
}

export async function rollbackAdminRecommendationRule(
  db: D1Database,
  ruleVersionIdValue: unknown,
  inputValue: unknown,
  actor: AdminActor,
  policy: AppRecommendationPolicy,
  requireProductionReady: boolean,
  now = new Date(),
) {
  requireOwner(actor)
  const ruleVersionId = normalizeRecommendationRuleVersionId(ruleVersionIdValue)
  const input = transitionInput(inputValue)
  const current = await requireRuleState(db, ruleVersionId, input.expectedVersion, ['active', 'scheduled'])
  if (current.state === 'scheduled') {
    const retainedActive = await db.prepare(`
      SELECT ${RECOMMENDATION_RULE_FIELDS}
      FROM app_recommendation_rule_versions
      WHERE entry_point = ? AND mode = ? AND state = 'active'
      LIMIT 1
    `).bind(current.entry_point, current.mode).first<RecommendationRuleRow>()
    if (!retainedActive) {
      throw new AppRecommendationError(
        422,
        'RECOMMENDATION_ROLLBACK_TARGET_INVALID',
        '待生效规则没有可继续保留的当前生效版本，请改用暂停排期',
      )
    }
    validateRuleForActivation(retainedActive, policy, requireProductionReady, now)
    await assertRecommendationRuleRuntimeDependencies(db, retainedActive, requireProductionReady, now, 422)
    await assertRolloutFallback(db, retainedActive, requireProductionReady, now)
    const rolledBack = await transitionRule(
      db,
      current,
      'rolled_back',
      'rollback',
      input.reason,
      actor,
      now,
      { paused: true },
    )
    return {
      rolledBack,
      active: await getAdminRecommendationRule(db, retainedActive.rule_version_id),
    }
  }
  if (!current.rollback_rule_version_id) {
    throw new AppRecommendationError(422, 'RECOMMENDATION_ROLLBACK_TARGET_MISSING', '当前规则没有登记回滚版本')
  }
  const target = await findRule(db, current.rollback_rule_version_id)
  if (!target || !['active', 'paused', 'approved', 'retired'].includes(target.state)) {
    throw new AppRecommendationError(422, 'RECOMMENDATION_ROLLBACK_TARGET_INVALID', '回滚版本不存在或当前不可恢复')
  }
  validateRuleForActivation(target, policy, requireProductionReady, now)
  await assertRecommendationRuleRuntimeDependencies(db, target, requireProductionReady, now, 422)
  await assertRolloutFallback(db, target, requireProductionReady, now)
  const currentToken = crypto.randomUUID()
  const targetToken = crypto.randomUUID()
  const nowIso = now.toISOString()
  await db.batch([
    db.prepare(`
      UPDATE app_recommendation_rule_versions
      SET state = 'rolled_back', paused_at = ?, lock_version = lock_version + 1,
          mutation_token = ?, updated_by = ?, updated_at = ?
      WHERE rule_version_id = ? AND state = 'active' AND lock_version = ?
        AND EXISTS (
          SELECT 1 FROM app_recommendation_rule_versions target
          WHERE target.rule_version_id = ? AND target.lock_version = ?
            AND target.state IN ('paused', 'approved', 'retired')
        )
    `).bind(
      nowIso,
      currentToken,
      actor.adminId,
      nowIso,
      current.rule_version_id,
      current.lock_version,
      target.rule_version_id,
      target.lock_version,
    ),
    db.prepare(`
      UPDATE app_recommendation_rule_versions
      SET state = 'active', activated_by = ?, activated_at = ?, paused_at = NULL,
          lock_version = lock_version + 1, mutation_token = ?, updated_by = ?, updated_at = ?
      WHERE rule_version_id = ? AND lock_version = ?
        AND state IN ('paused', 'approved', 'retired')
        AND EXISTS (
          SELECT 1 FROM app_recommendation_rule_versions current_rule
          WHERE current_rule.rule_version_id = ? AND current_rule.mutation_token = ?
        )
    `).bind(
      actor.adminId,
      nowIso,
      targetToken,
      actor.adminId,
      nowIso,
      target.rule_version_id,
      target.lock_version,
      current.rule_version_id,
      currentToken,
    ),
    guardedRuleEvent(
      db,
      current.rule_version_id,
      currentToken,
      'active',
      'rolled_back',
      'rollback',
      input.reason,
      actor,
      nowIso,
    ),
    guardedRuleEvent(
      db,
      target.rule_version_id,
      targetToken,
      target.state,
      'active',
      'rollback_restore',
      input.reason,
      actor,
      nowIso,
    ),
    guardedRuleAudit(db, current.rule_version_id, currentToken, actor.adminId, 'recommendation_rule_rollback', {
      restoredRuleVersionId: target.rule_version_id,
      reason: input.reason,
    }, nowIso),
  ])
  if (!await findRuleByToken(db, target.rule_version_id, targetToken)) throw ruleVersionConflict()
  return {
    rolledBack: await getAdminRecommendationRule(db, current.rule_version_id),
    active: await getAdminRecommendationRule(db, target.rule_version_id),
  }
}

export async function listAdminEditorialPlacements(
  db: D1Database,
  input: { state?: string },
) {
  const state = input.state || null
  if (state && !PLACEMENT_STATES.includes(state as typeof PLACEMENT_STATES[number])) {
    throw new AppRecommendationError(400, 'RECOMMENDATION_PLACEMENT_STATE_INVALID', '运营精选状态筛选无效')
  }
  const rows = await db.prepare(`
    SELECT ${PLACEMENT_FIELDS}
    FROM app_recommendation_editorial_placements
    WHERE (? IS NULL OR state = ?)
    ORDER BY starts_at DESC, priority ASC, placement_id ASC
    LIMIT 200
  `).bind(state, state).all<EditorialPlacementRow>()
  return rows.results.map(mapPlacement)
}

export async function createAdminEditorialPlacement(
  db: D1Database,
  inputValue: unknown,
  idempotencyKeyValue: string | null,
  actor: AdminActor,
  now = new Date(),
) {
  assertActor(actor)
  const input = requireObject<CreateEditorialPlacementInput>(inputValue, CREATE_PLACEMENT_KEYS, '运营精选排期')
  const placement = await normalizePlacement(db, input)
  const idempotency = await prepareIdempotency(idempotencyKeyValue, 'recommendation.placement.create', placement)
  const replay = await findAdminRequest(db, actor.adminId, idempotency.keyHash)
  if (replay) return replayPlacement(db, replay, idempotency)
  const placementId = generateId('rep')
  const nowIso = now.toISOString()
  try {
    await db.batch([
      db.prepare(`
        INSERT INTO app_recommendation_editorial_placements (
          placement_id, state, entry_point, profile_id, position_key, priority,
          region_code, channel, disclosure_code, disclosure_label, reason,
          starts_at, ends_at, version, mutation_token, created_by, updated_by,
          reviewed_by, created_at, updated_at, reviewed_at, activated_at, paused_at
        ) VALUES (
          ?, 'draft', 'discovery_home', ?, 'discovery_feed', ?, ?, 'app',
          'PLATFORM_SELECTED', '平台精选', ?, ?, ?, 1, NULL, ?, ?, NULL, ?, ?, NULL, NULL, NULL
        )
      `).bind(
        placementId,
        placement.profileId,
        placement.priority,
        placement.regionCode,
        placement.reason,
        placement.startsAt,
        placement.endsAt,
        actor.adminId,
        actor.adminId,
        nowIso,
        nowIso,
      ),
      insertAdminRequest(db, actor.adminId, idempotency, 'placement', placementId, nowIso),
      directAudit(db, actor.adminId, 'recommendation_placement_create', 'app_recommendation_placement', placementId, null, placement, nowIso),
    ])
  }
  catch (error) {
    const raced = await findAdminRequest(db, actor.adminId, idempotency.keyHash)
    if (raced) return replayPlacement(db, raced, idempotency)
    throw error
  }
  return { placement: await getAdminEditorialPlacement(db, placementId), replayed: false }
}

export async function getAdminEditorialPlacement(db: D1Database, placementIdValue: unknown) {
  const placementId = normalizeRecommendationPlacementId(placementIdValue)
  const row = await findPlacement(db, placementId)
  if (!row) throw placementNotFound()
  const eligibility = await getPlacementEligibility(db, row.profile_id, new Date())
  return { ...mapPlacement(row), eligibility }
}

export async function updateAdminEditorialPlacement(
  db: D1Database,
  placementIdValue: unknown,
  inputValue: unknown,
  actor: AdminActor,
  now = new Date(),
) {
  assertActor(actor)
  const placementId = normalizeRecommendationPlacementId(placementIdValue)
  const input = requireObject<UpdateEditorialPlacementInput>(inputValue, UPDATE_PLACEMENT_KEYS, '运营精选更新')
  const expectedVersion = normalizeRecommendationExpectedVersion(input.expectedVersion)
  const current = await findPlacement(db, placementId)
  if (!current) throw placementNotFound()
  if (current.version !== expectedVersion) throw placementVersionConflict()
  if (current.state !== 'draft') {
    throw new AppRecommendationError(409, 'RECOMMENDATION_PLACEMENT_IMMUTABLE', '只有草稿排期可以编辑')
  }
  const placement = await normalizePlacement(db, {
    profileId: input.profileId ?? current.profile_id,
    priority: input.priority ?? current.priority,
    regionCode: input.regionCode === undefined ? current.region_code : input.regionCode,
    reason: input.reason ?? current.reason,
    startsAt: input.startsAt ?? current.starts_at,
    endsAt: input.endsAt ?? current.ends_at,
  })
  const token = crypto.randomUUID()
  const nowIso = now.toISOString()
  await db.batch([
    db.prepare(`
      UPDATE app_recommendation_editorial_placements
      SET profile_id = ?, priority = ?, region_code = ?, reason = ?, starts_at = ?, ends_at = ?,
          version = version + 1, mutation_token = ?, updated_by = ?, updated_at = ?
      WHERE placement_id = ? AND state = 'draft' AND version = ?
    `).bind(
      placement.profileId,
      placement.priority,
      placement.regionCode,
      placement.reason,
      placement.startsAt,
      placement.endsAt,
      token,
      actor.adminId,
      nowIso,
      placementId,
      expectedVersion,
    ),
    guardedPlacementAudit(db, placementId, token, actor.adminId, 'recommendation_placement_update', {
      beforeVersion: expectedVersion,
      afterVersion: expectedVersion + 1,
    }, nowIso),
  ])
  if (!await findPlacementByToken(db, placementId, token)) throw placementVersionConflict()
  return getAdminEditorialPlacement(db, placementId)
}

export async function submitAdminEditorialPlacement(
  db: D1Database,
  placementIdValue: unknown,
  inputValue: unknown,
  actor: AdminActor,
  now = new Date(),
) {
  const placementId = normalizeRecommendationPlacementId(placementIdValue)
  const input = transitionInput(inputValue)
  const current = await requirePlacementState(db, placementId, input.expectedVersion, ['draft'])
  assertPlacementNotExpired(current, now)
  const eligibility = await getPlacementEligibility(db, current.profile_id, now)
  if (!eligibility.eligible) {
    throw new AppRecommendationError(422, 'RECOMMENDATION_PLACEMENT_PROFILE_INELIGIBLE', '目标真人资料当前不满足公开资格')
  }
  await assertNoPlacementConflict(db, current, current.placement_id)
  return transitionPlacement(db, current, 'pending_review', 'submit', input.reason, actor, now)
}

export async function decideAdminEditorialPlacement(
  db: D1Database,
  placementIdValue: unknown,
  inputValue: unknown,
  actor: AdminActor,
  now = new Date(),
) {
  requireOwner(actor)
  const placementId = normalizeRecommendationPlacementId(placementIdValue)
  const object = requireObject<{ expectedVersion?: unknown; decision?: unknown; reason?: unknown }>(
    inputValue,
    ['expectedVersion', 'decision', 'reason'],
    '运营精选复核',
  )
  const expectedVersion = normalizeRecommendationExpectedVersion(object.expectedVersion)
  const reason = requiredText(object.reason, 500, '复核原因')
  if (object.decision !== 'approve' && object.decision !== 'reject') {
    throw new AppRecommendationError(400, 'RECOMMENDATION_DECISION_INVALID', '复核决定必须为 approve 或 reject')
  }
  const current = await requirePlacementState(db, placementId, expectedVersion, ['pending_review'])
  if (current.created_by === actor.adminId) {
    throw new AppRecommendationError(403, 'RECOMMENDATION_REVIEW_SEPARATION_REQUIRED', '排期创建人与复核人必须分离')
  }
  if (object.decision === 'approve') {
    assertPlacementNotExpired(current, now)
    const eligibility = await getPlacementEligibility(db, current.profile_id, now)
    if (!eligibility.eligible) {
      throw new AppRecommendationError(422, 'RECOMMENDATION_PLACEMENT_PROFILE_INELIGIBLE', '目标真人资料当前不满足公开资格')
    }
    await assertNoPlacementConflict(db, current, current.placement_id)
  }
  return transitionPlacement(
    db,
    current,
    object.decision === 'approve' ? 'approved' : 'draft',
    object.decision,
    reason,
    actor,
    now,
    { reviewed: true },
  )
}

export async function activateAdminEditorialPlacement(
  db: D1Database,
  placementIdValue: unknown,
  inputValue: unknown,
  actor: AdminActor,
  now = new Date(),
) {
  requireOwner(actor)
  await requireRecommendationDeliveryControl(db)
  const placementId = normalizeRecommendationPlacementId(placementIdValue)
  const input = transitionInput(inputValue)
  const current = await requirePlacementState(db, placementId, input.expectedVersion, ['approved', 'scheduled'])
  assertPlacementNotExpired(current, now)
  const eligibility = await getPlacementEligibility(db, current.profile_id, now)
  if (!eligibility.eligible) {
    throw new AppRecommendationError(422, 'RECOMMENDATION_PLACEMENT_PROFILE_INELIGIBLE', '目标真人资料当前不满足公开资格')
  }
  await assertNoPlacementConflict(db, current, current.placement_id)
  const nextState = Date.parse(current.starts_at) > now.getTime() ? 'scheduled' : 'active'
  return transitionPlacement(db, current, nextState, 'activate', input.reason, actor, now, {
    activated: true,
    requiresDeliveryControl: true,
  })
}

export async function pauseAdminEditorialPlacement(
  db: D1Database,
  placementIdValue: unknown,
  inputValue: unknown,
  actor: AdminActor,
  now = new Date(),
) {
  requireOwner(actor)
  const placementId = normalizeRecommendationPlacementId(placementIdValue)
  const input = transitionInput(inputValue)
  const current = await requirePlacementState(db, placementId, input.expectedVersion, ['active', 'scheduled'])
  return transitionPlacement(db, current, 'paused', 'pause', input.reason, actor, now, { paused: true })
}

type NormalizedRuleDraft = Awaited<ReturnType<typeof normalizeRuleDraft>>

async function normalizeRuleDraft(db: D1Database, input: CreateRecommendationRuleInput) {
  const mode = input.mode === undefined ? 'non_personalized' : input.mode
  if (mode !== 'non_personalized' && mode !== 'personalized') {
    throw new AppRecommendationError(400, 'RECOMMENDATION_MODE_INVALID', '推荐模式必须为 non_personalized 或 personalized')
  }
  const name = requiredText(input.name, 80, '规则名称')
  const description = optionalText(input.description, 500, '规则说明')
  const taxonomyCatalogId = optionalId(input.taxonomyCatalogId, /^txc_[A-Za-z0-9_-]{4,92}$/u, 'taxonomy 目录 ID')
  const heatVersionId = optionalId(input.heatVersionId, /^rhv_[A-Za-z0-9_-]{1,92}$/u, 'heatVersion ID')
  const weights = normalizeWeightsInput(input.weights, mode)
  const reasonMap = normalizeReasonMapInput(input.reasonMap)
  const targetRegionCodes = normalizeRegionCodes(input.targetRegionCodes)
  const maxConsecutiveSameRegion = integer(input.maxConsecutiveSameRegion, 3, 1, 20, '同地区连续上限')
  const maxConsecutiveSameTerm = integer(input.maxConsecutiveSameTerm, 3, 1, 20, '同分类连续上限')
  const repeatExposureCap = integer(input.repeatExposureCap, 3, 1, 100, '重复曝光上限')
  const rolloutPercent = integer(input.rolloutPercent, 0, 0, 100, '灰度比例')
  const minimumClientVersion = optionalVersionCode(input.minimumClientVersion) ?? '1.0'
  const effectiveAt = optionalTimestamp(input.effectiveAt, '生效时间')
  const expiresAt = optionalTimestamp(input.expiresAt, '结束时间')
  if (effectiveAt && expiresAt && Date.parse(expiresAt) <= Date.parse(effectiveAt)) {
    throw new AppRecommendationError(400, 'RECOMMENDATION_TIME_RANGE_INVALID', '结束时间必须晚于生效时间')
  }
  const rollbackRuleVersionId = input.rollbackRuleVersionId === undefined || input.rollbackRuleVersionId === null || input.rollbackRuleVersionId === ''
    ? null
    : normalizeRecommendationRuleVersionId(input.rollbackRuleVersionId)
  if (mode === 'personalized' && !taxonomyCatalogId) {
    throw new AppRecommendationError(422, 'RECOMMENDATION_TAXONOMY_REQUIRED', '个性化规则必须绑定稳定 taxonomy 目录')
  }
  await assertReferences(db, taxonomyCatalogId, heatVersionId, rollbackRuleVersionId)
  return {
    mode,
    name,
    description,
    taxonomyCatalogId,
    heatVersionId,
    weights,
    reasonMap,
    targetRegionCodes,
    maxConsecutiveSameRegion,
    maxConsecutiveSameTerm,
    repeatExposureCap,
    rolloutPercent,
    minimumClientVersion,
    effectiveAt,
    expiresAt,
    rollbackRuleVersionId,
  }
}

function insertRuleStatement(
  db: D1Database,
  input: {
    ruleSetId: string
    ruleVersionId: string
    versionNumber: number
    draft: NormalizedRuleDraft
    actor: AdminActor
    nowIso: string
  },
) {
  return db.prepare(`
    INSERT INTO app_recommendation_rule_versions (
      rule_version_id, rule_set_id, version_number, state, entry_point, mode,
      name, description, taxonomy_catalog_id, heat_version_id, weights_json,
      reason_map_json, target_region_codes_json, target_channels_json,
      max_consecutive_same_region, max_consecutive_same_term, repeat_exposure_cap,
      rollout_percent, minimum_client_version, effective_at, expires_at,
      rollback_rule_version_id, production_ready, last_dry_run_json, last_dry_run_at,
      lock_version, mutation_token, created_by, updated_by, reviewed_by, activated_by,
      created_at, updated_at, reviewed_at, activated_at, paused_at
    ) VALUES (
      ?, ?, ?, 'draft', 'discovery_home', ?, ?, ?, ?, ?, ?, ?, ?, '["app"]',
      ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, 1, NULL, ?, ?, NULL, NULL, ?, ?, NULL, NULL, NULL
    )
  `).bind(
    input.ruleVersionId,
    input.ruleSetId,
    input.versionNumber,
    input.draft.mode,
    input.draft.name,
    input.draft.description,
    input.draft.taxonomyCatalogId,
    input.draft.heatVersionId,
    JSON.stringify(input.draft.weights),
    JSON.stringify(input.draft.reasonMap),
    JSON.stringify(input.draft.targetRegionCodes),
    input.draft.maxConsecutiveSameRegion,
    input.draft.maxConsecutiveSameTerm,
    input.draft.repeatExposureCap,
    input.draft.rolloutPercent,
    input.draft.minimumClientVersion,
    input.draft.effectiveAt,
    input.draft.expiresAt,
    input.draft.rollbackRuleVersionId,
    input.actor.adminId,
    input.actor.adminId,
    input.nowIso,
    input.nowIso,
  )
}

async function transitionRule(
  db: D1Database,
  current: RecommendationRuleRow,
  targetState: string,
  action: string,
  reason: string,
  actor: AdminActor,
  now: Date,
  flags: { reviewed?: boolean; paused?: boolean } = {},
) {
  assertActor(actor)
  const token = crypto.randomUUID()
  const nowIso = now.toISOString()
  await db.batch([
    db.prepare(`
      UPDATE app_recommendation_rule_versions
      SET state = ?, reviewed_by = CASE WHEN ? = 1 THEN ? ELSE reviewed_by END,
          reviewed_at = CASE WHEN ? = 1 THEN ? ELSE reviewed_at END,
          paused_at = CASE WHEN ? = 1 THEN ? ELSE paused_at END,
          lock_version = lock_version + 1, mutation_token = ?, updated_by = ?, updated_at = ?
      WHERE rule_version_id = ? AND state = ? AND lock_version = ?
    `).bind(
      targetState,
      flags.reviewed ? 1 : 0,
      actor.adminId,
      flags.reviewed ? 1 : 0,
      nowIso,
      flags.paused ? 1 : 0,
      nowIso,
      token,
      actor.adminId,
      nowIso,
      current.rule_version_id,
      current.state,
      current.lock_version,
    ),
    guardedRuleEvent(
      db,
      current.rule_version_id,
      token,
      current.state,
      targetState,
      action,
      reason,
      actor,
      nowIso,
    ),
    guardedRuleAudit(db, current.rule_version_id, token, actor.adminId, `recommendation_rule_${action}`, {
      fromState: current.state,
      toState: targetState,
      reason,
    }, nowIso),
  ])
  if (!await findRuleByToken(db, current.rule_version_id, token)) throw ruleVersionConflict()
  return getAdminRecommendationRule(db, current.rule_version_id)
}

async function requireRuleState(
  db: D1Database,
  ruleVersionId: string,
  expectedVersionValue: unknown,
  states: string[],
) {
  const expectedVersion = normalizeRecommendationExpectedVersion(expectedVersionValue)
  const current = await findRule(db, ruleVersionId)
  if (!current) throw ruleNotFound()
  if (current.lock_version !== expectedVersion) throw ruleVersionConflict()
  if (!states.includes(current.state)) {
    throw new AppRecommendationError(409, 'RECOMMENDATION_RULE_STATE_CONFLICT', '推荐规则当前状态不允许该操作')
  }
  return current
}

function validateRuleForActivation(
  rule: RecommendationRuleRow,
  policy: AppRecommendationPolicy,
  requireProductionReady: boolean,
  now: Date,
) {
  parseRecommendationWeights(rule.weights_json)
  parseRecommendationReasonMap(rule.reason_map_json)
  const dryRun = parseDryRun(rule.last_dry_run_json)
  if (!dryRun || dryRun.emptyResultRisk || dryRun.candidateCount <= 0) {
    throw new AppRecommendationError(422, 'RECOMMENDATION_DRY_RUN_REQUIRED', '启用前必须完成有候选结果的 Dry-run')
  }
  if (rule.rollout_percent <= 0) {
    throw new AppRecommendationError(422, 'RECOMMENDATION_ROLLOUT_REQUIRED', '启用规则必须设置大于 0 的灰度比例')
  }
  if (rule.expires_at && Date.parse(rule.expires_at) <= now.getTime()) {
    throw new AppRecommendationError(422, 'RECOMMENDATION_RULE_EXPIRED', '推荐规则已超过结束时间')
  }
  if (requireProductionReady && rule.production_ready !== 1) {
    throw new AppRecommendationError(403, 'RECOMMENDATION_RULE_PRODUCTION_NOT_READY', '推荐规则尚未通过生产门禁')
  }
  if (
    rule.mode === 'personalized'
    && (!policy.personalizationEnabled || policy.personalizationDecisionStatus !== 'approved')
  ) {
    throw new AppRecommendationError(403, 'RECOMMENDATION_PERSONALIZATION_NOT_READY', '个性化规则需在 OQ-023 关闭后独立启用')
  }
}

async function assertRolloutFallback(
  db: D1Database,
  rule: RecommendationRuleRow,
  requireProductionReady: boolean,
  now: Date,
) {
  if (rule.rollout_percent >= 100) return
  if (!rule.rollback_rule_version_id || rule.rollback_rule_version_id === rule.rule_version_id) {
    throw new AppRecommendationError(
      422,
      'RECOMMENDATION_ROLLOUT_FALLBACK_REQUIRED',
      '小于 100% 的灰度必须绑定另一个已生效过的完整回退版本',
    )
  }
  const fallback = await findRule(db, rule.rollback_rule_version_id)
  const usable = fallback
    && fallback.entry_point === rule.entry_point
    && fallback.mode === rule.mode
    && (rule.mode !== 'personalized' || fallback.taxonomy_catalog_id === rule.taxonomy_catalog_id)
    && ['active', 'paused', 'retired', 'rolled_back'].includes(fallback.state)
    && Boolean(fallback.activated_at)
    && (!fallback.expires_at || Date.parse(fallback.expires_at) > now.getTime())
    && (!requireProductionReady || fallback.production_ready === 1)
  if (!usable) {
    throw new AppRecommendationError(
      422,
      'RECOMMENDATION_ROLLOUT_FALLBACK_INVALID',
      '灰度回退版本未生效过、模式/个性化目录不一致、已过期或未通过当前环境门禁',
    )
  }
  await assertRecommendationRuleRuntimeDependencies(db, fallback, requireProductionReady, now, 422)
}

async function normalizePlacement(db: D1Database, input: CreateEditorialPlacementInput) {
  const profileId = requiredId(input.profileId, /^pp_[A-Za-z0-9_-]{1,77}$/u, '真人资料 ID')
  const priority = integer(input.priority, 100, 1, 1000, '精选优先级')
  const regionCode = normalizeRecommendationRegionCode(input.regionCode)
  const reason = requiredText(input.reason, 500, '精选原因')
  const startsAt = requiredTimestamp(input.startsAt, '开始时间')
  const endsAt = requiredTimestamp(input.endsAt, '结束时间')
  if (Date.parse(endsAt) <= Date.parse(startsAt)) {
    throw new AppRecommendationError(400, 'RECOMMENDATION_TIME_RANGE_INVALID', '结束时间必须晚于开始时间')
  }
  const exists = await db.prepare('SELECT id FROM person_profiles WHERE id = ? LIMIT 1')
    .bind(profileId).first<{ id: string }>()
  if (!exists) throw new AppRecommendationError(404, 'PERSON_PROFILE_NOT_FOUND', '真人资料不存在')
  return { profileId, priority, regionCode, reason, startsAt, endsAt }
}

async function transitionPlacement(
  db: D1Database,
  current: EditorialPlacementRow,
  targetState: string,
  action: string,
  reason: string,
  actor: AdminActor,
  now: Date,
  flags: {
    reviewed?: boolean
    activated?: boolean
    paused?: boolean
    requiresDeliveryControl?: boolean
  } = {},
) {
  const token = crypto.randomUUID()
  const nowIso = now.toISOString()
  await db.batch([
    db.prepare(`
      UPDATE app_recommendation_editorial_placements
      SET state = ?, reviewed_by = CASE WHEN ? = 1 THEN ? ELSE reviewed_by END,
          reviewed_at = CASE WHEN ? = 1 THEN ? ELSE reviewed_at END,
          activated_at = CASE WHEN ? = 1 THEN ? ELSE activated_at END,
          paused_at = CASE WHEN ? = 1 THEN ? ELSE paused_at END,
          version = version + 1, mutation_token = ?, updated_by = ?, updated_at = ?
      WHERE placement_id = ? AND state = ? AND version = ?
        AND (
          ? = 0
          OR EXISTS (
            SELECT 1 FROM app_operational_safety_controls control
            WHERE control.control_key = 'recommendation_delivery' AND control.state = 'available'
          )
        )
    `).bind(
      targetState,
      flags.reviewed ? 1 : 0,
      actor.adminId,
      flags.reviewed ? 1 : 0,
      nowIso,
      flags.activated ? 1 : 0,
      nowIso,
      flags.paused ? 1 : 0,
      nowIso,
      token,
      actor.adminId,
      nowIso,
      current.placement_id,
      current.state,
      current.version,
      flags.requiresDeliveryControl ? 1 : 0,
    ),
    guardedPlacementAudit(db, current.placement_id, token, actor.adminId, `recommendation_placement_${action}`, {
      fromState: current.state,
      toState: targetState,
      reason,
    }, nowIso),
  ])
  if (!await findPlacementByToken(db, current.placement_id, token)) throw placementVersionConflict()
  return getAdminEditorialPlacement(db, current.placement_id)
}

async function requireRecommendationDeliveryControl(db: D1Database) {
  return requireAppOperationalControlAvailable(
    db,
    'recommendation_delivery',
    (code, message, detail) => new AppRecommendationError(503, code, message, true, detail),
  )
}

async function requirePlacementState(
  db: D1Database,
  placementId: string,
  expectedVersionValue: unknown,
  states: string[],
) {
  const expectedVersion = normalizeRecommendationExpectedVersion(expectedVersionValue)
  const current = await findPlacement(db, placementId)
  if (!current) throw placementNotFound()
  if (current.version !== expectedVersion) throw placementVersionConflict()
  if (!states.includes(current.state)) {
    throw new AppRecommendationError(409, 'RECOMMENDATION_PLACEMENT_STATE_CONFLICT', '运营精选当前状态不允许该操作')
  }
  return current
}

function assertPlacementNotExpired(placement: EditorialPlacementRow, now: Date) {
  if (!Number.isFinite(Date.parse(placement.ends_at)) || Date.parse(placement.ends_at) <= now.getTime()) {
    throw new AppRecommendationError(
      422,
      'RECOMMENDATION_PLACEMENT_EXPIRED',
      '运营精选排期已结束；如需再次启用请创建并复核新排期',
    )
  }
}

async function getPlacementEligibility(db: D1Database, profileId: string, now: Date) {
  const row = await db.prepare(`
    SELECT p.id,
      EXISTS (
        SELECT 1
        FROM profile_public_projections projection
        JOIN galleries g ON g.id = projection.source_gallery_id
        WHERE projection.profile_id = p.id
          AND projection.verification_status = 'verified'
          AND projection.publication_status = 'published'
          AND projection.authorization_status = 'active'
          AND projection.visibility_status = 'visible'
          AND (projection.authorization_valid_from IS NULL OR datetime(projection.authorization_valid_from) <= datetime(?))
          AND (projection.authorization_valid_until IS NULL OR datetime(projection.authorization_valid_until) > datetime(?))
          AND (projection.verification_valid_until IS NULL OR datetime(projection.verification_valid_until) > datetime(?))
          AND g.status = 'published'
      ) AS eligible
    FROM person_profiles p
    WHERE p.id = ?
    LIMIT 1
  `).bind(now.toISOString(), now.toISOString(), now.toISOString(), profileId)
    .first<{ id: string; eligible: number }>()
  return {
    exists: Boolean(row),
    eligible: row?.eligible === 1,
    checkedAt: now.toISOString(),
  }
}

async function assertNoPlacementConflict(
  db: D1Database,
  placement: EditorialPlacementRow,
  excludedPlacementId: string,
) {
  const conflict = await db.prepare(`
    SELECT placement_id
    FROM app_recommendation_editorial_placements
    WHERE placement_id <> ?
      AND entry_point = ?
      AND channel = ?
      AND position_key = ?
      AND priority = ?
      AND COALESCE(region_code, '') = COALESCE(?, '')
      AND state IN ('approved', 'scheduled', 'active')
      AND datetime(starts_at) < datetime(?)
      AND datetime(ends_at) > datetime(?)
    LIMIT 1
  `).bind(
    excludedPlacementId,
    placement.entry_point,
    placement.channel,
    placement.position_key,
    placement.priority,
    placement.region_code,
    placement.ends_at,
    placement.starts_at,
  ).first<{ placement_id: string }>()
  if (conflict) {
    throw new AppRecommendationError(
      409,
      'RECOMMENDATION_PLACEMENT_CONFLICT',
      '同一位置、地区和优先级存在重叠排期',
      false,
      { conflictingPlacementId: conflict.placement_id },
    )
  }
}

async function assertReferences(
  db: D1Database,
  taxonomyCatalogId: string | null,
  heatVersionId: string | null,
  rollbackRuleVersionId: string | null,
) {
  const checks: Promise<unknown>[] = []
  if (taxonomyCatalogId) {
    checks.push(db.prepare('SELECT catalog_id FROM app_taxonomy_catalogs WHERE catalog_id = ? LIMIT 1')
      .bind(taxonomyCatalogId).first())
  }
  if (heatVersionId) {
    checks.push(db.prepare('SELECT heat_version_id FROM app_recommendation_heat_versions WHERE heat_version_id = ? LIMIT 1')
      .bind(heatVersionId).first())
  }
  if (rollbackRuleVersionId) {
    checks.push(db.prepare('SELECT rule_version_id FROM app_recommendation_rule_versions WHERE rule_version_id = ? LIMIT 1')
      .bind(rollbackRuleVersionId).first())
  }
  const results = await Promise.all(checks)
  if (results.some(item => !item)) {
    throw new AppRecommendationError(422, 'RECOMMENDATION_REFERENCE_INVALID', '规则引用的目录、热度或回滚版本不存在')
  }
}

function normalizeWeightsInput(value: unknown, mode: string) {
  const defaults = mode === 'personalized'
    ? { quality: 50, heat: 0, freshness: 20, region: 0, preferredTaxonomy: 30 }
    : { quality: 70, heat: 0, freshness: 30, region: 0, preferredTaxonomy: 0 }
  const raw = value === undefined ? defaults : value
  return parseRecommendationWeights(JSON.stringify(raw))
}

function normalizeReasonMapInput(value: unknown) {
  const defaults = {
    editorial: 'PLATFORM_SELECTED',
    region: 'REGION_RELEVANT',
    popular: 'RECENTLY_POPULAR',
    fresh: 'RECENTLY_PUBLISHED',
    preferred: 'PREFERENCE_RELEVANT',
    default: 'DISCOVERY_NEUTRAL',
  }
  return parseRecommendationReasonMap(JSON.stringify(value === undefined ? defaults : value))
}

function normalizeRegionCodes(value: unknown) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > 50) {
    throw new AppRecommendationError(400, 'RECOMMENDATION_REGIONS_INVALID', '目标地区必须为最多 50 项的数组')
  }
  return [...new Set(value.map(item => {
    const normalized = normalizeRecommendationRegionCode(item)
    if (!normalized) throw new AppRecommendationError(400, 'RECOMMENDATION_REGIONS_INVALID', '目标地区不能为空')
    return normalized
  }))].sort()
}

function draftFromRow(row: RecommendationRuleRow): NormalizedRuleDraft {
  if (row.mode !== 'non_personalized' && row.mode !== 'personalized') {
    throw new AppRecommendationError(503, 'RECOMMENDATION_DATA_INVALID', '推荐规则模式数据异常', true)
  }
  return {
    mode: row.mode,
    name: `${row.name}（副本）`.slice(0, 80),
    description: row.description,
    taxonomyCatalogId: row.taxonomy_catalog_id,
    heatVersionId: row.heat_version_id,
    weights: parseRecommendationWeights(row.weights_json),
    reasonMap: parseRecommendationReasonMap(row.reason_map_json),
    targetRegionCodes: normalizeRegionCodes(parseJson(row.target_region_codes_json)),
    maxConsecutiveSameRegion: row.max_consecutive_same_region,
    maxConsecutiveSameTerm: row.max_consecutive_same_term,
    repeatExposureCap: row.repeat_exposure_cap,
    rolloutPercent: 0,
    minimumClientVersion: row.minimum_client_version,
    effectiveAt: null,
    expiresAt: null,
    rollbackRuleVersionId: row.rule_version_id,
  }
}

function mapRule(row: RecommendationRuleRow) {
  return {
    ruleVersionId: row.rule_version_id,
    ruleSetId: row.rule_set_id,
    versionNumber: row.version_number,
    state: row.state,
    entryPoint: row.entry_point,
    mode: row.mode,
    name: row.name,
    description: row.description,
    taxonomyCatalogId: row.taxonomy_catalog_id,
    heatVersionId: row.heat_version_id,
    weights: parseJson(row.weights_json),
    reasonMap: parseJson(row.reason_map_json),
    targetRegionCodes: parseJson(row.target_region_codes_json),
    targetChannels: parseJson(row.target_channels_json),
    diversity: {
      maxConsecutiveSameRegion: row.max_consecutive_same_region,
      maxConsecutiveSameTerm: row.max_consecutive_same_term,
      repeatExposureCap: row.repeat_exposure_cap,
    },
    rolloutPercent: row.rollout_percent,
    minimumClientVersion: row.minimum_client_version,
    effectiveAt: row.effective_at,
    expiresAt: row.expires_at,
    rollbackRuleVersionId: row.rollback_rule_version_id,
    productionReady: row.production_ready === 1,
    lastDryRun: parseDryRun(row.last_dry_run_json),
    lastDryRunAt: row.last_dry_run_at,
    version: row.lock_version,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    reviewedBy: row.reviewed_by,
    activatedBy: row.activated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    reviewedAt: row.reviewed_at,
    activatedAt: row.activated_at,
    pausedAt: row.paused_at,
  }
}

function mapPlacement(row: EditorialPlacementRow) {
  return {
    placementId: row.placement_id,
    state: row.state,
    entryPoint: row.entry_point,
    profileId: row.profile_id,
    positionKey: row.position_key,
    priority: row.priority,
    regionCode: row.region_code,
    channel: row.channel,
    disclosure: { code: row.disclosure_code, label: row.disclosure_label },
    reason: row.reason,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    version: row.version,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    reviewedBy: row.reviewed_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    reviewedAt: row.reviewed_at,
    activatedAt: row.activated_at,
    pausedAt: row.paused_at,
  }
}

async function findRule(db: D1Database, ruleVersionId: string) {
  return db.prepare(`
    SELECT ${RECOMMENDATION_RULE_FIELDS}
    FROM app_recommendation_rule_versions
    WHERE rule_version_id = ?
    LIMIT 1
  `).bind(ruleVersionId).first<RecommendationRuleRow>()
}

async function findRuleByToken(db: D1Database, ruleVersionId: string, token: string) {
  return db.prepare(`
    SELECT ${RECOMMENDATION_RULE_FIELDS}
    FROM app_recommendation_rule_versions
    WHERE rule_version_id = ? AND mutation_token = ?
    LIMIT 1
  `).bind(ruleVersionId, token).first<RecommendationRuleRow>()
}

async function findPlacement(db: D1Database, placementId: string) {
  return db.prepare(`
    SELECT ${PLACEMENT_FIELDS}
    FROM app_recommendation_editorial_placements
    WHERE placement_id = ?
    LIMIT 1
  `).bind(placementId).first<EditorialPlacementRow>()
}

async function findPlacementByToken(db: D1Database, placementId: string, token: string) {
  return db.prepare(`
    SELECT ${PLACEMENT_FIELDS}
    FROM app_recommendation_editorial_placements
    WHERE placement_id = ? AND mutation_token = ?
    LIMIT 1
  `).bind(placementId, token).first<EditorialPlacementRow>()
}

function insertRuleEvent(
  db: D1Database,
  ruleVersionId: string,
  fromState: string | null,
  toState: string,
  action: string,
  reason: string,
  actor: AdminActor,
  nowIso: string,
) {
  return db.prepare(`
    INSERT INTO app_recommendation_rule_events (
      event_id, rule_version_id, from_state, to_state, action,
      reason, actor_id, request_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    generateId('rre'),
    ruleVersionId,
    fromState,
    toState,
    action,
    reason,
    actor.adminId,
    actor.requestId,
    nowIso,
  )
}

function guardedRuleEvent(
  db: D1Database,
  ruleVersionId: string,
  token: string,
  fromState: string | null,
  toState: string,
  action: string,
  reason: string,
  actor: AdminActor,
  nowIso: string,
) {
  return db.prepare(`
    INSERT INTO app_recommendation_rule_events (
      event_id, rule_version_id, from_state, to_state, action,
      reason, actor_id, request_id, created_at
    )
    SELECT ?, rule_version_id, ?, ?, ?, ?, ?, ?, ?
    FROM app_recommendation_rule_versions
    WHERE rule_version_id = ? AND mutation_token = ?
  `).bind(
    generateId('rre'),
    fromState,
    toState,
    action,
    reason,
    actor.adminId,
    actor.requestId,
    nowIso,
    ruleVersionId,
    token,
  )
}

function guardedRuleAudit(
  db: D1Database,
  ruleVersionId: string,
  token: string,
  adminId: number,
  action: string,
  after: unknown,
  nowIso: string,
) {
  return db.prepare(`
    INSERT INTO admin_audit_logs (
      id, admin_id, action, target_type, target_id, before_value, after_value, created_at
    )
    SELECT ?, ?, ?, 'app_recommendation_rule', rule_version_id, NULL, ?, ?
    FROM app_recommendation_rule_versions
    WHERE rule_version_id = ? AND mutation_token = ?
  `).bind(generateId('log'), adminId, action, JSON.stringify(after), nowIso, ruleVersionId, token)
}

function guardedPlacementAudit(
  db: D1Database,
  placementId: string,
  token: string,
  adminId: number,
  action: string,
  after: unknown,
  nowIso: string,
) {
  return db.prepare(`
    INSERT INTO admin_audit_logs (
      id, admin_id, action, target_type, target_id, before_value, after_value, created_at
    )
    SELECT ?, ?, ?, 'app_recommendation_placement', placement_id, NULL, ?, ?
    FROM app_recommendation_editorial_placements
    WHERE placement_id = ? AND mutation_token = ?
  `).bind(generateId('log'), adminId, action, JSON.stringify(after), nowIso, placementId, token)
}

function directAudit(
  db: D1Database,
  adminId: number,
  action: string,
  targetType: string,
  targetId: string,
  before: unknown,
  after: unknown,
  nowIso: string,
) {
  return db.prepare(`
    INSERT INTO admin_audit_logs (
      id, admin_id, action, target_type, target_id, before_value, after_value, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    generateId('log'),
    adminId,
    action,
    targetType,
    targetId,
    before === null ? null : JSON.stringify(before),
    after === null ? null : JSON.stringify(after),
    nowIso,
  )
}

type Idempotency = { keyHash: string; requestHash: string; action: string }

async function prepareIdempotency(value: string | null, action: string, request: unknown): Promise<Idempotency> {
  const key = value?.trim() ?? ''
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new AppRecommendationError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key 必须为 16 至 128 个可见 ASCII 字符')
  }
  return {
    keyHash: await sha256Hex(key),
    requestHash: await sha256Hex(JSON.stringify(request)),
    action,
  }
}

async function findAdminRequest(db: D1Database, adminId: number, keyHash: string) {
  return db.prepare(`
    SELECT action, request_hash, result_type, result_id
    FROM app_recommendation_admin_requests
    WHERE admin_id = ? AND idempotency_key_hash = ?
    LIMIT 1
  `).bind(adminId, keyHash).first<{
    action: string
    request_hash: string
    result_type: string
    result_id: string
  }>()
}

function insertAdminRequest(
  db: D1Database,
  adminId: number,
  idempotency: Idempotency,
  resultType: 'rule_version' | 'placement',
  resultId: string,
  nowIso: string,
) {
  return db.prepare(`
    INSERT INTO app_recommendation_admin_requests (
      admin_id, idempotency_key_hash, action, request_hash,
      result_type, result_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    adminId,
    idempotency.keyHash,
    idempotency.action,
    idempotency.requestHash,
    resultType,
    resultId,
    nowIso,
  )
}

async function replayRule(
  db: D1Database,
  row: { action: string; request_hash: string; result_type: string; result_id: string },
  idempotency: Idempotency,
) {
  assertReplay(row, idempotency, 'rule_version')
  return { rule: await getAdminRecommendationRule(db, row.result_id), replayed: true }
}

async function replayPlacement(
  db: D1Database,
  row: { action: string; request_hash: string; result_type: string; result_id: string },
  idempotency: Idempotency,
) {
  assertReplay(row, idempotency, 'placement')
  return { placement: await getAdminEditorialPlacement(db, row.result_id), replayed: true }
}

function assertReplay(
  row: { action: string; request_hash: string; result_type: string },
  idempotency: Idempotency,
  resultType: string,
) {
  if (
    row.action !== idempotency.action
    || row.request_hash !== idempotency.requestHash
    || row.result_type !== resultType
  ) {
    throw new AppRecommendationError(409, 'IDEMPOTENCY_CONFLICT', '同一幂等键不能用于不同推荐运营请求')
  }
}

function transitionInput(value: unknown) {
  const object = requireObject<{ expectedVersion?: unknown; reason?: unknown }>(
    value,
    ['expectedVersion', 'reason'],
    '推荐状态变更',
  )
  return {
    expectedVersion: normalizeRecommendationExpectedVersion(object.expectedVersion),
    reason: requiredText(object.reason, 500, '操作原因'),
  }
}

function requireObject<T>(value: unknown, allowedKeys: readonly string[], label: string): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppRecommendationError(400, 'RECOMMENDATION_ADMIN_REQUEST_INVALID', `${label}请求必须为 JSON 对象`)
  }
  if (Object.keys(value).some(key => !allowedKeys.includes(key))) {
    throw new AppRecommendationError(400, 'RECOMMENDATION_ADMIN_REQUEST_INVALID', `${label}请求包含未支持字段`)
  }
  return value as T
}

function requiredText(value: unknown, maxLength: number, label: string) {
  if (typeof value !== 'string') {
    throw new AppRecommendationError(400, 'RECOMMENDATION_TEXT_INVALID', `${label}必须为字符串`)
  }
  const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' ')
  if (!normalized || [...normalized].length > maxLength || containsUnsafeText(normalized)) {
    throw new AppRecommendationError(400, 'RECOMMENDATION_TEXT_INVALID', `${label}必须为 1 至 ${maxLength} 个有效字符`)
  }
  return normalized
}

function optionalText(value: unknown, maxLength: number, label: string) {
  if (value === undefined || value === null || value === '') return null
  return requiredText(value, maxLength, label)
}

function integer(value: unknown, fallback: number, min: number, max: number, label: string) {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = typeof value === 'string' && /^\d{1,9}$/u.test(value) ? Number(value) : value
  if (!Number.isSafeInteger(parsed) || Number(parsed) < min || Number(parsed) > max) {
    throw new AppRecommendationError(400, 'RECOMMENDATION_NUMBER_INVALID', `${label}必须为 ${min} 至 ${max} 的整数`)
  }
  return Number(parsed)
}

function optionalVersionCode(value: unknown) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !VERSION_CODE_PATTERN.test(value.trim())) {
    throw new AppRecommendationError(400, 'RECOMMENDATION_VERSION_INVALID', '最低客户端版本格式无效')
  }
  return value.trim()
}

function requiredTimestamp(value: unknown, label: string) {
  const result = optionalTimestamp(value, label)
  if (!result) throw new AppRecommendationError(400, 'RECOMMENDATION_TIME_INVALID', `${label}不能为空`)
  return result
}

function optionalTimestamp(value: unknown, label: string) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new AppRecommendationError(400, 'RECOMMENDATION_TIME_INVALID', `${label}格式无效`)
  }
  return new Date(value).toISOString()
}

function optionalId(value: unknown, pattern: RegExp, label: string) {
  if (value === undefined || value === null || value === '') return null
  return requiredId(value, pattern, label)
}

function requiredId(value: unknown, pattern: RegExp, label: string) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new AppRecommendationError(400, 'RECOMMENDATION_REFERENCE_INVALID', `${label}格式无效`)
  }
  return value
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  }
  catch {
    throw new AppRecommendationError(503, 'RECOMMENDATION_DATA_INVALID', '推荐配置数据异常', true)
  }
}

function parseDryRun(value: string | null): null | {
  candidateCount: number
  emptyResultRisk: boolean
  [key: string]: unknown
} {
  if (!value) return null
  const parsed = parseJson(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const item = parsed as Record<string, unknown>
  if (!Number.isSafeInteger(item.candidateCount) || typeof item.emptyResultRisk !== 'boolean') return null
  return {
    ...item,
    candidateCount: Number(item.candidateCount),
    emptyResultRisk: item.emptyResultRisk,
  }
}

function containsUnsafeText(value: string) {
  return /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/u.test(value)
}

function assertActor(actor: AdminActor) {
  if (!Number.isSafeInteger(actor.adminId) || actor.adminId <= 0 || !['admin', 'owner'].includes(actor.role)) {
    throw new AppRecommendationError(403, 'RECOMMENDATION_ADMIN_REQUIRED', '需要有效推荐运营管理员身份')
  }
}

function requireOwner(actor: AdminActor) {
  assertActor(actor)
  if (actor.role !== 'owner') {
    throw new AppRecommendationError(403, 'RECOMMENDATION_APPROVAL_REQUIRED', '该操作需要 Owner 复核权限')
  }
}

function ruleNotFound() {
  return new AppRecommendationError(404, 'RECOMMENDATION_RULE_NOT_FOUND', '推荐规则版本不存在')
}

function ruleVersionConflict() {
  return new AppRecommendationError(409, 'RECOMMENDATION_RULE_VERSION_CONFLICT', '推荐规则版本已变化，请刷新后重试')
}

function placementNotFound() {
  return new AppRecommendationError(404, 'RECOMMENDATION_PLACEMENT_NOT_FOUND', '运营精选排期不存在')
}

function placementVersionConflict() {
  return new AppRecommendationError(409, 'RECOMMENDATION_PLACEMENT_VERSION_CONFLICT', '运营精选版本已变化，请刷新后重试')
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

const RULE_STATES = [
  'draft',
  'validating',
  'approved',
  'scheduled',
  'active',
  'paused',
  'retired',
  'rolled_back',
] as const

const PLACEMENT_STATES = [
  'draft',
  'pending_review',
  'approved',
  'scheduled',
  'active',
  'paused',
  'expired',
  'retired',
] as const

const CREATE_RULE_KEYS = [
  'mode',
  'name',
  'description',
  'taxonomyCatalogId',
  'heatVersionId',
  'weights',
  'reasonMap',
  'targetRegionCodes',
  'maxConsecutiveSameRegion',
  'maxConsecutiveSameTerm',
  'repeatExposureCap',
  'rolloutPercent',
  'minimumClientVersion',
  'effectiveAt',
  'expiresAt',
  'rollbackRuleVersionId',
] as const

const UPDATE_RULE_KEYS = ['expectedVersion', ...CREATE_RULE_KEYS.filter(key => key !== 'mode')] as const

const CREATE_PLACEMENT_KEYS = [
  'profileId',
  'priority',
  'regionCode',
  'reason',
  'startsAt',
  'endsAt',
] as const

const UPDATE_PLACEMENT_KEYS = ['expectedVersion', ...CREATE_PLACEMENT_KEYS] as const

const PLACEMENT_FIELDS = `
  placement_id, state, entry_point, profile_id, position_key, priority,
  region_code, channel, disclosure_code, disclosure_label, reason,
  starts_at, ends_at, version, created_by, updated_by, reviewed_by,
  created_at, updated_at, reviewed_at, activated_at, paused_at
`
