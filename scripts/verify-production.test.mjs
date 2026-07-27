import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  assertAttributionStructure,
  attributionWarnings,
  queryAttributionState,
  verifyProduction,
} from './verify-production.mjs'

const healthyState = {
  attributionCoreTableCount: 9,
  obsoleteAttributionTableCount: 0,
  trackingSourceProofColumnCount: 0,
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

  it('最终表结构缺失或旧控制面残留时阻断，运行异常只警告', () => {
    assert.throws(() => assertAttributionStructure({
      ...healthyState,
      attributionCoreTableCount: 8,
    }), /attributionCoreTableCount/)
    assert.throws(() => assertAttributionStructure({
      ...healthyState,
      obsoleteAttributionTableCount: 1,
    }), /obsoleteAttributionTableCount/)
    assert.throws(() => assertAttributionStructure({
      ...healthyState,
      trackingSourceProofColumnCount: 1,
    }), /trackingSourceProofColumnCount/)
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
    assert.match(query, /attribution_platform_connections/)
    assert.match(query, /obsolete_attribution_table_count/)
    assert.match(query, /tracking_source_proof_column_count/)
    assert.doesNotMatch(query, /d1_migrations/)
    assert.doesNotMatch(query, /credential_revision|connection_revision|binding\.provider/)
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
