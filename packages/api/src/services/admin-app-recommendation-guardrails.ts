import { generateId } from '../utils/db'
import { containsUnsafeInvisibleCharacter } from '../utils/text-safety'
import {
  AppRecommendationError,
  normalizeRecommendationExpectedVersion,
  normalizeRecommendationRuleVersionId,
} from './app-recommendation-policy'

const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7E]{16,128}$/u
const POLICY_ID_PATTERN = /^rgp_[A-Za-z0-9_-]{1,92}$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const SOURCE_SNAPSHOT_REF_PATTERN =
  /^aggregate:recommendation:[A-Za-z0-9][A-Za-z0-9._:/-]{0,160}$/u
const SENSITIVE_SNAPSHOT_NAMESPACE_PATTERN =
  /(?:^|[:._/-])(account|auth|credential|email|person|phone|profile|secret|session|token|user|viewer)(?:[:._/-]|$)/iu
const SOURCE_KEY = 'recommendation_aggregate_v1'

export type RecommendationGuardrailActor = {
  adminId: number
  role: string
  requestId: string
}

type GuardrailControlRow = {
  control_id: string
  evaluation_enabled: number
  source_key: string
  source_decision_status: string
  retention_decision_status: string
  retention_days: number | null
  purge_enabled: number
  production_ready: number
  max_snapshot_age_minutes: number
  created_at: string
  updated_at: string
}

type GuardrailPolicyRow = {
  policy_id: string
  state: string
  name: string
  description: string | null
  source_key: string
  observation_window_minutes: number
  minimum_sample_size: number
  minimum_observation_count: number
  consecutive_breach_count: number
  metric_definitions_json: string
  production_ready: number
  lock_version: number
  mutation_token: string | null
  created_by: number
  updated_by: number
  reviewed_by: number | null
  retired_by: number | null
  created_at: string
  updated_at: string
  reviewed_at: string | null
  retired_at: string | null
}

type GuardrailEvaluationRow = {
  evaluation_id: string
  rule_version_id: string
  policy_id: string
  policy_digest: string
  source_key: string
  source_snapshot_ref: string
  source_snapshot_sha256: string
  request_hash: string
  window_start: string
  window_end: string
  captured_at: string
  sample_size: number
  observation_ordinal: number
  status: string
  blocking_reason_code: string | null
  target_met_count: number
  target_missed_count: number
  warning_count: number
  stop_breach_count: number
  evaluated_by: number
  created_at: string
}

type RecommendationRuleGuardrailRow = {
  rule_version_id: string
  state: string
  rollout_percent: number
  rollback_rule_version_id: string | null
  guardrail_policy_id: string | null
  lock_version: number
}

type MetricKind = 'target' | 'guardrail'
type MetricUnit = 'ppm' | 'milliseconds'
type MetricComparator = 'gte' | 'lte'
type MetricSeverity = 'warning' | 'stop'

type MetricCatalogItem = {
  label: string
  kind: MetricKind
  unit: MetricUnit
  comparator: MetricComparator
  maximum: number
}

type MetricDefinition = MetricCatalogItem & {
  code: string
  threshold: number
  severity: MetricSeverity | null
}

type NormalizedPolicyDraft = {
  name: string
  description: string | null
  observationWindowMinutes: number
  minimumSampleSize: number
  minimumObservationCount: number
  consecutiveBreachCount: number
  metrics: MetricDefinition[]
  productionReady: boolean
}

type NormalizedMetricObservation = {
  code: string
  numerator: number | null
  denominator: number | null
  value: number | null
}

type MetricResult = MetricDefinition & {
  numerator: number | null
  denominator: number | null
  measuredValue: number | null
  outcome: 'met' | 'missed' | 'healthy' | 'warning' | 'breached' | 'unavailable'
}

const METRIC_CATALOG: Readonly<Record<string, MetricCatalogItem>> = {
  qualified_candidate_coverage_ppm: {
    label: '合格候选覆盖率', kind: 'target', unit: 'ppm', comparator: 'gte', maximum: 1_000_000,
  },
  profile_visit_rate_ppm: {
    label: '详情访问率', kind: 'target', unit: 'ppm', comparator: 'gte', maximum: 1_000_000,
  },
  interaction_conversion_rate_ppm: {
    label: '互动转化率', kind: 'target', unit: 'ppm', comparator: 'gte', maximum: 1_000_000,
  },
  reason_coverage_rate_ppm: {
    label: '推荐理由覆盖率', kind: 'target', unit: 'ppm', comparator: 'gte', maximum: 1_000_000,
  },
  report_rate_ppm: {
    label: '举报率', kind: 'guardrail', unit: 'ppm', comparator: 'lte', maximum: 1_000_000,
  },
  block_rate_ppm: {
    label: '拉黑率', kind: 'guardrail', unit: 'ppm', comparator: 'lte', maximum: 1_000_000,
  },
  disclosure_complaint_rate_ppm: {
    label: '披露投诉率', kind: 'guardrail', unit: 'ppm', comparator: 'lte', maximum: 1_000_000,
  },
  repeat_exposure_rate_ppm: {
    label: '重复曝光率', kind: 'guardrail', unit: 'ppm', comparator: 'lte', maximum: 1_000_000,
  },
  empty_result_rate_ppm: {
    label: '无结果率', kind: 'guardrail', unit: 'ppm', comparator: 'lte', maximum: 1_000_000,
  },
  supply_concentration_rate_ppm: {
    label: '供给集中度', kind: 'guardrail', unit: 'ppm', comparator: 'lte', maximum: 1_000_000,
  },
  latency_p95_ms: {
    label: '推荐 P95 延迟', kind: 'guardrail', unit: 'milliseconds', comparator: 'lte', maximum: 600_000,
  },
}

export async function getAdminRecommendationGuardrailOverview(db: D1Database) {
  const [control, policyCounts, evaluationCounts, activeGap, blocked] = await Promise.all([
    loadGuardrailControl(db),
    db.prepare(`
      SELECT state, COUNT(*) AS count
      FROM app_recommendation_guardrail_policies
      GROUP BY state
    `).all<{ state: string; count: number }>(),
    db.prepare(`
      SELECT status, COUNT(*) AS count
      FROM app_recommendation_guardrail_evaluations
      GROUP BY status
    `).all<{ status: string; count: number }>(),
    db.prepare(`
      SELECT COUNT(*) AS count
      FROM app_recommendation_rule_versions rule
      WHERE rule.state IN ('active', 'scheduled')
        AND rule.rollout_percent BETWEEN 1 AND 99
        AND (
          rule.guardrail_policy_id IS NULL
          OR NOT EXISTS (
            SELECT 1
            FROM app_recommendation_guardrail_policies policy
            WHERE policy.policy_id = rule.guardrail_policy_id
              AND policy.state = 'approved'
          )
        )
    `).first<{ count: number }>(),
    db.prepare('SELECT COUNT(*) AS count FROM app_recommendation_guardrail_blocks')
      .first<{ count: number }>(),
  ])
  return {
    control: mapControl(control),
    policyCounts: Object.fromEntries(policyCounts.results.map(item => [item.state, Number(item.count)])),
    evaluationCounts: Object.fromEntries(evaluationCounts.results.map(item => [item.status, Number(item.count)])),
    activeOrScheduledRulesMissingGuardrail: Number(activeGap?.count ?? 0),
    permanentlyBlockedRuleCount: Number(blocked?.count ?? 0),
    metricCatalog: Object.entries(METRIC_CATALOG).map(([code, item]) => ({ code, ...item })),
  }
}

export async function listAdminRecommendationGuardrailPolicies(
  db: D1Database,
  stateValue?: unknown,
) {
  const state = normalizeOptionalPolicyState(stateValue)
  const rows = await db.prepare(`
    SELECT ${POLICY_FIELDS}
    FROM app_recommendation_guardrail_policies
    WHERE (? IS NULL OR state = ?)
    ORDER BY updated_at DESC, policy_id ASC
    LIMIT 200
  `).bind(state, state).all<GuardrailPolicyRow>()
  return rows.results.map(mapPolicy)
}

export async function getAdminRecommendationGuardrailPolicy(
  db: D1Database,
  policyIdValue: unknown,
) {
  const policyId = normalizePolicyId(policyIdValue)
  const [policy, events, usage] = await Promise.all([
    findPolicy(db, policyId),
    db.prepare(`
      SELECT event_id, from_state, to_state, action, reason, actor_id, request_id, created_at
      FROM app_recommendation_guardrail_policy_events
      WHERE policy_id = ?
      ORDER BY created_at DESC, event_id ASC
      LIMIT 100
    `).bind(policyId).all<{
      event_id: string
      from_state: string | null
      to_state: string
      action: string
      reason: string
      actor_id: number
      request_id: string | null
      created_at: string
    }>(),
    db.prepare(`
      SELECT
        SUM(CASE WHEN state IN ('active', 'scheduled') THEN 1 ELSE 0 END) AS live_count,
        COUNT(*) AS total_count
      FROM app_recommendation_rule_versions
      WHERE guardrail_policy_id = ?
    `).bind(policyId).first<{ live_count: number | null; total_count: number }>(),
  ])
  if (!policy) throw policyNotFound()
  return {
    ...mapPolicy(policy),
    usage: {
      liveRuleCount: Number(usage?.live_count ?? 0),
      totalRuleCount: Number(usage?.total_count ?? 0),
    },
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

export async function createAdminRecommendationGuardrailPolicy(
  db: D1Database,
  inputValue: unknown,
  idempotencyKeyValue: string | null,
  actor: RecommendationGuardrailActor,
  now = new Date(),
) {
  assertActor(actor)
  const input = requireObject<Record<string, unknown>>(inputValue, CREATE_POLICY_KEYS, '推荐守护策略')
  const draft = normalizePolicyDraft(input, actor)
  const idempotency = await prepareIdempotency(idempotencyKeyValue, 'guardrail.policy.create', draft)
  const replay = await findRequest(db, actor.adminId, idempotency.keyHash)
  if (replay) return replayPolicy(db, replay, idempotency)
  const policyId = generateId('rgp')
  const nowIso = now.toISOString()
  try {
    await db.batch([
      db.prepare(`
        INSERT INTO app_recommendation_guardrail_policies (
          policy_id, state, name, description, source_key,
          observation_window_minutes, minimum_sample_size,
          minimum_observation_count, consecutive_breach_count,
          metric_definitions_json, production_ready, lock_version, mutation_token,
          created_by, updated_by, reviewed_by, retired_by,
          created_at, updated_at, reviewed_at, retired_at
        ) VALUES (
          ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL,
          ?, ?, NULL, NULL, ?, ?, NULL, NULL
        )
      `).bind(
        policyId,
        draft.name,
        draft.description,
        SOURCE_KEY,
        draft.observationWindowMinutes,
        draft.minimumSampleSize,
        draft.minimumObservationCount,
        draft.consecutiveBreachCount,
        JSON.stringify(draft.metrics),
        draft.productionReady ? 1 : 0,
        actor.adminId,
        actor.adminId,
        nowIso,
        nowIso,
      ),
      policyEvent(db, policyId, null, 'draft', 'create', '创建推荐灰度守护策略草稿', actor, nowIso),
      insertRequest(db, actor.adminId, idempotency, 'policy', policyId, nowIso),
      directAudit(db, actor.adminId, 'recommendation_guardrail_policy_create', 'app_recommendation_guardrail_policy', policyId, null, {
        sourceKey: SOURCE_KEY,
        metricCodes: draft.metrics.map(item => item.code),
        productionReady: draft.productionReady,
      }, nowIso),
    ])
  }
  catch (error) {
    const raced = await findRequest(db, actor.adminId, idempotency.keyHash)
    if (raced) return replayPolicy(db, raced, idempotency)
    throw error
  }
  return { policy: await getAdminRecommendationGuardrailPolicy(db, policyId), replayed: false }
}

export async function updateAdminRecommendationGuardrailPolicy(
  db: D1Database,
  policyIdValue: unknown,
  inputValue: unknown,
  actor: RecommendationGuardrailActor,
  now = new Date(),
) {
  assertActor(actor)
  const policyId = normalizePolicyId(policyIdValue)
  const input = requireObject<Record<string, unknown>>(inputValue, UPDATE_POLICY_KEYS, '推荐守护策略更新')
  const expectedVersion = normalizeRecommendationExpectedVersion(input.expectedVersion)
  const current = await findPolicy(db, policyId)
  if (!current) throw policyNotFound()
  if (current.lock_version !== expectedVersion) throw policyVersionConflict()
  if (current.state !== 'draft') {
    throw new AppRecommendationError(409, 'RECOMMENDATION_GUARDRAIL_POLICY_IMMUTABLE', '只有草稿守护策略可以编辑')
  }
  const currentMetrics = parseMetricDefinitions(current.metric_definitions_json)
  const draft = normalizePolicyDraft({
    name: input.name ?? current.name,
    description: input.description === undefined ? current.description : input.description,
    observationWindowMinutes: input.observationWindowMinutes ?? current.observation_window_minutes,
    minimumSampleSize: input.minimumSampleSize ?? current.minimum_sample_size,
    minimumObservationCount: input.minimumObservationCount ?? current.minimum_observation_count,
    consecutiveBreachCount: input.consecutiveBreachCount ?? current.consecutive_breach_count,
    metrics: input.metrics ?? currentMetrics.map(({ code, threshold, severity }) => ({ code, threshold, severity })),
    productionReady: input.productionReady ?? (current.production_ready === 1),
  }, actor)
  const token = crypto.randomUUID()
  const nowIso = now.toISOString()
  await db.batch([
    db.prepare(`
      UPDATE app_recommendation_guardrail_policies
      SET name = ?, description = ?, observation_window_minutes = ?,
          minimum_sample_size = ?, minimum_observation_count = ?,
          consecutive_breach_count = ?, metric_definitions_json = ?,
          production_ready = ?, lock_version = lock_version + 1,
          mutation_token = ?, updated_by = ?, updated_at = ?
      WHERE policy_id = ? AND state = 'draft' AND lock_version = ?
    `).bind(
      draft.name,
      draft.description,
      draft.observationWindowMinutes,
      draft.minimumSampleSize,
      draft.minimumObservationCount,
      draft.consecutiveBreachCount,
      JSON.stringify(draft.metrics),
      draft.productionReady ? 1 : 0,
      token,
      actor.adminId,
      nowIso,
      policyId,
      expectedVersion,
    ),
    guardedPolicyAudit(db, policyId, token, actor.adminId, 'recommendation_guardrail_policy_update', {
      beforeVersion: expectedVersion,
      afterVersion: expectedVersion + 1,
      metricCodes: draft.metrics.map(item => item.code),
    }, nowIso),
  ])
  if (!await findPolicyByToken(db, policyId, token)) throw policyVersionConflict()
  return getAdminRecommendationGuardrailPolicy(db, policyId)
}

export async function submitAdminRecommendationGuardrailPolicy(
  db: D1Database,
  policyIdValue: unknown,
  inputValue: unknown,
  actor: RecommendationGuardrailActor,
  now = new Date(),
) {
  const policyId = normalizePolicyId(policyIdValue)
  const input = transitionInput(inputValue)
  const current = await requirePolicyState(db, policyId, input.expectedVersion, ['draft'])
  parseMetricDefinitions(current.metric_definitions_json)
  return transitionPolicy(db, current, 'pending_review', 'submit', input.reason, actor, now)
}

export async function decideAdminRecommendationGuardrailPolicy(
  db: D1Database,
  policyIdValue: unknown,
  inputValue: unknown,
  actor: RecommendationGuardrailActor,
  now = new Date(),
) {
  requireOwner(actor)
  const policyId = normalizePolicyId(policyIdValue)
  const input = requireObject<Record<string, unknown>>(
    inputValue,
    ['expectedVersion', 'decision', 'reason'],
    '推荐守护策略复核',
  )
  const expectedVersion = normalizeRecommendationExpectedVersion(input.expectedVersion)
  const reason = requiredText(input.reason, 500, '复核原因')
  if (input.decision !== 'approve' && input.decision !== 'reject') {
    throw new AppRecommendationError(400, 'RECOMMENDATION_GUARDRAIL_DECISION_INVALID', '复核决定必须为 approve 或 reject')
  }
  const current = await requirePolicyState(db, policyId, expectedVersion, ['pending_review'])
  if (current.created_by === actor.adminId) {
    throw new AppRecommendationError(403, 'RECOMMENDATION_GUARDRAIL_REVIEW_SEPARATION_REQUIRED', '守护策略创建人与复核人必须分离')
  }
  parseMetricDefinitions(current.metric_definitions_json)
  return transitionPolicy(
    db,
    current,
    input.decision === 'approve' ? 'approved' : 'draft',
    String(input.decision),
    reason,
    actor,
    now,
    { reviewed: true },
  )
}

export async function retireAdminRecommendationGuardrailPolicy(
  db: D1Database,
  policyIdValue: unknown,
  inputValue: unknown,
  actor: RecommendationGuardrailActor,
  now = new Date(),
) {
  requireOwner(actor)
  const policyId = normalizePolicyId(policyIdValue)
  const input = transitionInput(inputValue)
  const current = await requirePolicyState(db, policyId, input.expectedVersion, ['approved'])
  const inUse = await db.prepare(`
    SELECT rule_version_id
    FROM app_recommendation_rule_versions
    WHERE guardrail_policy_id = ? AND state IN ('active', 'scheduled')
    LIMIT 1
  `).bind(policyId).first<{ rule_version_id: string }>()
  if (inUse) {
    throw new AppRecommendationError(
      409,
      'RECOMMENDATION_GUARDRAIL_POLICY_IN_USE',
      '仍有生效或待生效规则引用该守护策略，不能退休',
      false,
      { ruleVersionId: inUse.rule_version_id },
    )
  }
  return transitionPolicy(db, current, 'retired', 'retire', input.reason, actor, now, { retired: true })
}

export async function assertRecommendationGuardrailForActivation(
  db: D1Database,
  rule: Pick<RecommendationRuleGuardrailRow,
    'rule_version_id' | 'rollout_percent' | 'guardrail_policy_id'>,
  requireProductionReady: boolean,
) {
  const block = await findRuleBlock(db, rule.rule_version_id)
  if (block) {
    throw new AppRecommendationError(
      409,
      'RECOMMENDATION_GUARDRAIL_RULE_BLOCKED',
      '该规则版本已命中不可变停止条件，不能再次进入投放；请复制并重新复核新版本',
      false,
      { evaluationId: block.evaluation_id, reasonCode: block.reason_code },
    )
  }
  if (rule.rollout_percent >= 100 || rule.rollout_percent <= 0) return
  if (!rule.guardrail_policy_id) {
    throw new AppRecommendationError(
      422,
      'RECOMMENDATION_GUARDRAIL_POLICY_REQUIRED',
      '小于 100% 的推荐灰度必须绑定经独立复核的目标与反指标守护策略',
    )
  }
  const [control, policy] = await Promise.all([
    loadGuardrailControl(db),
    findPolicy(db, rule.guardrail_policy_id),
  ])
  assertControlReady(control, requireProductionReady)
  if (!policy || policy.state !== 'approved' || policy.source_key !== control.source_key) {
    throw new AppRecommendationError(422, 'RECOMMENDATION_GUARDRAIL_POLICY_NOT_READY', '规则绑定的推荐守护策略尚未批准或来源不一致')
  }
  parseMetricDefinitions(policy.metric_definitions_json)
  if (requireProductionReady && policy.production_ready !== 1) {
    throw new AppRecommendationError(403, 'RECOMMENDATION_GUARDRAIL_POLICY_PRODUCTION_NOT_READY', '推荐守护策略尚未通过生产门禁')
  }
}

export async function evaluateAdminRecommendationGuardrail(
  db: D1Database,
  ruleVersionIdValue: unknown,
  inputValue: unknown,
  idempotencyKeyValue: string | null,
  actor: RecommendationGuardrailActor,
  requireProductionReady: boolean,
  now = new Date(),
) {
  requireOwner(actor)
  const ruleVersionId = normalizeRecommendationRuleVersionId(ruleVersionIdValue)
  const rule = await findRule(db, ruleVersionId)
  if (!rule) throw new AppRecommendationError(404, 'RECOMMENDATION_RULE_NOT_FOUND', '推荐规则版本不存在')
  if (!rule.guardrail_policy_id) {
    throw new AppRecommendationError(422, 'RECOMMENDATION_GUARDRAIL_POLICY_REQUIRED', '推荐规则未绑定守护策略')
  }
  const policy = await findPolicy(db, rule.guardrail_policy_id)
  if (!policy) throw policyNotFound()
  const definitions = parseMetricDefinitions(policy.metric_definitions_json)
  const input = normalizeEvaluationInput(inputValue, definitions)
  if (rule.lock_version !== input.expectedRuleVersion) {
    throw new AppRecommendationError(409, 'RECOMMENDATION_RULE_VERSION_CONFLICT', '推荐规则版本已变化，请刷新后重试')
  }
  const normalizedRequest = {
    ruleVersionId,
    expectedRuleVersion: input.expectedRuleVersion,
    sourceSnapshotRef: input.sourceSnapshotRef,
    sourceSnapshotSha256: input.sourceSnapshotSha256,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    capturedAt: input.capturedAt,
    sampleSize: input.sampleSize,
    metrics: input.metrics,
  }
  const idempotency = await prepareIdempotency(
    idempotencyKeyValue,
    'guardrail.evaluation.create',
    normalizedRequest,
  )
  const replay = await findRequest(db, actor.adminId, idempotency.keyHash)
  if (replay) return replayEvaluation(db, replay, idempotency)
  const duplicateSnapshot = await findEvaluationBySnapshot(
    db,
    ruleVersionId,
    input.sourceSnapshotRef,
  )
  if (duplicateSnapshot) {
    if (
      duplicateSnapshot.source_snapshot_sha256 !== input.sourceSnapshotSha256
      || duplicateSnapshot.request_hash !== idempotency.requestHash
    ) {
      throw new AppRecommendationError(409, 'RECOMMENDATION_GUARDRAIL_SNAPSHOT_CONFLICT', '同一来源快照引用不能对应不同内容')
    }
    return {
      evaluation: await getAdminRecommendationGuardrailEvaluation(db, duplicateSnapshot.evaluation_id),
      replayed: true,
    }
  }
  if (rule.state !== 'active' || rule.rollout_percent <= 0 || rule.rollout_percent >= 100) {
    throw new AppRecommendationError(409, 'RECOMMENDATION_GUARDRAIL_RULE_STATE_INVALID', '只有正在执行的部分灰度规则可以写入守护评估')
  }
  if (!rule.rollback_rule_version_id) {
    throw new AppRecommendationError(422, 'RECOMMENDATION_ROLLOUT_FALLBACK_REQUIRED', '灰度规则缺少已登记回退版本')
  }
  if (policy.state !== 'approved') {
    throw new AppRecommendationError(422, 'RECOMMENDATION_GUARDRAIL_POLICY_NOT_READY', '推荐守护策略尚未批准')
  }
  const control = await loadGuardrailControl(db)
  assertControlReady(control, requireProductionReady)
  if (policy.source_key !== control.source_key) {
    throw new AppRecommendationError(422, 'RECOMMENDATION_GUARDRAIL_SOURCE_MISMATCH', '守护策略与当前批准聚合来源不一致')
  }
  if (requireProductionReady && policy.production_ready !== 1) {
    throw new AppRecommendationError(403, 'RECOMMENDATION_GUARDRAIL_POLICY_PRODUCTION_NOT_READY', '推荐守护策略尚未通过生产门禁')
  }
  if (await findRuleBlock(db, ruleVersionId)) {
    throw new AppRecommendationError(409, 'RECOMMENDATION_GUARDRAIL_RULE_BLOCKED', '该规则版本已经命中停止条件')
  }
  validateEvaluationTimes(input, policy, control, now)
  const previous = await db.prepare(`
    SELECT COUNT(*) AS count
    FROM app_recommendation_guardrail_evaluations
    WHERE rule_version_id = ? AND policy_id = ?
  `).bind(ruleVersionId, policy.policy_id).first<{ count: number }>()
  const ordinal = Number(previous?.count ?? 0) + 1
  const metricResults = calculateMetricResults(definitions, input.metrics)
  const missing = metricResults.filter(item => item.outcome === 'unavailable')
  const mature = input.sampleSize >= policy.minimum_sample_size
    && ordinal >= policy.minimum_observation_count
  const currentStopCodes = metricResults
    .filter(item => item.outcome === 'breached' && item.severity === 'stop')
    .map(item => item.code)
  const consecutiveStopCodes = mature
    ? (await Promise.all(currentStopCodes.map(async code => ({
        code,
        ready: await hasConsecutiveStopBreaches(
          db,
          ruleVersionId,
          policy.policy_id,
          code,
          policy.consecutive_breach_count - 1,
        ),
      })))).filter(item => item.ready).map(item => item.code)
    : []
  const targetMetCount = metricResults.filter(item => item.outcome === 'met').length
  const targetMissedCount = metricResults.filter(item => item.outcome === 'missed').length
  const warningCount = metricResults.filter(item => item.outcome === 'warning').length
  const stopBreachCount = currentStopCodes.length
  const statusAndReason = evaluationStatus({
    mature,
    missingCodes: missing.map(item => item.code),
    consecutiveStopCodes,
    currentStopCodes,
    warningCount,
    targetMissedCount,
  })
  const evaluationId = generateId('rge')
  const nowIso = now.toISOString()
  const policyDigest = await sha256Hex(JSON.stringify({
    policyId: policy.policy_id,
    sourceKey: policy.source_key,
    observationWindowMinutes: policy.observation_window_minutes,
    minimumSampleSize: policy.minimum_sample_size,
    minimumObservationCount: policy.minimum_observation_count,
    consecutiveBreachCount: policy.consecutive_breach_count,
    metrics: definitions,
  }))
  const statements: D1PreparedStatement[] = [
    db.prepare(`
      INSERT INTO app_recommendation_guardrail_evaluations (
        evaluation_id, rule_version_id, policy_id, policy_digest,
        source_key, source_snapshot_ref, source_snapshot_sha256, request_hash,
        window_start, window_end, captured_at, sample_size, observation_ordinal,
        status, blocking_reason_code, target_met_count, target_missed_count,
        warning_count, stop_breach_count, evaluated_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      evaluationId,
      ruleVersionId,
      policy.policy_id,
      policyDigest,
      control.source_key,
      input.sourceSnapshotRef,
      input.sourceSnapshotSha256,
      idempotency.requestHash,
      input.windowStart,
      input.windowEnd,
      input.capturedAt,
      input.sampleSize,
      ordinal,
      statusAndReason.status,
      statusAndReason.reasonCode,
      targetMetCount,
      targetMissedCount,
      warningCount,
      stopBreachCount,
      actor.adminId,
      nowIso,
    ),
  ]
  for (const result of metricResults) {
    statements.push(db.prepare(`
      INSERT INTO app_recommendation_guardrail_metric_results (
        evaluation_id, metric_code, metric_kind, unit, comparator,
        threshold_value, numerator, denominator, measured_value, severity, outcome
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      evaluationId,
      result.code,
      result.kind,
      result.unit,
      result.comparator,
      result.threshold,
      result.numerator,
      result.denominator,
      result.measuredValue,
      result.severity,
      result.outcome,
    ))
  }
  let blockId: string | null = null
  if (statusAndReason.reasonCode) {
    blockId = generateId('rgb')
    statements.push(
      db.prepare(`
        INSERT INTO app_recommendation_guardrail_blocks (
          block_id, rule_version_id, policy_id, evaluation_id,
          rollback_rule_version_id, reason_code, triggered_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        blockId,
        ruleVersionId,
        policy.policy_id,
        evaluationId,
        rule.rollback_rule_version_id,
        statusAndReason.reasonCode,
        actor.adminId,
        nowIso,
      ),
      directAudit(db, actor.adminId, 'recommendation_guardrail_block', 'app_recommendation_rule', ruleVersionId, null, {
        evaluationId,
        policyId: policy.policy_id,
        rollbackRuleVersionId: rule.rollback_rule_version_id,
        reasonCode: statusAndReason.reasonCode,
        deliveryBehavior: 'exclude_rule_and_use_registered_fallback',
      }, nowIso),
    )
  }
  statements.push(
    insertRequest(db, actor.adminId, idempotency, 'evaluation', evaluationId, nowIso),
    directAudit(db, actor.adminId, 'recommendation_guardrail_evaluate', 'app_recommendation_guardrail_evaluation', evaluationId, null, {
      ruleVersionId,
      policyId: policy.policy_id,
      sourceSnapshotRef: input.sourceSnapshotRef,
      sourceSnapshotSha256: input.sourceSnapshotSha256,
      status: statusAndReason.status,
      blockingReasonCode: statusAndReason.reasonCode,
      metricCount: metricResults.length,
      sampleSize: input.sampleSize,
      observationOrdinal: ordinal,
      blockId,
    }, nowIso),
  )
  try {
    await db.batch(statements)
  }
  catch (error) {
    const raced = await findRequest(db, actor.adminId, idempotency.keyHash)
    if (raced) return replayEvaluation(db, raced, idempotency)
    const snapshotRace = await findEvaluationBySnapshot(
      db,
      ruleVersionId,
      input.sourceSnapshotRef,
    )
    if (snapshotRace) {
      if (
        snapshotRace.source_snapshot_sha256 !== input.sourceSnapshotSha256
        || snapshotRace.request_hash !== idempotency.requestHash
      ) {
        throw new AppRecommendationError(
          409,
          'RECOMMENDATION_GUARDRAIL_SNAPSHOT_CONFLICT',
          '同一来源快照引用不能对应不同内容',
        )
      }
      return {
        evaluation: await getAdminRecommendationGuardrailEvaluation(db, snapshotRace.evaluation_id),
        replayed: true,
      }
    }
    const ordinalRace = await db.prepare(`
      SELECT evaluation_id
      FROM app_recommendation_guardrail_evaluations
      WHERE rule_version_id = ? AND policy_id = ? AND observation_ordinal = ?
      LIMIT 1
    `).bind(ruleVersionId, policy.policy_id, ordinal).first<{ evaluation_id: string }>()
    if (ordinalRace) {
      throw new AppRecommendationError(
        409,
        'RECOMMENDATION_GUARDRAIL_EVALUATION_RACE',
        '已有更新的推荐守护评估写入，请刷新规则版本后重试',
        true,
        { competingEvaluationId: ordinalRace.evaluation_id },
      )
    }
    const blockRace = await findRuleBlock(db, ruleVersionId)
    if (blockRace) {
      throw new AppRecommendationError(
        409,
        'RECOMMENDATION_GUARDRAIL_RULE_BLOCKED',
        '该规则版本已由另一份评估命中停止条件',
        false,
        { evaluationId: blockRace.evaluation_id, reasonCode: blockRace.reason_code },
      )
    }
    throw error
  }
  return {
    evaluation: await getAdminRecommendationGuardrailEvaluation(db, evaluationId),
    replayed: false,
  }
}

export async function getAdminRecommendationGuardrailEvaluation(
  db: D1Database,
  evaluationIdValue: unknown,
) {
  const evaluationId = normalizeEvaluationId(evaluationIdValue)
  const [row, metrics, block] = await Promise.all([
    db.prepare(`
      SELECT ${EVALUATION_FIELDS}
      FROM app_recommendation_guardrail_evaluations
      WHERE evaluation_id = ?
      LIMIT 1
    `).bind(evaluationId).first<GuardrailEvaluationRow>(),
    db.prepare(`
      SELECT metric_code, metric_kind, unit, comparator, threshold_value,
             numerator, denominator, measured_value, severity, outcome
      FROM app_recommendation_guardrail_metric_results
      WHERE evaluation_id = ?
      ORDER BY metric_code ASC
    `).bind(evaluationId).all<{
      metric_code: string
      metric_kind: string
      unit: string
      comparator: string
      threshold_value: number
      numerator: number | null
      denominator: number | null
      measured_value: number | null
      severity: string | null
      outcome: string
    }>(),
    db.prepare(`
      SELECT block_id, rollback_rule_version_id, reason_code, triggered_by, created_at
      FROM app_recommendation_guardrail_blocks
      WHERE evaluation_id = ?
      LIMIT 1
    `).bind(evaluationId).first<{
      block_id: string
      rollback_rule_version_id: string
      reason_code: string
      triggered_by: number
      created_at: string
    }>(),
  ])
  if (!row) {
    throw new AppRecommendationError(404, 'RECOMMENDATION_GUARDRAIL_EVALUATION_NOT_FOUND', '推荐守护评估不存在')
  }
  return {
    evaluationId: row.evaluation_id,
    ruleVersionId: row.rule_version_id,
    policyId: row.policy_id,
    policyDigest: row.policy_digest,
    source: {
      key: row.source_key,
      snapshotRef: row.source_snapshot_ref,
      snapshotSha256: row.source_snapshot_sha256,
    },
    window: { start: row.window_start, end: row.window_end, capturedAt: row.captured_at },
    sampleSize: row.sample_size,
    observationOrdinal: row.observation_ordinal,
    status: row.status,
    blockingReasonCode: row.blocking_reason_code,
    counts: {
      targetMet: row.target_met_count,
      targetMissed: row.target_missed_count,
      warning: row.warning_count,
      stopBreach: row.stop_breach_count,
    },
    evaluatedBy: row.evaluated_by,
    createdAt: row.created_at,
    metrics: metrics.results.map(item => ({
      code: item.metric_code,
      kind: item.metric_kind,
      unit: item.unit,
      comparator: item.comparator,
      threshold: item.threshold_value,
      numerator: item.numerator,
      denominator: item.denominator,
      measuredValue: item.measured_value,
      severity: item.severity,
      outcome: item.outcome,
    })),
    block: block
      ? {
          blockId: block.block_id,
          rollbackRuleVersionId: block.rollback_rule_version_id,
          reasonCode: block.reason_code,
          triggeredBy: block.triggered_by,
          createdAt: block.created_at,
          deliveryBehavior: 'exclude_rule_and_use_registered_fallback',
        }
      : null,
  }
}

function normalizePolicyDraft(
  input: Record<string, unknown>,
  actor: RecommendationGuardrailActor,
): NormalizedPolicyDraft {
  const name = requiredText(input.name, 80, '策略名称')
  const description = optionalText(input.description, 500, '策略说明')
  const observationWindowMinutes = integer(input.observationWindowMinutes, 60, 5, 10080, '观察窗口分钟数')
  const minimumSampleSize = integer(input.minimumSampleSize, 100, 1, 1_000_000_000, '最小样本数')
  const minimumObservationCount = integer(input.minimumObservationCount, 2, 1, 100, '最小观察次数')
  const consecutiveBreachCount = integer(input.consecutiveBreachCount, 2, 1, 10, '连续越线次数')
  const metrics = normalizeMetricDefinitions(input.metrics)
  const productionReady = boolean(input.productionReady, false, '生产就绪标记')
  if (productionReady && actor.role !== 'owner') {
    throw new AppRecommendationError(403, 'RECOMMENDATION_GUARDRAIL_PRODUCTION_OWNER_REQUIRED', '只有 Owner 可以设置生产就绪候选')
  }
  return {
    name,
    description,
    observationWindowMinutes,
    minimumSampleSize,
    minimumObservationCount,
    consecutiveBreachCount,
    metrics,
    productionReady,
  }
}

function normalizeMetricDefinitions(value: unknown): MetricDefinition[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 32) {
    throw new AppRecommendationError(400, 'RECOMMENDATION_GUARDRAIL_METRICS_INVALID', '守护策略必须包含 2 至 32 个已登记指标')
  }
  const seen = new Set<string>()
  const definitions = value.map((item) => {
    const object = requireObject<Record<string, unknown>>(item, ['code', 'threshold', 'severity'], '推荐守护指标')
    const code = object.code
    if (typeof code !== 'string' || !METRIC_CATALOG[code]) {
      throw new AppRecommendationError(400, 'RECOMMENDATION_GUARDRAIL_METRIC_UNKNOWN', '守护策略包含未登记指标')
    }
    if (seen.has(code)) {
      throw new AppRecommendationError(400, 'RECOMMENDATION_GUARDRAIL_METRIC_DUPLICATE', '同一守护指标不能重复配置')
    }
    seen.add(code)
    const catalog = METRIC_CATALOG[code]!
    const threshold = integer(object.threshold, -1, 0, catalog.maximum, `${catalog.label}阈值`)
    let severity: MetricSeverity | null = null
    if (catalog.kind === 'guardrail') {
      if (object.severity !== 'warning' && object.severity !== 'stop') {
        throw new AppRecommendationError(400, 'RECOMMENDATION_GUARDRAIL_SEVERITY_INVALID', '反指标必须明确 warning 或 stop')
      }
      severity = object.severity
    }
    else if (object.severity !== undefined && object.severity !== null) {
      throw new AppRecommendationError(400, 'RECOMMENDATION_GUARDRAIL_SEVERITY_INVALID', '目标指标不能设置停止级别')
    }
    return { code, ...catalog, threshold, severity }
  }).sort((left, right) => left.code.localeCompare(right.code))
  if (!definitions.some(item => item.kind === 'target')) {
    throw new AppRecommendationError(422, 'RECOMMENDATION_GUARDRAIL_TARGET_REQUIRED', '灰度守护策略至少需要一个目标指标')
  }
  if (!definitions.some(item => item.kind === 'guardrail' && item.severity === 'stop')) {
    throw new AppRecommendationError(422, 'RECOMMENDATION_GUARDRAIL_STOP_REQUIRED', '灰度守护策略至少需要一个停止级反指标')
  }
  return definitions
}

function parseMetricDefinitions(value: string): MetricDefinition[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  }
  catch {
    throw invalidPolicyData()
  }
  if (!Array.isArray(parsed)) throw invalidPolicyData()
  try {
    return normalizeMetricDefinitions(parsed.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw invalidPolicyData()
      const object = item as Record<string, unknown>
      const code = typeof object.code === 'string' ? object.code : ''
      const catalog = METRIC_CATALOG[code]
      if (
        !catalog
        || object.label !== catalog.label
        || object.kind !== catalog.kind
        || object.unit !== catalog.unit
        || object.comparator !== catalog.comparator
        || object.maximum !== catalog.maximum
      ) throw invalidPolicyData()
      return { code: object.code, threshold: object.threshold, severity: object.severity }
    }))
  }
  catch (error) {
    if (error instanceof AppRecommendationError && error.status >= 500) throw error
    throw invalidPolicyData()
  }
}

function normalizeEvaluationInput(value: unknown, definitions: MetricDefinition[]) {
  const input = requireObject<Record<string, unknown>>(
    value,
    [
      'expectedRuleVersion',
      'sourceSnapshotRef',
      'sourceSnapshotSha256',
      'windowStart',
      'windowEnd',
      'capturedAt',
      'sampleSize',
      'metrics',
    ],
    '推荐守护评估',
  )
  const expectedRuleVersion = normalizeRecommendationExpectedVersion(input.expectedRuleVersion)
  const sourceSnapshotRef = normalizeSourceSnapshotRef(input.sourceSnapshotRef)
  const sourceSnapshotSha256 = normalizeSha256(input.sourceSnapshotSha256, '来源快照摘要')
  const windowStart = timestamp(input.windowStart, '观察窗口开始时间')
  const windowEnd = timestamp(input.windowEnd, '观察窗口结束时间')
  const capturedAt = timestamp(input.capturedAt, '快照生成时间')
  const sampleSize = integer(input.sampleSize, -1, 0, 1_000_000_000, '样本数')
  if (!Array.isArray(input.metrics) || input.metrics.length > 32) {
    throw new AppRecommendationError(400, 'RECOMMENDATION_GUARDRAIL_OBSERVATIONS_INVALID', '聚合指标必须为最多 32 项的数组')
  }
  const allowed = new Set(definitions.map(item => item.code))
  const seen = new Set<string>()
  const metrics: NormalizedMetricObservation[] = input.metrics.map((item) => {
    const object = requireObject<Record<string, unknown>>(item, ['code', 'numerator', 'denominator', 'value'], '聚合指标观测')
    const code = object.code
    if (typeof code !== 'string' || !allowed.has(code)) {
      throw new AppRecommendationError(400, 'RECOMMENDATION_GUARDRAIL_OBSERVATION_UNKNOWN', '观测包含策略未登记指标')
    }
    if (seen.has(code)) {
      throw new AppRecommendationError(400, 'RECOMMENDATION_GUARDRAIL_OBSERVATION_DUPLICATE', '同一聚合指标不能重复提交')
    }
    seen.add(code)
    const definition = definitions.find(candidate => candidate.code === code)!
    if (definition.unit === 'ppm') {
      const numerator = integer(object.numerator, -1, 0, 1_000_000_000, `${definition.label}分子`)
      const denominator = integer(object.denominator, -1, 1, 1_000_000_000, `${definition.label}分母`)
      if (numerator > denominator || object.value !== undefined) {
        throw new AppRecommendationError(400, 'RECOMMENDATION_GUARDRAIL_RATIO_INVALID', `${definition.label}必须使用不大于分母的聚合分子，且不能同时提交 value`)
      }
      return { code, numerator, denominator, value: null }
    }
    const metricValue = integer(object.value, -1, 0, definition.maximum, definition.label)
    if (object.numerator !== undefined || object.denominator !== undefined) {
      throw new AppRecommendationError(400, 'RECOMMENDATION_GUARDRAIL_SCALAR_INVALID', `${definition.label}只能提交 value`)
    }
    return { code, numerator: null, denominator: null, value: metricValue }
  }).sort((left, right) => left.code.localeCompare(right.code))
  return {
    expectedRuleVersion,
    sourceSnapshotRef,
    sourceSnapshotSha256,
    windowStart,
    windowEnd,
    capturedAt,
    sampleSize,
    metrics,
  }
}

function calculateMetricResults(
  definitions: MetricDefinition[],
  observations: NormalizedMetricObservation[],
): MetricResult[] {
  const byCode = new Map(observations.map(item => [item.code, item]))
  return definitions.map((definition) => {
    const observation = byCode.get(definition.code)
    if (!observation) {
      return {
        ...definition,
        numerator: null,
        denominator: null,
        measuredValue: null,
        outcome: 'unavailable' as const,
      }
    }
    const measuredValue = definition.unit === 'ppm'
      ? Math.floor((observation.numerator! * 1_000_000) / observation.denominator!)
      : observation.value!
    const passed = definition.comparator === 'gte'
      ? measuredValue >= definition.threshold
      : measuredValue <= definition.threshold
    const outcome: MetricResult['outcome'] = definition.kind === 'target'
      ? (passed ? 'met' : 'missed')
      : passed
        ? 'healthy'
        : definition.severity === 'stop'
          ? 'breached'
          : 'warning'
    return {
      ...definition,
      numerator: observation.numerator,
      denominator: observation.denominator,
      measuredValue,
      outcome,
    }
  })
}

function evaluationStatus(input: {
  mature: boolean
  missingCodes: string[]
  consecutiveStopCodes: string[]
  currentStopCodes: string[]
  warningCount: number
  targetMissedCount: number
}): { status: GuardrailEvaluationRow['status']; reasonCode: string | null } {
  if (input.missingCodes.length > 0) {
    return { status: 'source_incomplete', reasonCode: 'guardrail_source_incomplete' }
  }
  if (!input.mature) return { status: 'observing', reasonCode: null }
  if (input.consecutiveStopCodes.length > 0) {
    return {
      status: 'breached',
      reasonCode: `guardrail_${input.consecutiveStopCodes[0]}`.slice(0, 80),
    }
  }
  if (input.currentStopCodes.length > 0 || input.warningCount > 0) {
    return { status: 'warning', reasonCode: null }
  }
  if (input.targetMissedCount > 0) return { status: 'target_missed', reasonCode: null }
  return { status: 'healthy', reasonCode: null }
}

async function hasConsecutiveStopBreaches(
  db: D1Database,
  ruleVersionId: string,
  policyId: string,
  metricCode: string,
  requiredPrevious: number,
) {
  if (requiredPrevious <= 0) return true
  const rows = await db.prepare(`
    SELECT metric.outcome
    FROM app_recommendation_guardrail_evaluations evaluation
    JOIN app_recommendation_guardrail_metric_results metric
      ON metric.evaluation_id = evaluation.evaluation_id
    WHERE evaluation.rule_version_id = ?
      AND evaluation.policy_id = ?
      AND evaluation.status <> 'observing'
      AND metric.metric_code = ?
    ORDER BY evaluation.observation_ordinal DESC, evaluation.evaluation_id DESC
    LIMIT ?
  `).bind(ruleVersionId, policyId, metricCode, requiredPrevious)
    .all<{ outcome: string }>()
  return rows.results.length === requiredPrevious
    && rows.results.every(item => item.outcome === 'breached')
}

function validateEvaluationTimes(
  input: ReturnType<typeof normalizeEvaluationInput>,
  policy: GuardrailPolicyRow,
  control: GuardrailControlRow,
  now: Date,
) {
  const start = Date.parse(input.windowStart)
  const end = Date.parse(input.windowEnd)
  const captured = Date.parse(input.capturedAt)
  const nowMs = now.getTime()
  if (end <= start || captured < end || end > nowMs + 5 * 60_000 || captured > nowMs + 5 * 60_000) {
    throw new AppRecommendationError(400, 'RECOMMENDATION_GUARDRAIL_TIME_INVALID', '聚合快照时间顺序无效或来自未来')
  }
  if (end - start < policy.observation_window_minutes * 60_000) {
    throw new AppRecommendationError(422, 'RECOMMENDATION_GUARDRAIL_WINDOW_TOO_SHORT', '聚合快照未覆盖策略要求的最小观察窗口')
  }
  if (nowMs - captured > control.max_snapshot_age_minutes * 60_000) {
    throw new AppRecommendationError(422, 'RECOMMENDATION_GUARDRAIL_SNAPSHOT_STALE', '聚合快照已超过批准的新鲜度窗口')
  }
}

async function transitionPolicy(
  db: D1Database,
  current: GuardrailPolicyRow,
  targetState: string,
  action: string,
  reason: string,
  actor: RecommendationGuardrailActor,
  now: Date,
  flags: { reviewed?: boolean; retired?: boolean } = {},
) {
  assertActor(actor)
  const token = crypto.randomUUID()
  const nowIso = now.toISOString()
  await db.batch([
    db.prepare(`
      UPDATE app_recommendation_guardrail_policies
      SET state = ?,
          reviewed_by = CASE WHEN ? = 1 THEN ? ELSE reviewed_by END,
          reviewed_at = CASE WHEN ? = 1 THEN ? ELSE reviewed_at END,
          retired_by = CASE WHEN ? = 1 THEN ? ELSE retired_by END,
          retired_at = CASE WHEN ? = 1 THEN ? ELSE retired_at END,
          lock_version = lock_version + 1, mutation_token = ?,
          updated_by = ?, updated_at = ?
      WHERE policy_id = ? AND state = ? AND lock_version = ?
    `).bind(
      targetState,
      flags.reviewed ? 1 : 0,
      actor.adminId,
      flags.reviewed ? 1 : 0,
      nowIso,
      flags.retired ? 1 : 0,
      actor.adminId,
      flags.retired ? 1 : 0,
      nowIso,
      token,
      actor.adminId,
      nowIso,
      current.policy_id,
      current.state,
      current.lock_version,
    ),
    guardedPolicyEvent(db, current.policy_id, token, current.state, targetState, action, reason, actor, nowIso),
    guardedPolicyAudit(db, current.policy_id, token, actor.adminId, `recommendation_guardrail_policy_${action}`, {
      fromState: current.state,
      toState: targetState,
      reason,
    }, nowIso),
  ])
  if (!await findPolicyByToken(db, current.policy_id, token)) throw policyVersionConflict()
  return getAdminRecommendationGuardrailPolicy(db, current.policy_id)
}

async function requirePolicyState(
  db: D1Database,
  policyId: string,
  expectedVersion: number,
  states: string[],
) {
  const current = await findPolicy(db, policyId)
  if (!current) throw policyNotFound()
  if (current.lock_version !== expectedVersion) throw policyVersionConflict()
  if (!states.includes(current.state)) {
    throw new AppRecommendationError(409, 'RECOMMENDATION_GUARDRAIL_POLICY_STATE_CONFLICT', '推荐守护策略当前状态不允许该操作')
  }
  return current
}

async function loadGuardrailControl(db: D1Database) {
  const row = await db.prepare(`
    SELECT control_id, evaluation_enabled, source_key, source_decision_status,
           retention_decision_status, retention_days, purge_enabled,
           production_ready, max_snapshot_age_minutes, created_at, updated_at
    FROM app_recommendation_guardrail_controls
    WHERE control_id = 'recommendation_guardrails'
    LIMIT 1
  `).first<GuardrailControlRow>()
  if (!row) {
    throw new AppRecommendationError(503, 'RECOMMENDATION_GUARDRAIL_CONTROL_NOT_READY', '推荐灰度守护控制尚未就绪', true)
  }
  const valid = [row.evaluation_enabled, row.purge_enabled, row.production_ready]
    .every(value => value === 0 || value === 1)
    && row.source_key === SOURCE_KEY
    && ['unresolved', 'approved'].includes(row.source_decision_status)
    && ['unresolved', 'approved'].includes(row.retention_decision_status)
    && Number.isSafeInteger(row.max_snapshot_age_minutes)
    && row.max_snapshot_age_minutes >= 5
    && row.max_snapshot_age_minutes <= 1440
    && (
      row.evaluation_enabled === 0
      || (
        row.source_decision_status === 'approved'
        && row.retention_decision_status === 'approved'
        && Number.isSafeInteger(row.retention_days)
        && Number(row.retention_days) > 0
        && row.purge_enabled === 1
      )
    )
    && (
      row.production_ready === 0
      || (
        row.evaluation_enabled === 1
        && row.source_decision_status === 'approved'
        && row.retention_decision_status === 'approved'
        && Number.isSafeInteger(row.retention_days)
        && Number(row.retention_days) > 0
        && row.purge_enabled === 1
      )
    )
  if (!valid) throw new AppRecommendationError(503, 'RECOMMENDATION_GUARDRAIL_CONTROL_INVALID', '推荐灰度守护控制内容不完整或不安全', true)
  return row
}

function assertControlReady(control: GuardrailControlRow, requireProductionReady: boolean) {
  if (
    control.evaluation_enabled !== 1
    || control.source_decision_status !== 'approved'
    || control.retention_decision_status !== 'approved'
    || control.retention_days === null
    || control.purge_enabled !== 1
  ) {
    throw new AppRecommendationError(403, 'RECOMMENDATION_GUARDRAIL_DISABLED', '推荐灰度守护评估当前保持关闭')
  }
  if (requireProductionReady && control.production_ready !== 1) {
    throw new AppRecommendationError(403, 'RECOMMENDATION_GUARDRAIL_PRODUCTION_NOT_READY', '推荐灰度守护控制尚未通过生产门禁')
  }
}

function mapControl(row: GuardrailControlRow) {
  return {
    controlId: row.control_id,
    evaluationEnabled: row.evaluation_enabled === 1,
    sourceKey: row.source_key,
    sourceDecisionStatus: row.source_decision_status,
    retentionDecisionStatus: row.retention_decision_status,
    retentionDays: row.retention_days,
    purgeEnabled: row.purge_enabled === 1,
    productionReady: row.production_ready === 1,
    maxSnapshotAgeMinutes: row.max_snapshot_age_minutes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapPolicy(row: GuardrailPolicyRow) {
  return {
    policyId: row.policy_id,
    state: row.state,
    name: row.name,
    description: row.description,
    sourceKey: row.source_key,
    observationWindowMinutes: row.observation_window_minutes,
    minimumSampleSize: row.minimum_sample_size,
    minimumObservationCount: row.minimum_observation_count,
    consecutiveBreachCount: row.consecutive_breach_count,
    metrics: parseMetricDefinitions(row.metric_definitions_json),
    productionReady: row.production_ready === 1,
    version: row.lock_version,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    reviewedBy: row.reviewed_by,
    retiredBy: row.retired_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    reviewedAt: row.reviewed_at,
    retiredAt: row.retired_at,
  }
}

async function findPolicy(db: D1Database, policyId: string) {
  return db.prepare(`
    SELECT ${POLICY_FIELDS}
    FROM app_recommendation_guardrail_policies
    WHERE policy_id = ?
    LIMIT 1
  `).bind(policyId).first<GuardrailPolicyRow>()
}

async function findPolicyByToken(db: D1Database, policyId: string, token: string) {
  return db.prepare(`
    SELECT ${POLICY_FIELDS}
    FROM app_recommendation_guardrail_policies
    WHERE policy_id = ? AND mutation_token = ?
    LIMIT 1
  `).bind(policyId, token).first<GuardrailPolicyRow>()
}

async function findRule(db: D1Database, ruleVersionId: string) {
  return db.prepare(`
    SELECT rule_version_id, state, rollout_percent, rollback_rule_version_id,
           guardrail_policy_id, lock_version
    FROM app_recommendation_rule_versions
    WHERE rule_version_id = ?
    LIMIT 1
  `).bind(ruleVersionId).first<RecommendationRuleGuardrailRow>()
}

async function findRuleBlock(db: D1Database, ruleVersionId: string) {
  return db.prepare(`
    SELECT evaluation_id, reason_code
    FROM app_recommendation_guardrail_blocks
    WHERE rule_version_id = ?
    LIMIT 1
  `).bind(ruleVersionId).first<{ evaluation_id: string; reason_code: string }>()
}

async function findEvaluationBySnapshot(
  db: D1Database,
  ruleVersionId: string,
  sourceSnapshotRef: string,
) {
  return db.prepare(`
    SELECT evaluation_id, source_snapshot_sha256, request_hash
    FROM app_recommendation_guardrail_evaluations
    WHERE rule_version_id = ? AND source_snapshot_ref = ?
    LIMIT 1
  `).bind(ruleVersionId, sourceSnapshotRef).first<{
    evaluation_id: string
    source_snapshot_sha256: string
    request_hash: string
  }>()
}

function policyEvent(
  db: D1Database,
  policyId: string,
  fromState: string | null,
  toState: string,
  action: string,
  reason: string,
  actor: RecommendationGuardrailActor,
  nowIso: string,
) {
  return db.prepare(`
    INSERT INTO app_recommendation_guardrail_policy_events (
      event_id, policy_id, from_state, to_state, action,
      reason, actor_id, request_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(generateId('rgpe'), policyId, fromState, toState, action, reason, actor.adminId, actor.requestId, nowIso)
}

function guardedPolicyEvent(
  db: D1Database,
  policyId: string,
  token: string,
  fromState: string,
  toState: string,
  action: string,
  reason: string,
  actor: RecommendationGuardrailActor,
  nowIso: string,
) {
  return db.prepare(`
    INSERT INTO app_recommendation_guardrail_policy_events (
      event_id, policy_id, from_state, to_state, action,
      reason, actor_id, request_id, created_at
    )
    SELECT ?, policy_id, ?, ?, ?, ?, ?, ?, ?
    FROM app_recommendation_guardrail_policies
    WHERE policy_id = ? AND mutation_token = ?
  `).bind(
    generateId('rgpe'),
    fromState,
    toState,
    action,
    reason,
    actor.adminId,
    actor.requestId,
    nowIso,
    policyId,
    token,
  )
}

function guardedPolicyAudit(
  db: D1Database,
  policyId: string,
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
    SELECT ?, ?, ?, 'app_recommendation_guardrail_policy', policy_id, NULL, ?, ?
    FROM app_recommendation_guardrail_policies
    WHERE policy_id = ? AND mutation_token = ?
  `).bind(generateId('log'), adminId, action, JSON.stringify(after), nowIso, policyId, token)
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

async function prepareIdempotency(
  value: string | null,
  action: string,
  request: unknown,
): Promise<Idempotency> {
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

async function findRequest(db: D1Database, adminId: number, keyHash: string) {
  return db.prepare(`
    SELECT action, request_hash, result_type, result_id
    FROM app_recommendation_guardrail_requests
    WHERE admin_id = ? AND idempotency_key_hash = ?
    LIMIT 1
  `).bind(adminId, keyHash).first<{
    action: string
    request_hash: string
    result_type: string
    result_id: string
  }>()
}

function insertRequest(
  db: D1Database,
  adminId: number,
  idempotency: Idempotency,
  resultType: 'policy' | 'evaluation',
  resultId: string,
  nowIso: string,
) {
  return db.prepare(`
    INSERT INTO app_recommendation_guardrail_requests (
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

async function replayPolicy(
  db: D1Database,
  row: { action: string; request_hash: string; result_type: string; result_id: string },
  idempotency: Idempotency,
) {
  assertReplay(row, idempotency, 'policy')
  return { policy: await getAdminRecommendationGuardrailPolicy(db, row.result_id), replayed: true }
}

async function replayEvaluation(
  db: D1Database,
  row: { action: string; request_hash: string; result_type: string; result_id: string },
  idempotency: Idempotency,
) {
  assertReplay(row, idempotency, 'evaluation')
  return { evaluation: await getAdminRecommendationGuardrailEvaluation(db, row.result_id), replayed: true }
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
    throw new AppRecommendationError(409, 'IDEMPOTENCY_CONFLICT', '同一幂等键不能用于不同推荐守护请求')
  }
}

function transitionInput(value: unknown) {
  const object = requireObject<Record<string, unknown>>(value, ['expectedVersion', 'reason'], '推荐守护状态变更')
  return {
    expectedVersion: normalizeRecommendationExpectedVersion(object.expectedVersion),
    reason: requiredText(object.reason, 500, '操作原因'),
  }
}

function requireObject<T>(value: unknown, allowedKeys: readonly string[], label: string): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppRecommendationError(400, 'RECOMMENDATION_GUARDRAIL_REQUEST_INVALID', `${label}请求必须为 JSON 对象`)
  }
  if (Object.keys(value).some(key => !allowedKeys.includes(key))) {
    throw new AppRecommendationError(400, 'RECOMMENDATION_GUARDRAIL_REQUEST_INVALID', `${label}请求包含未支持字段`)
  }
  return value as T
}

function requiredText(value: unknown, maxLength: number, label: string) {
  if (typeof value !== 'string') {
    throw new AppRecommendationError(400, 'RECOMMENDATION_GUARDRAIL_TEXT_INVALID', `${label}必须为字符串`)
  }
  const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' ')
  if (!normalized || [...normalized].length > maxLength || containsUnsafeText(normalized)) {
    throw new AppRecommendationError(400, 'RECOMMENDATION_GUARDRAIL_TEXT_INVALID', `${label}必须为 1 至 ${maxLength} 个有效字符`)
  }
  return normalized
}

function optionalText(value: unknown, maxLength: number, label: string) {
  if (value === undefined || value === null || value === '') return null
  return requiredText(value, maxLength, label)
}

function integer(value: unknown, fallback: number, min: number, max: number, label: string) {
  if (value === undefined || value === null || value === '') {
    if (fallback >= min && fallback <= max) return fallback
    throw new AppRecommendationError(400, 'RECOMMENDATION_GUARDRAIL_NUMBER_INVALID', `${label}不能为空`)
  }
  const parsed = typeof value === 'string' && /^\d{1,10}$/u.test(value) ? Number(value) : value
  if (!Number.isSafeInteger(parsed) || Number(parsed) < min || Number(parsed) > max) {
    throw new AppRecommendationError(400, 'RECOMMENDATION_GUARDRAIL_NUMBER_INVALID', `${label}必须为 ${min} 至 ${max} 的整数`)
  }
  return Number(parsed)
}

function boolean(value: unknown, fallback: boolean, label: string) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') {
    throw new AppRecommendationError(400, 'RECOMMENDATION_GUARDRAIL_BOOLEAN_INVALID', `${label}必须为布尔值`)
  }
  return value
}

function timestamp(value: unknown, label: string) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new AppRecommendationError(400, 'RECOMMENDATION_GUARDRAIL_TIME_INVALID', `${label}格式无效`)
  }
  return new Date(value).toISOString()
}

function normalizeSourceSnapshotRef(value: unknown) {
  if (
    typeof value !== 'string'
    || !SOURCE_SNAPSHOT_REF_PATTERN.test(value)
    || SENSITIVE_SNAPSHOT_NAMESPACE_PATTERN.test(value)
    || value.includes('://')
    || value.includes('?')
    || value.includes('#')
  ) {
    throw new AppRecommendationError(
      400,
      'RECOMMENDATION_GUARDRAIL_SNAPSHOT_REF_INVALID',
      '来源快照引用必须使用 aggregate:recommendation: 命名空间，且不得包含账号、会话、真人资料、凭证或查询参数',
    )
  }
  return value
}

function normalizeSha256(value: unknown, label: string) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new AppRecommendationError(400, 'RECOMMENDATION_GUARDRAIL_SHA256_INVALID', `${label}必须为小写 SHA-256`)
  }
  return value
}

function normalizePolicyId(value: unknown) {
  if (typeof value !== 'string' || !POLICY_ID_PATTERN.test(value)) {
    throw new AppRecommendationError(400, 'RECOMMENDATION_GUARDRAIL_POLICY_ID_INVALID', '推荐守护策略 ID 格式无效')
  }
  return value
}

function normalizeEvaluationId(value: unknown) {
  if (typeof value !== 'string' || !/^rge_[A-Za-z0-9_-]{1,92}$/u.test(value)) {
    throw new AppRecommendationError(400, 'RECOMMENDATION_GUARDRAIL_EVALUATION_ID_INVALID', '推荐守护评估 ID 格式无效')
  }
  return value
}

function normalizeOptionalPolicyState(value: unknown) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !POLICY_STATES.includes(value as typeof POLICY_STATES[number])) {
    throw new AppRecommendationError(400, 'RECOMMENDATION_GUARDRAIL_POLICY_STATE_INVALID', '推荐守护策略状态筛选无效')
  }
  return value
}

function containsUnsafeText(value: string) {
  return containsUnsafeInvisibleCharacter(value)
}

function assertActor(actor: RecommendationGuardrailActor) {
  if (!Number.isSafeInteger(actor.adminId) || actor.adminId <= 0 || !['admin', 'owner'].includes(actor.role)) {
    throw new AppRecommendationError(403, 'RECOMMENDATION_ADMIN_REQUIRED', '需要有效推荐运营管理员身份')
  }
}

function requireOwner(actor: RecommendationGuardrailActor) {
  assertActor(actor)
  if (actor.role !== 'owner') {
    throw new AppRecommendationError(403, 'RECOMMENDATION_APPROVAL_REQUIRED', '该操作需要 Owner 复核权限')
  }
}

function policyNotFound() {
  return new AppRecommendationError(404, 'RECOMMENDATION_GUARDRAIL_POLICY_NOT_FOUND', '推荐守护策略不存在')
}

function policyVersionConflict() {
  return new AppRecommendationError(409, 'RECOMMENDATION_GUARDRAIL_POLICY_VERSION_CONFLICT', '推荐守护策略版本已变化，请刷新后重试')
}

function invalidPolicyData() {
  return new AppRecommendationError(503, 'RECOMMENDATION_GUARDRAIL_POLICY_INVALID', '推荐守护策略数据异常', true)
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

const POLICY_STATES = ['draft', 'pending_review', 'approved', 'retired'] as const

const CREATE_POLICY_KEYS = [
  'name',
  'description',
  'observationWindowMinutes',
  'minimumSampleSize',
  'minimumObservationCount',
  'consecutiveBreachCount',
  'metrics',
  'productionReady',
] as const

const UPDATE_POLICY_KEYS = ['expectedVersion', ...CREATE_POLICY_KEYS] as const

const POLICY_FIELDS = `
  policy_id, state, name, description, source_key,
  observation_window_minutes, minimum_sample_size, minimum_observation_count,
  consecutive_breach_count, metric_definitions_json, production_ready,
  lock_version, mutation_token, created_by, updated_by, reviewed_by, retired_by,
  created_at, updated_at, reviewed_at, retired_at
`

const EVALUATION_FIELDS = `
  evaluation_id, rule_version_id, policy_id, policy_digest, source_key,
  source_snapshot_ref, source_snapshot_sha256, request_hash,
  window_start, window_end, captured_at, sample_size, observation_ordinal,
  status, blocking_reason_code, target_met_count, target_missed_count,
  warning_count, stop_breach_count, evaluated_by, created_at
`
