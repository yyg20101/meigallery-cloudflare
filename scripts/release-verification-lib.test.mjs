import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import {
  assertReportCanGateProduction,
  redact,
  writeReport,
} from './release-verification-lib.mjs'

describe('发布验证基础库', () => {
  it('redact 会隐藏 token、secret、cookie 和 session', () => {
    const input = 'access_token=abc token:123 secret=xyz cookie=foo session=bar password=baz'
    const output = redact(input)

    assert.match(output, /access_token=\[REDACTED\]/i)
    assert.match(output, /token:\[REDACTED\]/i)
    assert.match(output, /secret=\[REDACTED\]/i)
    assert.match(output, /cookie=\[REDACTED\]/i)
    assert.match(output, /session=\[REDACTED\]/i)
    assert.match(output, /password=\[REDACTED\]/i)
  })

  it('writeReport 同时写入时间戳文件和 latest.json', async () => {
    const reportDir = await mkdtemp(path.join(tmpdir(), 'release-verify-'))
    const report = {
      schemaVersion: 1,
      mode: 'quick',
      status: 'passed',
      startedAt: '2026-07-09T00:00:00.000Z',
      finishedAt: '2026-07-09T00:05:00.000Z',
      durationMs: 300000,
      git: {
        branch: 'dev',
        commit: 'abcdef1234567890',
        isClean: true,
        remote: 'git@github.com:yyg20101/meigallery-cloudflare.git',
      },
      versions: {
        node: 'v24.0.0',
        pnpm: '10.0.0',
        wrangler: '4.0.0',
      },
      steps: [],
      artifacts: [],
      notes: [],
    }

    try {
      const { reportFile, latestFile } = await writeReport(report, { reportDir })
      const [timestampContent, latestContent] = await Promise.all([
        readFile(reportFile, 'utf8'),
        readFile(latestFile, 'utf8'),
      ])

      assert.deepEqual(JSON.parse(timestampContent), report)
      assert.deepEqual(JSON.parse(latestContent), report)
      assert.notEqual(path.basename(reportFile), 'latest.json')
    } finally {
      await rm(reportDir, { recursive: true, force: true })
    }
  })

  it('assertReportCanGateProduction 拒绝失败报告、非 release 报告、脏工作区和过期报告', () => {
    const baseReport = {
      schemaVersion: 1,
      mode: 'release',
      status: 'passed',
      startedAt: '2026-07-09T00:00:00.000Z',
      finishedAt: '2026-07-09T00:05:00.000Z',
      durationMs: 300000,
      git: {
        branch: 'main',
        commit: 'abcdef1234567890',
        isClean: true,
        remote: 'origin',
      },
      versions: {
        node: 'v24.0.0',
        pnpm: '10.0.0',
        wrangler: '4.0.0',
      },
      steps: [],
      artifacts: [],
      notes: [],
    }

    assert.throws(() => {
      assertReportCanGateProduction({
        ...baseReport,
        status: 'failed',
      }, { now: '2026-07-09T01:00:00.000Z' })
    }, /报告状态不是 passed/)

    assert.throws(() => {
      assertReportCanGateProduction({
        ...baseReport,
        mode: 'quick',
      }, { now: '2026-07-09T01:00:00.000Z' })
    }, /只接受 release 模式/)

    assert.throws(() => {
      assertReportCanGateProduction({
        ...baseReport,
        git: {
          ...baseReport.git,
          isClean: false,
        },
      }, { now: '2026-07-09T01:00:00.000Z' })
    }, /不是干净状态/)

    assert.throws(() => {
      assertReportCanGateProduction(baseReport, {
        now: '2026-07-10T00:06:00.000Z',
        maxAgeMs: 60 * 60 * 1000,
      })
    }, /报告已过期/)
  })
})
