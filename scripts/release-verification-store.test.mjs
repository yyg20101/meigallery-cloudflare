import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { recordReleaseVerificationSummary } from './release-verification-store.mjs'

const COMMIT = '18dc11e0b0e4797683d4551a93a1f22e53dc4628'

describe('发布验证 D1 摘要存储', () => {
  it('production 使用空命名环境和生产 D1，并只写布尔摘要', async () => {
    let captured
    const result = await recordReleaseVerificationSummary({
      environment: 'production',
      verificationType: 'meta_resources',
      commit: COMMIT,
      verifiedAt: '2026-07-10T00:00:00.000Z',
      summary: { queuesReady: true, capiEnabled: false },
      runCommand: async (command, args, options) => {
        captured = { command, args, options }
        return { name: options.name, status: 'passed', exitCode: 0, stdout: 'resource-id-sensitive', stderr: '', summary: 'raw output' }
      },
    })

    assert.equal(captured.command, 'corepack')
    assert.deepEqual(captured.args.slice(0, 8), [
      'pnpm', '--filter', '@meigallery/api', 'exec', 'wrangler', 'd1', 'execute', 'meigallery-db',
    ])
    assert.deepEqual(captured.args.slice(8, 10), ['--env', ''])
    const sql = captured.args[captured.args.indexOf('--command') + 1]
    assert.match(sql, new RegExp(`rvf_production_meta_resources_${COMMIT}`))
    assert.match(sql, /2026-07-11T00:00:00\.000Z/)
    assert.equal(sql.includes('resource-id-sensitive'), false)
    assert.equal(result.stdout, undefined)
    assert.equal(result.stderr, undefined)
  })

  it('dev 使用 dev 命名环境和独立 D1', async () => {
    let args
    await recordReleaseVerificationSummary({
      environment: 'dev',
      verificationType: 'meta_live',
      commit: COMMIT,
      verifiedAt: '2026-07-10T00:00:00.000Z',
      summary: { eventsVerified: true },
      runCommand: async (_command, commandArgs, options) => {
        args = commandArgs
        return { name: options.name, status: 'passed', exitCode: 0, stdout: '', stderr: '', summary: 'ok' }
      },
    })

    assert.equal(args.includes('meigallery-db-dev'), true)
    assert.deepEqual(args.slice(args.indexOf('meigallery-db-dev') + 1, args.indexOf('meigallery-db-dev') + 3), ['--env', 'dev'])
  })

  it('拒绝非法 type、commit 和非布尔摘要，避免敏感值进入 SQL', async () => {
    for (const overrides of [
      { verificationType: 'other' },
      { commit: 'short-sha' },
      { summary: { tokenPresent: 'SECRET_TOKEN_VALUE' } },
    ]) {
      await assert.rejects(async () => {
        await recordReleaseVerificationSummary({
          environment: 'dev',
          verificationType: 'meta_live',
          commit: COMMIT,
          verifiedAt: '2026-07-10T00:00:00.000Z',
          summary: { passed: true },
          runCommand: async () => assert.fail('非法输入不得执行命令'),
          ...overrides,
        })
      })
    }
  })
})
