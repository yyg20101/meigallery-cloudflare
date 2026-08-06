import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Miniflare } from 'miniflare'
import {
  getPublicPersonProfile,
  listPublicDiscoveryRegions,
  listPublicPersonProfiles,
  parseAppDiscoveryQuery,
} from './app-discovery'

const MIGRATION = readFileSync(
  new URL('../../migrations/0067_app_public_profile_projection.sql', import.meta.url),
  'utf8',
)
const SUPPLY_MIGRATION = readFileSync(
  new URL('../../migrations/0068_app_person_supply_workflow.sql', import.meta.url),
  'utf8',
)
const NOW = new Date('2026-08-02T00:00:00.000Z')

let miniflare: Miniflare
let db: D1Database

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-07-12',
    d1Databases: { DB: 'app-discovery' },
  })
  db = (await miniflare.getBindings<{ DB: D1Database }>()).DB
  await db.exec(executableSql(`
    CREATE TABLE galleries (
      id TEXT PRIMARY KEY,
      cover_key TEXT,
      status TEXT NOT NULL
    );
    CREATE TABLE app_profile_blocks (
      account_id INTEGER NOT NULL,
      profile_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('blocked', 'unblocked')),
      PRIMARY KEY (account_id, profile_id)
    );
  `))
  await db.exec(executableSql(MIGRATION))
  await db.exec(executableSql(SUPPLY_MIGRATION))
})

beforeEach(async () => {
  await db.exec('DELETE FROM app_profile_blocks; DELETE FROM profile_public_projections; DELETE FROM galleries;')
})

afterAll(async () => {
  await miniflare.dispose()
})

describe('App 公开人物投影 D1 查询', () => {
  it('没有经过显式投影的现有图库不会自动进入发现列表', async () => {
    await insertGallery('gal_only', 'published')

    const result = await listPublicPersonProfiles(
      db,
      parseAppDiscoveryQuery({}),
      'https://api.test/api/v2/discovery/feed',
      NOW,
    )

    expect(result.data).toEqual([])
    expect(result.hasMore).toBe(false)
  })

  it('只返回认证、发布、授权有效、可见且来源图库仍发布的人物', async () => {
    await seedEligibilityCases()

    const result = await listPublicPersonProfiles(
      db,
      parseAppDiscoveryQuery({ sort: 'recommended' }),
      'https://api.test/api/v2/discovery/feed',
      NOW,
    )

    expect(result.data.map(item => item.profileId)).toEqual([
      'pp_beijing_new',
      'pp_shanghai',
      'pp_beijing_hot',
    ])
    expect(result.data[0]).toMatchObject({
      personId: 'per_beijing_new',
      coverUrl: 'https://api.test/api/media/cover/gal_beijing_new',
      verification: { status: 'verified' },
      operation: { mode: 'platform_managed', label: '消息由平台运营接收' },
      region: { code: 'cn-bj', label: '北京市', precision: 'city' },
    })
  })

  it('地区与热度排序使用稳定不透明游标且不会重复记录', async () => {
    await seedEligibilityCases()

    const first = await listPublicPersonProfiles(
      db,
      parseAppDiscoveryQuery({ sort: 'popular', region: 'cn-bj', limit: '1' }),
      'https://api.test/api/v2/discovery/feed',
      NOW,
    )
    expect(first.data.map(item => item.profileId)).toEqual(['pp_beijing_hot'])
    expect(first.hasMore).toBe(true)
    expect(first.nextCursor).toEqual(expect.any(String))

    const second = await listPublicPersonProfiles(
      db,
      parseAppDiscoveryQuery({
        sort: 'popular',
        region: 'cn-bj',
        limit: '1',
        cursor: first.nextCursor!,
      }),
      'https://api.test/api/v2/discovery/feed',
      NOW,
    )
    expect(second.data.map(item => item.profileId)).toEqual(['pp_beijing_new'])
    expect(second.hasMore).toBe(false)
    expect(second.nextCursor).toBeNull()
  })

  it('登录观看者的发现列表由服务端排除已屏蔽人物，匿名列表不受影响', async () => {
    await seedEligibilityCases()
    await db.prepare(`
      INSERT INTO app_profile_blocks (account_id, profile_id, state)
      VALUES (7, 'pp_beijing_new', 'blocked'), (7, 'pp_shanghai', 'unblocked')
    `).run()

    const query = parseAppDiscoveryQuery({ sort: 'recommended' })
    const anonymous = await listPublicPersonProfiles(
      db,
      query,
      'https://api.test/api/v2/discovery/feed',
      NOW,
    )
    const authenticated = await listPublicPersonProfiles(
      db,
      query,
      'https://api.test/api/v2/discovery/feed',
      NOW,
      7,
    )

    expect(anonymous.data.map(item => item.profileId)).toContain('pp_beijing_new')
    expect(authenticated.data.map(item => item.profileId)).not.toContain('pp_beijing_new')
    expect(authenticated.data.map(item => item.profileId)).toContain('pp_shanghai')
  })

  it('地区目录与人物详情复用同一公开资格边界', async () => {
    await seedEligibilityCases()

    await expect(listPublicDiscoveryRegions(db, NOW)).resolves.toEqual([
      { code: 'cn-bj', label: '北京市', profileCount: 2 },
      { code: 'cn-sh', label: '上海市', profileCount: 1 },
    ])
    await expect(getPublicPersonProfile(
      db,
      'pp_beijing_hot',
      'https://api.test/api/v2/person-profiles/pp_beijing_hot',
      NOW,
    )).resolves.toMatchObject({ profileId: 'pp_beijing_hot' })
    await expect(getPublicPersonProfile(
      db,
      'pp_hidden',
      'https://api.test/api/v2/person-profiles/pp_hidden',
      NOW,
    )).resolves.toBeNull()
  })

  it('migration 不写入种子且拒绝非法资格状态', async () => {
    expect(MIGRATION).not.toMatch(/\bINSERT\b/iu)
    expect(MIGRATION).toContain("verification_status IN ('pending', 'verified', 'rejected', 'suspended')")
    await insertGallery('gal_invalid', 'published')
    await expect(insertProjection({
      profileId: 'pp_invalid',
      verificationStatus: 'unknown',
      sourceGalleryId: 'gal_invalid',
    })).rejects.toThrow()
    await expect(insertProjection({
      profileId: 'pp_invalid_date',
      authorizationValidUntil: 'not-a-date',
      sourceGalleryId: 'gal_invalid',
    })).rejects.toThrow()
  })
})

async function seedEligibilityCases() {
  for (const [id, status] of [
    ['gal_beijing_hot', 'published'],
    ['gal_beijing_new', 'published'],
    ['gal_shanghai', 'published'],
    ['gal_hidden', 'published'],
    ['gal_expired', 'published'],
    ['gal_future_authorization', 'published'],
    ['gal_expired_verification', 'published'],
    ['gal_unpublished', 'unpublished'],
  ] as const) {
    await insertGallery(id, status)
  }

  await insertProjection({
    profileId: 'pp_beijing_hot',
    sourceGalleryId: 'gal_beijing_hot',
    regionCode: 'cn-bj',
    regionLabel: '北京市',
    recommendationScore: 50,
    heatScore: 100,
    publishedAt: '2026-07-10T00:00:00.000Z',
  })
  await insertProjection({
    profileId: 'pp_beijing_new',
    sourceGalleryId: 'gal_beijing_new',
    regionCode: 'cn-bj',
    regionLabel: '北京市',
    recommendationScore: 90,
    heatScore: 20,
    publishedAt: '2026-07-20T00:00:00.000Z',
  })
  await insertProjection({
    profileId: 'pp_shanghai',
    sourceGalleryId: 'gal_shanghai',
    regionCode: 'cn-sh',
    regionLabel: '上海市',
    recommendationScore: 70,
    heatScore: 80,
    publishedAt: '2026-07-15T00:00:00.000Z',
  })
  await insertProjection({
    profileId: 'pp_hidden',
    sourceGalleryId: 'gal_hidden',
    visibilityStatus: 'hidden',
    recommendationScore: 200,
  })
  await insertProjection({
    profileId: 'pp_expired',
    sourceGalleryId: 'gal_expired',
    authorizationValidUntil: '2026-07-01T00:00:00.000Z',
    recommendationScore: 200,
  })
  await insertProjection({
    profileId: 'pp_future_authorization',
    sourceGalleryId: 'gal_future_authorization',
    authorizationValidFrom: '2026-08-03T00:00:00.000Z',
    recommendationScore: 200,
  })
  await insertProjection({
    profileId: 'pp_expired_verification',
    sourceGalleryId: 'gal_expired_verification',
    verificationValidUntil: '2026-08-01T00:00:00.000Z',
    recommendationScore: 200,
  })
  await insertProjection({
    profileId: 'pp_unpublished_gallery',
    sourceGalleryId: 'gal_unpublished',
    recommendationScore: 200,
  })
}

async function insertGallery(id: string, status: string) {
  await db.prepare('INSERT INTO galleries (id, cover_key, status) VALUES (?, ?, ?)')
    .bind(id, `covers/${id}.jpg`, status)
    .run()
}

async function insertProjection(options: {
  profileId: string
  sourceGalleryId: string
  verificationStatus?: string
  publicationStatus?: string
  authorizationStatus?: string
  authorizationValidFrom?: string | null
  authorizationValidUntil?: string | null
  verificationValidUntil?: string | null
  visibilityStatus?: string
  regionCode?: string
  regionLabel?: string
  recommendationScore?: number
  heatScore?: number
  publishedAt?: string
}) {
  const personId = options.profileId.replace(/^pp_/u, 'per_')
  return db.prepare(`
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
    options.profileId,
    personId,
    `展示名 ${options.profileId}`,
    '公开简介',
    options.sourceGalleryId,
    '["清新","生活"]',
    options.verificationStatus ?? 'verified',
    options.publicationStatus ?? 'published',
    options.authorizationStatus ?? 'active',
    options.authorizationValidUntil ?? null,
    options.visibilityStatus ?? 'visible',
    'platform_managed',
    '不可信的旧文案',
    options.regionCode ?? 'cn-bj',
    options.regionLabel ?? '北京市',
    'city',
    options.recommendationScore ?? 10,
    options.heatScore ?? 10,
    'PREFERRED_STYLE',
    'discovery_v1',
    options.publishedAt ?? '2026-07-01T00:00:00.000Z',
    '2026-07-31T00:00:00.000Z',
    options.authorizationValidFrom ?? null,
    options.verificationValidUntil ?? null,
  ).run()
}

function executableSql(sql: string) {
  return sql
    .split(/\r?\n/u)
    .filter(line => !line.trimStart().startsWith('--'))
    .join(' ')
}
