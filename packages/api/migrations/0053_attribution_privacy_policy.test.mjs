import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

const tempDir = mkdtempSync(join(tmpdir(), 'meigallery-privacy-policy-'))
const database = join(tempDir, 'policy.sqlite')
const migration = readFileSync(new URL('./0053_attribution_privacy_policy.sql', import.meta.url), 'utf8')

after(() => rmSync(tempDir, { recursive: true, force: true }))

describe('0053 地区归因策略 migration', () => {
  it('创建唯一全局策略并默认使用按地区通知退出模式', () => {
    execFileSync('sqlite3', [database], { input: migration, encoding: 'utf8' })
    const rows = JSON.parse(execFileSync('sqlite3', ['-json', database, `
      SELECT default_mode, policy_version, json_array_length(prior_consent_country_codes_json) AS country_count
      FROM attribution_privacy_policy
      WHERE id = 'global';
    `], { encoding: 'utf8' }))

    assert.deepEqual(rows, [{ default_mode: 'notice_opt_out', policy_version: 1, country_count: 38 }])
  })

  it('重复执行不会重置已修改策略', () => {
    execFileSync('sqlite3', [database, `UPDATE attribution_privacy_policy SET default_mode = 'disabled', policy_version = 2;`])
    execFileSync('sqlite3', [database], { input: migration, encoding: 'utf8' })
    const mode = execFileSync('sqlite3', [database, `SELECT default_mode FROM attribution_privacy_policy;`], { encoding: 'utf8' }).trim()
    assert.equal(mode, 'disabled')
  })
})
