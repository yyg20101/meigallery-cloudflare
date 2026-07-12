import { describe, expect, it } from 'vitest'
import {
  d1Changed,
  digestConversionDedupeKey,
  generateConversionClaimToken,
  insertConversionDedupeClaim,
  renewConversionDedupeClaim,
  takeoverConversionDedupeClaim,
  type ConversionDedupeClaim,
} from './conversion-dedupe-claim'

const CLAIM: ConversionDedupeClaim = {
  dedupe_digest: 'a'.repeat(64),
  owner_action_id: 'conv_owner',
  claim_token: 'b'.repeat(32),
  claimed_at: '2026-07-11T00:00:00.000Z',
  expires_at: '2026-07-11T00:01:00.000Z',
}

describe('conversion dedupe claim 内部模块', () => {
  it('把原始 dedupe key 转为严格 64 位小写 SHA-256 摘要', async () => {
    const raw = 'contact:session_private:telegram:private_target'

    const digest = await digestConversionDedupeKey(raw)

    expect(digest).toBe('ae107be0e68bfb94ddd5532e8e784204d13fe22943d71c5d13a6dc9bd40e6c8c')
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
    expect(digest).not.toContain(raw)
  })

  it('每次使用独立 CSPRNG 生成严格 32 位小写 hex claim token', () => {
    const tokens = new Set(Array.from({ length: 32 }, () => generateConversionClaimToken()))

    expect(tokens).toHaveLength(32)
    for (const token of tokens) expect(token).toMatch(/^[0-9a-f]{32}$/)
  })

  it.each([
    ['无 meta', {}],
    ['空 meta', { meta: {} }],
    ['changes 为 NaN', { meta: { changes: Number.NaN, rows_written: 1 } }],
    ['changes 为负数', { meta: { changes: -1, rows_written: 1 } }],
    ['rows_written 为 NaN', { meta: { rows_written: Number.NaN } }],
    ['rows_written 为负数', { meta: { rows_written: -1 } }],
  ])('%s 时写入结果 fail closed', (_name, result) => {
    expect(d1Changed(result as D1Result<unknown>)).toBe(false)
  })

  it.each([
    { meta: { changes: 1 } },
    { meta: { rows_written: 1 } },
  ])('只接受严格有限非负写入计数: %j', result => {
    expect(d1Changed(result as D1Result<unknown>)).toBe(true)
  })

  it('INSERT 仅使用 D1 执行时钟并通过 RETURNING 获取 lease 快照', async () => {
    const { db, calls } = fakeDb([claimResult(CLAIM)])

    await expect(insertConversionDedupeClaim(db, CLAIM.dedupe_digest, CLAIM.owner_action_id)).resolves.toEqual(CLAIM)

    expect(calls[0]?.sql).toContain("strftime('%Y-%m-%dT%H:%M:%fZ', 'now')")
    expect(calls[0]?.sql).toContain("strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)")
    expect(calls[0]?.sql).toContain('RETURNING dedupe_digest')
    expect(calls[0]?.params).toHaveLength(4)
    expect(calls[0]?.params[0]).toBe(CLAIM.dedupe_digest)
    expect(calls[0]?.params[3]).toBe('+60 seconds')
    expect(calls[0]?.params).not.toContain(CLAIM.claimed_at)
    expect(calls[0]?.params).not.toContain(CLAIM.expires_at)
  })

  it('renew 与 takeover 都以完整旧快照 CAS，并返回 D1 生成的新快照', async () => {
    const renewed = {
      ...CLAIM,
      claimed_at: '2026-07-11T00:00:30.000Z',
      expires_at: '2026-07-11T00:01:30.000Z',
    }
    const takenOver = {
      ...renewed,
      owner_action_id: 'conv_new_owner',
      claim_token: 'c'.repeat(32),
      claimed_at: '2026-07-11T00:00:45.000Z',
      expires_at: '2026-07-11T00:01:45.000Z',
    }
    const { db, calls } = fakeDb([claimResult(renewed), claimResult(takenOver)])

    await expect(renewConversionDedupeClaim(db, CLAIM)).resolves.toEqual(renewed)
    await expect(takeoverConversionDedupeClaim(db, renewed, takenOver.owner_action_id)).resolves.toEqual(takenOver)

    for (const call of calls) {
      expect(call.sql).toContain("strftime('%Y-%m-%dT%H:%M:%fZ', 'now')")
      expect(call.sql).toContain('RETURNING dedupe_digest')
      expect(call.params).not.toContain(takenOver.claimed_at)
      expect(call.params).not.toContain(takenOver.expires_at)
    }
    expect(calls[0]?.sql).toContain("expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')")
    expect(calls[1]?.sql).toContain("expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')")
  })

  it.each([
    {},
    { meta: {} },
    { meta: { changes: Number.NaN, rows_written: 1 } },
    { meta: { changes: -1, rows_written: 1 } },
  ])('claim 写入结果元数据异常时即使携带 RETURNING row 也 fail closed: %j', async meta => {
    const { db } = fakeDb([{ ...meta, results: [CLAIM] }])

    await expect(insertConversionDedupeClaim(db, CLAIM.dedupe_digest, CLAIM.owner_action_id)).resolves.toBeNull()
  })
})

type FakeCall = { sql: string; params: unknown[] }

function claimResult(claim: ConversionDedupeClaim) {
  return {
    results: [claim],
    meta: { changes: 1, rows_written: 1, rows_read: 0, duration: 1 },
  }
}

function fakeDb(results: unknown[]) {
  const calls: FakeCall[] = []
  return {
    calls,
    db: {
      prepare(sql: string) {
        const call: FakeCall = { sql, params: [] }
        calls.push(call)
        return {
          bind(...params: unknown[]) {
            call.params = params
            return this
          },
          async run() {
            return results.shift()
          },
        }
      },
    } as unknown as D1Database,
  }
}
