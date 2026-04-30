/**
 * 健康检查 API
 * GET /api/health
 */
export default defineEventHandler(async (event) => {
  let dbStatus = 'unknown'

  try {
    const db = useDB(event)
    const result = await db.prepare('SELECT 1 as ok').first<{ ok: number }>()
    dbStatus = result?.ok === 1 ? 'ok' : 'error'
  }
  catch {
    dbStatus = 'unavailable'
  }

  return {
    status: 'ok',
    timestamp: new Date().toISOString(),
    db: dbStatus,
  }
})
