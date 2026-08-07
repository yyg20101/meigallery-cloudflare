import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'

const DEV_DATABASE = 'meigallery-db-dev'
const DEV_API_BASE_URL = 'https://meigallery-api-dev.wajie.workers.dev'
const DEV_WEB_BASE_URL = 'https://meigallery-web-dev.wajie.workers.dev'
const DOCUMENT_VERSION = 'dev-rules-2026-08-07'

if (!process.argv.includes(`--confirm-dev=${DEV_DATABASE}`)) {
  console.error(`拒绝执行：必须显式传入 --confirm-dev=${DEV_DATABASE}`)
  process.exit(2)
}

const suffix = randomBytes(6).toString('hex')
const now = new Date()
const nowIso = now.toISOString()
const accessExpiresAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString()
const refreshExpiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString()
const webSessionExpiresAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString()
const viewerId = -(1_600_000_000 + Number.parseInt(suffix.slice(0, 6), 16))
const originalReviewerId = viewerId - 1
const appealReviewerId = viewerId - 2
const accessToken = `mga_${randomBytes(32).toString('hex')}`
const refreshToken = `mgr_${randomBytes(32).toString('hex')}`
const originalReviewerToken = randomBytes(32).toString('hex')
const appealReviewerToken = randomBytes(32).toString('hex')
const galleryId = `gal_safety2_smoke_${suffix}`
const personId = `per_safety2_smoke_${suffix}`
const profileId = `pp_safety2_smoke_${suffix}`
const deviceId = `dev_safety2_smoke_${suffix}`
const appSessionId = `aps_safety2_smoke_${suffix}`
const accountPublicId = `acc_safety2_smoke_${suffix}`

let fixtureSeeded = false

try {
  await verifyReleaseAndCapabilities()
  // D1 远程批量写入可能在命令失败前只完成部分语句，因此从 seed 开始前就启用清理。
  fixtureSeeded = true
  seedFixture()
  await verifySafety2Flow()
  verifyAuditEvidence()
  console.log('Safety-2 dev smoke 通过：举报、原审核、独立申诉复核、重新调查与审计均符合预期。')
}
finally {
  if (fixtureSeeded) {
    cleanupFixture()
    console.log('Safety-2 dev smoke 测试数据已清理。')
  }
}

async function verifyReleaseAndCapabilities() {
  const expectedCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  }).trim()
  const apiHealth = await requestJson(`${DEV_API_BASE_URL}/api/health`, { expectedStatus: 200 })
  assert.equal(apiHealth.status, 'ok')
  assert.equal(apiHealth.environment, 'dev')
  assert.equal(apiHealth.commit, expectedCommit)

  const webHealth = await requestJson(`${DEV_WEB_BASE_URL}/__release`, { expectedStatus: 200 })
  assert.equal(webHealth.status, 'ok')
  assert.equal(webHealth.environment, 'dev')
  assert.equal(webHealth.commit, expectedCommit)

  const bootstrap = await requestJson(`${DEV_API_BASE_URL}/api/v2/app/bootstrap`, { expectedStatus: 200 })
  assert.equal(bootstrap.meta?.contractVersion, '1.7.0')
  assert.equal(bootstrap.data?.capabilities?.auth, true)
  assert.equal(bootstrap.data?.auth?.registrationEnabled, false)
  assert.equal(bootstrap.data?.capabilities?.safety?.reports, true)
  assert.equal(bootstrap.data?.capabilities?.safety?.appeals, true)
  assert.equal(bootstrap.data?.capabilities?.membership?.catalog, false)
  assert.equal(bootstrap.data?.capabilities?.messaging, false)
  assert.equal(bootstrap.data?.capabilities?.payments, false)
  assert.equal(bootstrap.data?.capabilities?.systemPush, false)
  assert.equal(bootstrap.data?.safety?.appealPolicyVersion, 'sap_app_1_0_safety_2_dev_1')
}

async function verifySafety2Flow() {
  const viewerHeaders = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  }
  const originalReviewerHeaders = {
    Cookie: `mei_session=${originalReviewerToken}`,
    'Content-Type': 'application/json',
  }
  const appealReviewerHeaders = {
    Cookie: `mei_session=${appealReviewerToken}`,
    'Content-Type': 'application/json',
  }

  const createdReport = await requestJson(`${DEV_API_BASE_URL}/api/v2/reports`, {
    expectedStatus: 201,
    method: 'POST',
    headers: { ...viewerHeaders, 'Idempotency-Key': `report-create-${suffix}` },
    body: {
      targetType: 'person_profile',
      profileId,
      reasonCode: 'other',
      description: 'Safety-2 开发环境端到端验证举报说明。',
    },
  })
  const reportId = createdReport.data?.report?.reportId
  assert.match(reportId, /^rpt_[A-Za-z0-9_-]+$/u)

  const reportClaim = await requestJson(`${DEV_API_BASE_URL}/api/admin/app/safety/reports/${reportId}/claim`, {
    expectedStatus: 200,
    method: 'POST',
    headers: { ...originalReviewerHeaders, 'Idempotency-Key': `report-claim-${suffix}` },
  })
  assert.equal(reportClaim.data?.report?.assignment?.status, 'mine')

  const reportDetail = await requestJson(`${DEV_API_BASE_URL}/api/admin/app/safety/reports/${reportId}?accessReason=safety_review`, {
    expectedStatus: 200,
    headers: originalReviewerHeaders,
  })
  assert.equal(reportDetail.data?.description, 'Safety-2 开发环境端到端验证举报说明。')

  const originalDecision = await requestJson(`${DEV_API_BASE_URL}/api/admin/app/safety/reports/${reportId}/decision`, {
    expectedStatus: 200,
    method: 'POST',
    headers: { ...originalReviewerHeaders, 'Idempotency-Key': `report-decision-${suffix}` },
    body: {
      expectedVersion: reportClaim.data.report.version,
      outcome: 'no_violation',
      actionType: 'none',
      decisionReasonCode: 'review_no_violation',
      userVisibleMessage: '开发环境审核完成，当前未发现违规。',
    },
  })
  assert.equal(originalDecision.data?.report?.status, 'no_violation')

  const eligibleReport = await requestJson(`${DEV_API_BASE_URL}/api/v2/me/reports/${reportId}`, {
    expectedStatus: 200,
    headers: viewerHeaders,
  })
  assert.equal(eligibleReport.data?.appeal?.canAppeal, true)

  const createdAppeal = await requestJson(`${DEV_API_BASE_URL}/api/v2/appeals`, {
    expectedStatus: 201,
    method: 'POST',
    headers: { ...viewerHeaders, 'Idempotency-Key': `appeal-create-${suffix}` },
    body: {
      reportId,
      expectedReportVersion: eligibleReport.data.version,
      statement: '请由不同审核人员独立复核本次结论。',
    },
  })
  const appealId = createdAppeal.data?.appeal?.appealId
  assert.match(appealId, /^apl_[A-Za-z0-9_-]+$/u)

  const separationDenied = await requestJson(`${DEV_API_BASE_URL}/api/admin/app/safety/appeals/${appealId}/claim`, {
    expectedStatus: 403,
    method: 'POST',
    headers: { ...originalReviewerHeaders, 'Idempotency-Key': `appeal-denied-${suffix}` },
  })
  assert.equal(separationDenied.code, 'APPEAL_REVIEWER_SEPARATION_REQUIRED')

  const appealClaim = await requestJson(`${DEV_API_BASE_URL}/api/admin/app/safety/appeals/${appealId}/claim`, {
    expectedStatus: 200,
    method: 'POST',
    headers: { ...appealReviewerHeaders, 'Idempotency-Key': `appeal-claim-${suffix}` },
  })
  assert.equal(appealClaim.data?.appeal?.assignedToMe, true)

  const appealDetail = await requestJson(`${DEV_API_BASE_URL}/api/admin/app/safety/appeals/${appealId}?accessReason=appeal_review`, {
    expectedStatus: 200,
    headers: appealReviewerHeaders,
  })
  assert.equal(appealDetail.data?.statement, '请由不同审核人员独立复核本次结论。')
  assert.equal(appealDetail.data?.report?.status, 'no_violation')

  const appealDecision = await requestJson(`${DEV_API_BASE_URL}/api/admin/app/safety/appeals/${appealId}/decision`, {
    expectedStatus: 200,
    method: 'POST',
    headers: { ...appealReviewerHeaders, 'Idempotency-Key': `appeal-decision-${suffix}` },
    body: {
      expectedVersion: appealClaim.data.appeal.version,
      outcome: 'changed',
      reasonCode: 'independent_review_changed',
      userVisibleMessage: '独立复核已完成，原举报已重新进入调查。',
    },
  })
  assert.equal(appealDecision.data?.appeal?.status, 'changed')

  const finalAppeal = await requestJson(`${DEV_API_BASE_URL}/api/v2/me/appeals/${appealId}`, {
    expectedStatus: 200,
    headers: viewerHeaders,
  })
  assert.equal(finalAppeal.data?.status, 'changed')

  const finalReport = await requestJson(`${DEV_API_BASE_URL}/api/v2/me/reports/${reportId}`, {
    expectedStatus: 200,
    headers: viewerHeaders,
  })
  assert.equal(finalReport.data?.status, 'processing')
  // 改判会把举报推进到新的 investigating 版本；已完成申诉仍从本人申诉详情追踪，
  // 举报详情只表达“当前版本不可再次申诉”，不得把上一结论的申诉误绑到新版本。
  assert.deepEqual(finalReport.data?.appeal, {
    canAppeal: false,
    unavailableReason: 'REPORT_NOT_ELIGIBLE',
    appealId: null,
    status: null,
  })
  assert.equal(finalReport.data?.timeline?.at(-1)?.status, 'processing')
  assert.equal(finalReport.data?.timeline?.at(-1)?.message, '独立复核已完成，原举报已重新进入调查。')
}

function seedFixture() {
  const accessHash = sha256(accessToken)
  const refreshHash = sha256(refreshToken)
  const originalReviewerHash = sha256(originalReviewerToken)
  const appealReviewerHash = sha256(appealReviewerToken)
  const installationHash = sha256(`installation-${suffix}`)
  executeD1(`
    INSERT INTO users (id, email, username, nickname, password_hash, role, status, email_verified, notification_enabled, created_at, updated_at)
    VALUES
      (${viewerId}, ${q(`safety2-viewer-${suffix}@example.invalid`)}, ${q(`s2viewer${suffix}`)}, 'Safety-2 测试观看者', 'smoke_not_for_login', 'user', 'active', 1, 0, ${q(nowIso)}, ${q(nowIso)}),
      (${originalReviewerId}, ${q(`safety2-reviewer-a-${suffix}@example.invalid`)}, ${q(`s2admina${suffix}`)}, 'Safety-2 原审核员', 'smoke_not_for_login', 'admin', 'active', 1, 0, ${q(nowIso)}, ${q(nowIso)}),
      (${appealReviewerId}, ${q(`safety2-reviewer-b-${suffix}@example.invalid`)}, ${q(`s2adminb${suffix}`)}, 'Safety-2 独立复核员', 'smoke_not_for_login', 'admin', 'active', 1, 0, ${q(nowIso)}, ${q(nowIso)});
    INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES
      (${q(`ses_safety2_a_${suffix}`)}, ${originalReviewerId}, ${q(originalReviewerHash)}, ${q(webSessionExpiresAt)}, ${q(nowIso)}),
      (${q(`ses_safety2_b_${suffix}`)}, ${appealReviewerId}, ${q(appealReviewerHash)}, ${q(webSessionExpiresAt)}, ${q(nowIso)});
    INSERT INTO galleries (id, title, slug, summary, status, required_level_rank, published_at, created_at, updated_at)
    VALUES (${q(galleryId)}, 'Safety-2 Smoke 图库', ${q(`safety2-smoke-${suffix}`)}, '仅用于开发环境自动验收', 'published', 0, ${q(nowIso)}, ${q(nowIso)}, ${q(nowIso)});
    INSERT INTO persons (id, lifecycle_status, created_by, created_at, updated_at)
    VALUES (${q(personId)}, 'active', ${originalReviewerId}, ${q(nowIso)}, ${q(nowIso)});
    INSERT INTO person_profiles (
      id, person_id, source_gallery_id, display_name, summary, tags_json,
      operation_mode, operation_label, verification_status, publication_status,
      safety_status, content_version, live_content_version, lock_version,
      created_by, updated_by, created_at, updated_at
    ) VALUES (
      ${q(profileId)}, ${q(personId)}, ${q(galleryId)}, 'Safety-2 Smoke 真人',
      '仅用于开发环境自动验收', '[]', 'platform_managed', '消息由平台运营接收',
      'verified', 'published', 'clear', 1, 1, 1,
      ${originalReviewerId}, ${originalReviewerId}, ${q(nowIso)}, ${q(nowIso)}
    );
    INSERT INTO app_account_security (account_id, account_public_id, status, session_version, created_at, updated_at)
    VALUES (${viewerId}, ${q(accountPublicId)}, 'active', 1, ${q(nowIso)}, ${q(nowIso)});
    INSERT INTO app_devices (
      id, account_id, installation_hash, platform, display_name, app_version,
      status, session_version, first_seen_at, last_seen_at, created_at, updated_at
    ) VALUES (
      ${q(deviceId)}, ${viewerId}, ${q(installationHash)}, 'android', 'Safety-2 Smoke', '1.0',
      'active', 1, ${q(nowIso)}, ${q(nowIso)}, ${q(nowIso)}, ${q(nowIso)}
    );
    INSERT INTO app_sessions (
      id, account_id, device_id, access_token_hash, refresh_token_hash,
      account_session_version, device_session_version, status,
      access_expires_at, refresh_expires_at, last_seen_at, created_at, updated_at
    ) VALUES (
      ${q(appSessionId)}, ${viewerId}, ${q(deviceId)}, ${q(accessHash)}, ${q(refreshHash)},
      1, 1, 'active', ${q(accessExpiresAt)}, ${q(refreshExpiresAt)}, ${q(nowIso)}, ${q(nowIso)}, ${q(nowIso)}
    );
    INSERT INTO app_account_consents (
      id, account_id, document_type, document_version, decision, source,
      request_id, accepted_at, created_at
    ) VALUES
      (${q(`con_terms_${suffix}`)}, ${viewerId}, 'terms', ${q(DOCUMENT_VERSION)}, 'accepted', 'app', ${q(`smoke-${suffix}`)}, ${q(nowIso)}, ${q(nowIso)}),
      (${q(`con_privacy_${suffix}`)}, ${viewerId}, 'privacy', ${q(DOCUMENT_VERSION)}, 'accepted', 'app', ${q(`smoke-${suffix}`)}, ${q(nowIso)}, ${q(nowIso)}),
      (${q(`con_platform_${suffix}`)}, ${viewerId}, 'platform_operation', ${q(DOCUMENT_VERSION)}, 'accepted', 'app', ${q(`smoke-${suffix}`)}, ${q(nowIso)}, ${q(nowIso)}),
      (${q(`con_eligibility_${suffix}`)}, ${viewerId}, 'eligibility', ${q(DOCUMENT_VERSION)}, 'confirmed', 'app', ${q(`smoke-${suffix}`)}, ${q(nowIso)}, ${q(nowIso)});
  `)
}

function verifyAuditEvidence() {
  const payload = executeD1(`
    SELECT action, COUNT(*) AS count
    FROM admin_audit_logs
    WHERE admin_id IN (${originalReviewerId}, ${appealReviewerId})
    GROUP BY action
    ORDER BY action;
  `, true)
  const rows = findD1Rows(payload)
  const actions = new Set(rows.map(row => String(row.action)))
  for (const action of [
    'moderation.report.claim',
    'moderation.report.evidence_access',
    'moderation.report.decision',
    'moderation.appeal.claim_denied',
    'moderation.appeal.claim',
    'moderation.appeal.detail_access',
    'moderation.appeal.decision',
  ]) {
    assert.equal(actions.has(action), true, `缺少审计动作：${action}`)
  }
}

function cleanupFixture() {
  executeD1(`
    DELETE FROM admin_audit_logs
    WHERE admin_id IN (${originalReviewerId}, ${appealReviewerId})
       OR target_id IN (SELECT id FROM app_safety_appeals WHERE account_id = ${viewerId})
       OR target_id IN (SELECT id FROM app_safety_reports WHERE account_id = ${viewerId});
    DELETE FROM app_safety_appeal_idempotency
    WHERE result_id IN (SELECT id FROM app_safety_appeals WHERE account_id = ${viewerId});
    DELETE FROM app_safety_appeal_events
    WHERE appeal_id IN (SELECT id FROM app_safety_appeals WHERE account_id = ${viewerId});
    DELETE FROM app_safety_appeals WHERE account_id = ${viewerId};
    DELETE FROM app_safety_idempotency
    WHERE result_type = 'report' AND result_id IN (SELECT id FROM app_safety_reports WHERE account_id = ${viewerId});
    DELETE FROM app_safety_report_events
    WHERE report_id IN (SELECT id FROM app_safety_reports WHERE account_id = ${viewerId});
    DELETE FROM app_safety_report_evidence
    WHERE report_id IN (SELECT id FROM app_safety_reports WHERE account_id = ${viewerId});
    DELETE FROM app_safety_reports WHERE account_id = ${viewerId};
    DELETE FROM app_account_security_events WHERE account_id = ${viewerId};
    DELETE FROM app_refresh_token_history WHERE session_id = ${q(appSessionId)};
    DELETE FROM app_sessions WHERE account_id = ${viewerId};
    DELETE FROM app_devices WHERE account_id = ${viewerId};
    DELETE FROM app_account_consents WHERE account_id = ${viewerId};
    DELETE FROM app_account_identities WHERE account_id = ${viewerId};
    DELETE FROM app_account_security WHERE account_id = ${viewerId};
    DELETE FROM sessions WHERE user_id IN (${originalReviewerId}, ${appealReviewerId});
    DELETE FROM person_profiles WHERE id = ${q(profileId)};
    DELETE FROM persons WHERE id = ${q(personId)};
    DELETE FROM galleries WHERE id = ${q(galleryId)};
    DELETE FROM users WHERE id IN (${viewerId}, ${originalReviewerId}, ${appealReviewerId});
  `)
}

function executeD1(sql, json = false) {
  const args = [
    'pnpm', '--filter', '@meigallery/api', 'exec', 'wrangler',
    'd1', 'execute', DEV_DATABASE, '--env', 'dev', '--remote', '--yes', '--command', sql,
  ]
  if (json) args.push('--json')
  try {
    const output = execFileSync('corepack', args, {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return json ? JSON.parse(output) : null
  }
  catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0] : '未知错误'
    throw new Error(`开发 D1 命令执行失败：${message}`)
  }
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers: options.headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: 'error',
  })
  const text = await response.text()
  let payload
  try {
    payload = text ? JSON.parse(text) : null
  }
  catch {
    throw new Error(`${new URL(url).pathname} 返回了非 JSON 响应`)
  }
  assert.equal(
    response.status,
    options.expectedStatus,
    `${new URL(url).pathname} 状态码不符合预期：${text.slice(0, 300)}`,
  )
  return payload
}

function findD1Rows(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const rows = findD1Rows(item)
      if (rows.length) return rows
    }
    return []
  }
  if (!value || typeof value !== 'object') return []
  if (Array.isArray(value.results)) return value.results
  for (const child of Object.values(value)) {
    const rows = findD1Rows(child)
    if (rows.length) return rows
  }
  return []
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function q(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}
