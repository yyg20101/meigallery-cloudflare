import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { runDevRehearsalVerification } from './verify-dev-rehearsal.mjs'

describe('开发环境发布预演验证', () => {
  it('缺少 dev URL 环境变量时直接失败', async () => {
    await assert.rejects(async () => {
      await runDevRehearsalVerification({
        env: {},
      })
    }, /VERIFY_DEV_API_URL/)
  })

  it('执行远端迁移、部署和 smoke，并在缺少 test event code 时记 note', async () => {
    const commands = []
    const requestedUrls = []
    const responses = [
      jsonResponse(200, { status: 'ok', db: 'ok' }),
      textResponse(200, '<!doctype html><html><body><div id="__nuxt"></div><script>window.__APP__="wajie"</script></body></html>'),
      jsonResponse(200, { data: { id: 'conv_1', actionType: 'contact', created: true } }),
      jsonResponse(200, { data: { id: 'conv_2', actionType: 'start_trial', created: true } }),
      jsonResponse(200, { data: { id: 'conv_3', actionType: 'complete_registration', created: true } }),
      jsonResponse(200, { accepted: 3, rejected: 0 }),
      jsonResponse(200, {
        data: {
          stages: [
            { key: 'page_views', value: 2 },
            { key: 'key_clicks', value: 1 },
            { key: 'contacts_or_registers', value: 2 },
          ],
        },
      }),
      jsonResponse(200, {
        data: {
          bySource: [
            {
              source_name: 'release-dev-fb',
              contact_count: 1,
              complete_registration_count: 1,
              start_trial_count: 1,
            },
          ],
        },
      }),
      jsonResponse(202, {
        data: {
          status: 'skipped',
          reason: 'missing_secret',
          testEventCodePresent: false,
        },
      }),
    ]

    const result = await runDevRehearsalVerification({
      env: {
        VERIFY_DEV_API_URL: 'https://api-dev.example.workers.dev',
        VERIFY_DEV_WEB_URL: 'https://web-dev.example.workers.dev/',
      },
      runCommand: async (command, args, options) => {
        commands.push([command, ...args].join(' '))
        return {
          name: options.name,
          status: 'passed',
          durationMs: 1,
          command: options.reportCommand || [command, ...args].join(' '),
          exitCode: 0,
          summary: 'ok',
          stdout: 'ok',
          stderr: '',
        }
      },
      fetch: async (url) => {
        requestedUrls.push(String(url))
        const response = responses.shift()
        if (!response) throw new Error('缺少模拟响应')
        return response
      },
    })

    assert.equal(result.steps.every(step => step.status === 'passed'), true)
    assert.equal(result.notes.includes('meta-test-event-code-missing'), true)
    assert.equal(commands.some(command => command.includes('wrangler d1 migrations apply meigallery-db-dev --env dev --remote')), true)
    assert.equal(commands.some(command => command.includes('wrangler deploy --env dev')), true)
    assert.equal(requestedUrls.some(url => url.includes('/api/admin/attribution/conversions?') && url.includes('sourceCode=release-dev-fb')), true)
  })
})

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function textResponse(status, body) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
}
