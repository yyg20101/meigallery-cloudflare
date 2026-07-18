import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { after, describe, it } from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tempDir = mkdtempSync(join(tmpdir(), 'meigallery-privacy-switzerland-'))
const database = join(tempDir, 'policy.sqlite')
const createPolicy = readFileSync(new URL('./0053_attribution_privacy_policy.sql', import.meta.url), 'utf8')
const addSwitzerland = readFileSync(new URL('./0054_attribution_privacy_switzerland.sql', import.meta.url), 'utf8')

after(() => rmSync(tempDir, { recursive: true, force: true }))

describe('0054 瑞士严格地区 migration', () => {
  it('只追加瑞士并保留现有地区配置', () => {
    execFileSync('sqlite3', [database], { input: createPolicy, encoding: 'utf8' })
    execFileSync('sqlite3', [database, `
      UPDATE attribution_privacy_policy
      SET prior_consent_country_codes_json = '["GB","FR"]', policy_version = 7;
    `])
    execFileSync('sqlite3', [database], { input: addSwitzerland, encoding: 'utf8' })

    const rows = JSON.parse(execFileSync('sqlite3', ['-json', database, `
      SELECT prior_consent_country_codes_json AS countries, policy_version
      FROM attribution_privacy_policy WHERE id = 'global';
    `], { encoding: 'utf8' }))
    assert.deepEqual(rows, [{ countries: '["GB","FR","CH"]', policy_version: 8 }])
  })

  it('重复执行不会重复追加或提升版本', () => {
    execFileSync('sqlite3', [database], { input: addSwitzerland, encoding: 'utf8' })
    const rows = JSON.parse(execFileSync('sqlite3', ['-json', database, `
      SELECT json_array_length(prior_consent_country_codes_json) AS country_count, policy_version
      FROM attribution_privacy_policy WHERE id = 'global';
    `], { encoding: 'utf8' }))
    assert.deepEqual(rows, [{ country_count: 3, policy_version: 8 }])
  })
})
