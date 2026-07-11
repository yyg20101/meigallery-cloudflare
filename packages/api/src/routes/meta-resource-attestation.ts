import { Hono } from 'hono'
import type { Bindings, Variables } from '../index'
import { consumeMetaResourceAttestationTicket } from '../services/meta-resource-attestation-ticket'
import { errorJson } from '../utils/api-error'
import { writeAuditLog } from '../utils/permission'

export const metaResourceAttestationRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

metaResourceAttestationRoutes.post('/resource-attestation', async (c) => {
  const body: { nonce?: unknown; ticket?: unknown } = await c.req.json().catch(() => ({}))
  try {
    const consumed = await consumeMetaResourceAttestationTicket(
      c.env,
      String(body.ticket || ''),
      String(body.nonce || ''),
    )
    await writeAuditLog(c.env.DB, {
      adminId: consumed.ownerUserId,
      action: 'attribution.meta_resource_attestation_ticket_consume',
      targetType: 'attribution',
      targetId: 'meta_resources',
      afterValue: {
        success: true,
        environment: consumed.attestation.environment,
        commitSha: consumed.attestation.commitSha,
      },
    })
    return c.json({ data: consumed.attestation })
  }
  catch {
    return errorJson(c, 409, 'Meta 资源身份不可证明', { code: 'META_RESOURCE_ATTESTATION_BLOCKED' })
  }
})
