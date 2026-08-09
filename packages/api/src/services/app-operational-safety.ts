export const APP_OPERATIONAL_CONTROL_KEYS = [
  'person_publication',
  'recommendation_delivery',
  'operator_messaging',
  'membership_grants',
  'wallet_adjustments',
] as const

export type AppOperationalControlKey = typeof APP_OPERATIONAL_CONTROL_KEYS[number]
export type AppOperationalControlState = 'available' | 'paused'

export interface AppOperationalControl {
  key: AppOperationalControlKey
  displayName: string
  state: AppOperationalControlState
  version: number
  incidentId: string | null
  reasonCode: string | null
  reasonSummary: string | null
  changedBy: number | null
  changedAt: string
}

type ControlRow = {
  control_key: string
  display_name: string
  state: string
  version: number
  incident_id: string | null
  reason_code: string | null
  reason_summary: string | null
  changed_by: number | null
  changed_at: string
}

export type AppOperationalControlErrorFactory = (
  code: 'APP_OPERATIONAL_CONTROL_UNAVAILABLE' | 'APP_OPERATION_PAUSED',
  message: string,
  detail: { controlKey: AppOperationalControlKey; incidentId: string | null },
) => Error

export async function getAppOperationalControl(
  db: D1Database,
  controlKey: AppOperationalControlKey,
): Promise<AppOperationalControl> {
  let row: ControlRow | null
  try {
    row = await db.prepare(`
      SELECT control_key, display_name, state, version, incident_id,
             reason_code, reason_summary, changed_by, changed_at
      FROM app_operational_safety_controls
      WHERE control_key = ?
      LIMIT 1
    `).bind(controlKey).first<ControlRow>()
  }
  catch {
    throw new Error(`Operational control storage is unavailable: ${controlKey}`)
  }
  if (!row || (row.state !== 'available' && row.state !== 'paused')) {
    throw new Error(`Operational control is missing or invalid: ${controlKey}`)
  }
  return {
    key: controlKey,
    displayName: row.display_name,
    state: row.state,
    version: Number(row.version),
    incidentId: row.incident_id,
    reasonCode: row.reason_code,
    reasonSummary: row.reason_summary,
    changedBy: row.changed_by === null ? null : Number(row.changed_by),
    changedAt: row.changed_at,
  }
}

export async function requireAppOperationalControlAvailable(
  db: D1Database,
  controlKey: AppOperationalControlKey,
  createError: AppOperationalControlErrorFactory,
): Promise<AppOperationalControl> {
  let control: AppOperationalControl
  try {
    control = await getAppOperationalControl(db, controlKey)
  }
  catch {
    throw createError(
      'APP_OPERATIONAL_CONTROL_UNAVAILABLE',
      `${controlLabel(controlKey)}安全控制不可用，当前写操作已安全阻断`,
      { controlKey, incidentId: null },
    )
  }
  if (control.state === 'paused') {
    throw createError(
      'APP_OPERATION_PAUSED',
      control.reasonSummary || `${control.displayName}已因运营事件暂停`,
      { controlKey, incidentId: control.incidentId },
    )
  }
  return control
}

function controlLabel(controlKey: AppOperationalControlKey) {
  return {
    person_publication: '人物发布',
    recommendation_delivery: '推荐投放',
    operator_messaging: '运营消息发送',
    membership_grants: '会员发放',
    wallet_adjustments: '金币调整',
  }[controlKey]
}
