import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  assertAttributionStructure,
  attributionWarnings,
  queryAttributionState,
  verifyProduction,
} from './verify-production.mjs'

const healthyState = {
  sourceRouterCleanupMigrationCount: 1,
  invalidConnectionCount: 0,
  openCriticalIncidentCount: 0,
  expiredOutboxCount: 0,
  deadLetterCount: 0,
  invalidFactSourceCount: 0,
}

describe('生产快速验证', () => {
  it('API 验证只检查生产可用性和结构，不绑定 Git commit', async () => {
    const result = await verifyProduction('api', {
      fetch: async () => new Response(JSON.stringify({
        status: 'ok',
        environment: 'production',
        commit: 'different-deployment-is-observable-only',
      })),
      runCommand: async () => d1Result(healthyState),
    })

    assert.equal(result.status, 'passed')
    assert.deepEqual(result.endpoints.map(item => item.target), ['api'])
  })

  it('all 同时检查 API/Web，但只查询一次 D1', async () => {
    let queries = 0
    const result = await verifyProduction('all', {
      fetch: async () => new Response(JSON.stringify({ status: 'ok', environment: 'production' })),
      runCommand: async () => {
        queries += 1
        return d1Result(healthyState)
      },
    })
    assert.deepEqual(result.endpoints.map(item => item.target).sort(), ['api', 'web'])
    assert.equal(queries, 1)
  })

  it('migration 缺失阻断，配置和运行异常只警告且不妨碍修复发布', () => {
    assert.throws(() => assertAttributionStructure({
      ...healthyState,
      sourceRouterCleanupMigrationCount: 0,
    }), /sourceRouterCleanupMigrationCount/)
    assert.doesNotThrow(() => assertAttributionStructure({
      ...healthyState,
      invalidConnectionCount: 1,
    }))
    assert.deepEqual(attributionWarnings({
      ...healthyState,
      invalidConnectionCount: 1,
      deadLetterCount: 2,
      expiredOutboxCount: 1,
    }), ['invalidConnectionCount=1', 'expiredOutboxCount=1', 'deadLetterCount=2'])
  })

  it('D1 响应解析为稳定字段', async () => {
    let query = ''
    const state = await queryAttributionState({
      runCommand: async (_command, args) => {
        query = String(args[args.indexOf('--command') + 1] || '')
        return d1Result(healthyState)
      },
    })
    assert.deepEqual(state, healthyState)
    assert.match(query, /0061_attribution_source_router_cleanup\.sql/)
    assert.doesNotMatch(query, /attribution_privacy_policy|credential_revision|connection_revision|binding\.provider/)
  })
})

function d1Result(state) {
  return {
    exitCode: 0,
    stderr: '',
    stdout: JSON.stringify([{
      results: [Object.fromEntries(Object.entries(state).map(([key, value]) => [
        key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`),
        value,
      ]))],
    }]),
  }
}
