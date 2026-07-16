import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import {
  assertReportCanGateProduction,
  redact,
  redactMachineOutput,
  writeReport,
} from './release-verification-lib.mjs'

const COMMIT = 'a'.repeat(40)

function validReport() {
  return {
    schemaVersion: 1,
    mode: 'release',
    status: 'passed',
    startedAt: '2026-07-16T00:00:00.000Z',
    finishedAt: '2026-07-16T00:05:00.000Z',
    durationMs: 300_000,
    git: { branch: 'main', commit: COMMIT, isClean: true, remote: 'origin' },
    versions: { node: 'v24.0.0', pnpm: '10.0.0', wrangler: '4.0.0' },
    steps: ['quick', 'local-runtime', 'dev-rehearsal'].map(mode => ({
      name: mode,
      status: 'passed',
      durationMs: 1,
      command: `node scripts/verify-release.mjs ${mode}`,
      exitCode: 0,
      summary: `/tmp/${mode}.json`,
    })),
    releaseSubModes: ['quick', 'local-runtime', 'dev-rehearsal'].map(mode => ({
      mode,
      status: 'passed',
      reportFile: `/tmp/${mode}.json`,
    })),
    artifacts: [],
    notes: [],
  }
}

describe('通用发布验证基础库', () => {
  it('脱敏凭证和结构化隐私数据', () => {
    const text = redact('access_token=abc secret=xyz cookie=foo https://user:pass@example.com/repo.git')
    assert.equal(text.includes('abc'), false)
    assert.equal(text.includes('xyz'), false)
    assert.equal(text.includes('user:pass'), false)

    const structured = redactMachineOutput(JSON.stringify({ authorization: 'Bearer token' }))
    assert.equal(structured.includes('Bearer token'), false)
  })

  it('生产门禁接受完整的通用 release 报告', () => {
    assert.doesNotThrow(() => assertReportCanGateProduction(validReport(), {
      now: '2026-07-16T01:00:00.000Z',
      currentBranch: 'main',
      expectedCommit: COMMIT,
    }))
  })

  it('生产门禁拒绝失败、过期和缺少子模式的报告', () => {
    const base = validReport()
    assert.throws(() => assertReportCanGateProduction({ ...base, status: 'failed' }, {
      now: '2026-07-16T01:00:00.000Z', currentBranch: 'main', expectedCommit: COMMIT,
    }), /不是 passed/)
    assert.throws(() => assertReportCanGateProduction(base, {
      now: '2026-07-18T01:00:00.000Z', currentBranch: 'main', expectedCommit: COMMIT,
    }), /已过期/)
    assert.throws(() => assertReportCanGateProduction({ ...base, releaseSubModes: base.releaseSubModes.slice(0, 2) }, {
      now: '2026-07-16T01:00:00.000Z', currentBranch: 'main', expectedCommit: COMMIT,
    }), /dev-rehearsal/)
  })

  it('写入报告时不泄露凭证或用户数据', async () => {
    const reportDir = await mkdtemp(path.join(tmpdir(), 'release-report-'))
    try {
      const report = {
        ...validReport(),
        notes: ['token=secret-value', 'email=user@example.com'],
      }
      const result = await writeReport(report, { reportDir })
      const content = await readFile(result.reportFile, 'utf8')
      assert.equal(content.includes('secret-value'), false)
      assert.equal(content.includes('user@example.com'), false)
    }
    finally {
      await rm(reportDir, { recursive: true, force: true })
    }
  })
})
