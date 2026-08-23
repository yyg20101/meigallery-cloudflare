import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Miniflare } from 'miniflare'
import {
  AppViewerInteractionError,
  listViewerInteractions,
  parseAppViewerInteractionQuery,
  setViewerInteraction,
} from './app-viewer-interactions'

const PUBLIC_MIGRATION = readFileSync(
  new URL('../../migrations/0067_app_public_profile_projection.sql', import.meta.url),
  'utf8',
)
const SUPPLY_MIGRATION = readFileSync(
  new URL('../../migrations/0068_app_person_supply_workflow.sql', import.meta.url),
  'utf8',
)
const INTERACTION_MIGRATION = readFileSync(
  new URL('../../migrations/0070_app_viewer_interactions.sql', import.meta.url),
  'utf8',
)
const TAXONOMY_MIGRATION = readFileSync(
  new URL('../../migrations/0081_app_taxonomy_catalog.sql', import.meta.url),
  'utf8',
)
const NOW = new Date('2026-08-06T08:00:00.000Z')

let miniflare: Miniflare
let db: D1Database

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-07-12',
    d1Databases: { DB: 'app-viewer-interactions' },
  })
  db = (await miniflare.getBindings<{ DB: D1Database }>()).DB
  await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY);')
  await db.exec(executableSql(`
    CREATE TABLE galleries (
      id TEXT PRIMARY KEY,
      cover_key TEXT,
      status TEXT NOT NULL
    );
  `))
  await db.exec(executableSql(PUBLIC_MIGRATION))
  await db.exec(executableSql(SUPPLY_MIGRATION))
  await db.exec(executableSql(INTERACTION_MIGRATION))
  await db.exec(executableSql(TAXONOMY_MIGRATION))
  await db.exec(executableSql(`
    CREATE TABLE app_profile_blocks (
      account_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      profile_id TEXT NOT NULL,
      state TEXT NOT NULL,
      PRIMARY KEY (account_id, profile_id)
    );
  `))
})

beforeEach(async () => {
  await db.exec(`
    DELETE FROM app_profile_blocks;
    DELETE FROM app_viewer_interactions;
    DELETE FROM profile_public_projections;
    DELETE FROM galleries;
    DELETE FROM users;
    INSERT INTO users (id) VALUES (1), (2);
  `)
})

afterAll(async () => {
  await miniflare.dispose()
})

describe('App 观看者喜欢与关注 D1 关系', () => {
  it('重复 PUT 保持单条关系且喜欢与关注彼此独立', async () => {
    await insertEligibleProfile('pp_alpha')

    await setViewerInteraction(db, 1, 'pp_alpha', 'like', true, NOW)
    const repeated = await setViewerInteraction(db, 1, 'pp_alpha', 'like', true, NOW)
    const followed = await setViewerInteraction(db, 1, 'pp_alpha', 'follow', true, NOW)

    expect(repeated).toMatchObject({ profileId: 'pp_alpha', liked: true, followed: false })
    expect(followed).toMatchObject({ liked: true, followed: true })
    const count = await db.prepare(`
      SELECT COUNT(*) AS count FROM app_viewer_interactions WHERE account_id = 1
    `).first<{ count: number }>()
    expect(Number(count?.count)).toBe(2)
  })

  it('不可用资料拒绝新增，但既有关系可在失效后幂等取消', async () => {
    await insertEligibleProfile('pp_visible')
    await insertEligibleProfile('pp_hidden', 'hidden')

    await expect(setViewerInteraction(db, 1, 'pp_hidden', 'like', true, NOW))
      .rejects.toMatchObject({ code: 'PROFILE_NOT_AVAILABLE', status: 404 })

    await setViewerInteraction(db, 1, 'pp_visible', 'like', true, NOW)
    await db.prepare(`
      UPDATE profile_public_projections SET visibility_status = 'hidden' WHERE profile_id = ?
    `).bind('pp_visible').run()

    await expect(setViewerInteraction(db, 1, 'pp_visible', 'like', false, NOW))
      .resolves.toMatchObject({ liked: false, followed: false })
    await expect(setViewerInteraction(db, 1, 'pp_visible', 'like', false, NOW))
      .resolves.toMatchObject({ liked: false, followed: false })
  })

  it('拉黑状态由服务端阻止新增喜欢与关注', async () => {
    await insertEligibleProfile('pp_blocked')
    await db.prepare(`
      INSERT INTO app_profile_blocks (account_id, profile_id, state)
      VALUES (1, 'pp_blocked', 'blocked')
    `).run()

    await expect(setViewerInteraction(db, 1, 'pp_blocked', 'like', true, NOW))
      .rejects.toMatchObject({ code: 'INTERACTION_FORBIDDEN', status: 403 })
    await expect(setViewerInteraction(db, 1, 'pp_blocked', 'follow', true, NOW))
      .rejects.toMatchObject({ code: 'INTERACTION_FORBIDDEN', status: 403 })
  })

  it('本人列表隔离账号、稳定分页并最小化不可用资料', async () => {
    await insertEligibleProfile('pp_alpha')
    await insertEligibleProfile('pp_beta')
    await insertEligibleProfile('pp_other')
    await setViewerInteraction(db, 1, 'pp_alpha', 'like', true, new Date('2026-08-06T07:00:00.000Z'))
    await setViewerInteraction(db, 1, 'pp_beta', 'like', true, new Date('2026-08-06T06:00:00.000Z'))
    await setViewerInteraction(db, 2, 'pp_other', 'like', true, new Date('2026-08-06T07:30:00.000Z'))
    await db.prepare(`
      UPDATE profile_public_projections SET publication_status = 'unpublished' WHERE profile_id = ?
    `).bind('pp_beta').run()

    const firstQuery = parseAppViewerInteractionQuery({
      limit: '1',
      accountScope: 'acc_one',
      interactionType: 'like',
    })
    const first = await listViewerInteractions(
      db,
      1,
      'acc_one',
      'like',
      firstQuery,
      'https://api.test/api/v2/me/likes',
      NOW,
    )
    expect(first.data).toHaveLength(1)
    expect(first.data[0]).toMatchObject({
      profileId: 'pp_alpha',
      interactionType: 'like',
      unavailableReason: null,
      profile: { profileId: 'pp_alpha' },
    })
    expect(first.hasMore).toBe(true)

    const secondQuery = parseAppViewerInteractionQuery({
      limit: '1',
      cursor: first.nextCursor!,
      accountScope: 'acc_one',
      interactionType: 'like',
    })
    const second = await listViewerInteractions(
      db,
      1,
      'acc_one',
      'like',
      secondQuery,
      'https://api.test/api/v2/me/likes',
      NOW,
    )
    expect(second.data).toEqual([
      expect.objectContaining({
        profileId: 'pp_beta',
        profile: null,
        unavailableReason: 'PROFILE_NOT_AVAILABLE',
      }),
    ])
    expect(second.hasMore).toBe(false)
  })

  it('游标绑定账号范围与关系类型', async () => {
    await insertEligibleProfile('pp_alpha')
    await insertEligibleProfile('pp_beta')
    await setViewerInteraction(db, 1, 'pp_alpha', 'like', true, NOW)
    await setViewerInteraction(db, 1, 'pp_beta', 'like', true, new Date('2026-08-06T07:00:00.000Z'))
    const first = await listViewerInteractions(
      db,
      1,
      'acc_one',
      'like',
      parseAppViewerInteractionQuery({
        limit: '1',
        accountScope: 'acc_one',
        interactionType: 'like',
      }),
      'https://api.test/api/v2/me/likes',
      NOW,
    )

    expect(() => parseAppViewerInteractionQuery({
      cursor: first.nextCursor!,
      accountScope: 'acc_two',
      interactionType: 'like',
    })).toThrow(AppViewerInteractionError)
    expect(() => parseAppViewerInteractionQuery({
      cursor: first.nextCursor!,
      accountScope: 'acc_one',
      interactionType: 'follow',
    })).toThrow(AppViewerInteractionError)
  })

  it('migration 不包含种子且只允许喜欢与关注', async () => {
    expect(INTERACTION_MIGRATION).not.toMatch(/\bINSERT\b/iu)
    expect(INTERACTION_MIGRATION).toContain("interaction_type IN ('like', 'follow')")
    await expect(db.prepare(`
      INSERT INTO app_viewer_interactions (
        account_id, profile_id, interaction_type, created_at
      ) VALUES (1, 'pp_alpha', 'favorite', ?)
    `).bind(NOW.toISOString()).run()).rejects.toThrow()
  })
})

async function insertEligibleProfile(profileId: string, visibility = 'visible') {
  const galleryId = `gal_${profileId}`
  await db.prepare('INSERT INTO galleries (id, cover_key, status) VALUES (?, ?, ?)')
    .bind(galleryId, `covers/${profileId}.jpg`, 'published')
    .run()
  await db.prepare(`
    INSERT INTO profile_public_projections (
      profile_id,
      person_id,
      display_name,
      summary,
      source_gallery_id,
      tags_json,
      verification_status,
      publication_status,
      authorization_status,
      authorization_valid_until,
      visibility_status,
      operation_mode,
      operation_label,
      region_code,
      region_label,
      region_precision,
      recommendation_score,
      heat_score,
      recommendation_reason_code,
      recommendation_rule_version,
      published_at,
      source_updated_at,
      authorization_valid_from,
      verification_valid_until
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    profileId,
    profileId.replace(/^pp_/u, 'per_'),
    `人物 ${profileId}`,
    '公开简介',
    galleryId,
    '["清新"]',
    'verified',
    'published',
    'active',
    null,
    visibility,
    'platform_managed',
    '消息由平台运营接收',
    'cn-bj',
    '北京市',
    'city',
    10,
    10,
    'EDITORIAL_QUALITY',
    'discovery_v1',
    '2026-08-01T00:00:00.000Z',
    '2026-08-01T00:00:00.000Z',
    null,
    null,
  ).run()
}

function executableSql(sql: string) {
  return sql
    .split(/\r?\n/u)
    .filter(line => !line.trimStart().startsWith('--'))
    .join(' ')
}
