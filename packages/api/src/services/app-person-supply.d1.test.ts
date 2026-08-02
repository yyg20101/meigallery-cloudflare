import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Miniflare } from 'miniflare'
import {
  PERSON_VERIFICATION_ITEMS,
  PersonSupplyError,
  createPersonCandidate,
  grantPersonAuthorization,
  listAdminPersons,
  pausePersonPublication,
  reviewPersonPublication,
  reviewPersonVerification,
  submitPersonPublication,
  submitPersonVerification,
  updatePersonCandidate,
} from './app-person-supply'
import { getPublicPersonProfile, listPublicPersonProfiles, parseAppDiscoveryQuery } from './app-discovery'

const PUBLIC_PROJECTION_MIGRATION = readFileSync(
  new URL('../../migrations/0067_app_public_profile_projection.sql', import.meta.url),
  'utf8',
)
const SUPPLY_MIGRATION = readFileSync(
  new URL('../../migrations/0068_app_person_supply_workflow.sql', import.meta.url),
  'utf8',
)
const PUBLIC_QUERY_NOW = new Date('2027-01-01T00:00:00.000Z')

let miniflare: Miniflare
let db: D1Database

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-07-12',
    d1Databases: { DB: 'app-person-supply' },
  })
  db = (await miniflare.getBindings<{ DB: D1Database }>()).DB
  await db.exec(executableSql(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL UNIQUE
    );
    CREATE TABLE galleries (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      cover_key TEXT,
      status TEXT NOT NULL
    );
    CREATE TABLE admin_audit_logs (
      id TEXT PRIMARY KEY,
      admin_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT,
      before_value TEXT,
      after_value TEXT,
      created_at TEXT NOT NULL
    );
  `))
  await db.exec(executableSql(PUBLIC_PROJECTION_MIGRATION))
  await db.exec(executableSql(SUPPLY_MIGRATION))
  await db.prepare("INSERT INTO users (id, email) VALUES (1, 'owner@example.com')").run()
})

beforeEach(async () => {
  await db.exec(executableSql(`
    DELETE FROM profile_public_projections;
    DELETE FROM person_publication_reviews;
    DELETE FROM person_verifications;
    DELETE FROM person_authorizations;
    DELETE FROM person_profiles;
    DELETE FROM persons;
    DELETE FROM admin_audit_logs;
    DELETE FROM galleries;
  `))
})

afterAll(async () => {
  await miniflare.dispose()
})

describe('App 人物供给工作流', () => {
  it('候选草稿不会自动进入公开发现，发布门禁会返回完整阻塞项', async () => {
    expect(SUPPLY_MIGRATION).not.toMatch(/INSERT\s+INTO\s+(persons|person_profiles|person_authorizations|person_verifications)/iu)
    await insertGallery('gal_draft_source')
    const candidate = await createCandidate('gal_draft_source', '候选甲')

    await expect(listAdminPersons(db, { q: '候选' })).resolves.toMatchObject({
      data: [{ personId: candidate.personId, displayName: '候选甲' }],
      pagination: { total: 1 },
    })

    await expect(listPublicPersonProfiles(
      db,
      parseAppDiscoveryQuery({}),
      'https://api.test/api/v2/discovery/feed',
      PUBLIC_QUERY_NOW,
    )).resolves.toMatchObject({ data: [] })

    await expect(submitPersonPublication(db, candidate.personId, {
      expectedVersion: candidate.lockVersion,
    }, 1)).rejects.toMatchObject<PersonSupplyError>({
      status: 422,
      code: 'PUBLICATION_GATES_FAILED',
    })
  })

  it('通过授权、四项认证和发布复核后单向生成公开投影并写全链路审计', async () => {
    await insertGallery('gal_publish')
    let detail = await createCandidate('gal_publish', '人物甲')

    detail = await grantPersonAuthorization(db, detail.personId, {
      expectedVersion: detail.lockVersion,
      evidenceRef: 'r2-private://authorizations/case-001',
      validUntil: '2099-01-01T00:00:00.000Z',
    }, 1)
    detail = await submitPersonVerification(db, detail.personId, {
      expectedVersion: detail.lockVersion,
      evidenceRef: 'r2-private://verifications/case-001',
    }, 1)
    detail = await reviewPersonVerification(db, detail.personId, {
      expectedVersion: detail.lockVersion,
      verificationId: detail.currentVerification!.id,
      decision: 'verified',
      verificationItems: PERSON_VERIFICATION_ITEMS,
      validUntil: '2099-01-01T00:00:00.000Z',
    }, 1)
    detail = await submitPersonPublication(db, detail.personId, {
      expectedVersion: detail.lockVersion,
      note: '公开预览已复核',
    }, 1)
    const publicationId = detail.history.publications[0]!.id
    detail = await reviewPersonPublication(db, detail.personId, {
      expectedVersion: detail.lockVersion,
      publicationId,
      decision: 'published',
    }, 1)

    expect(detail).toMatchObject({
      verificationStatus: 'verified',
      authorizationStatus: 'active',
      publicationStatus: 'published',
      contentVersion: 1,
      liveContentVersion: 1,
      liveProjection: { visible: true, profileVersion: 1 },
    })
    await expect(getPublicPersonProfile(
      db,
      detail.profileId,
      `https://api.test/api/v2/person-profiles/${detail.profileId}`,
      PUBLIC_QUERY_NOW,
    )).resolves.toMatchObject({ displayName: '人物甲', profileId: detail.profileId })

    const audits = await db.prepare(`
      SELECT action FROM admin_audit_logs WHERE target_id = ? ORDER BY created_at ASC, action ASC
    `).bind(detail.profileId).all<{ action: string }>()
    expect(audits.results.map(row => row.action).sort()).toEqual([
      'app_person.authorization_grant',
      'app_person.create',
      'app_person.publication_publish',
      'app_person.publication_submit',
      'app_person.verification_approve',
      'app_person.verification_submit',
    ].sort())
  })

  it('编辑已发布资料只创建新草稿版本，不静默覆盖线上快照', async () => {
    await insertGallery('gal_live')
    await insertGallery('gal_next')
    let detail = await publishCandidate('gal_live', '线上名称')

    detail = await updatePersonCandidate(db, detail.personId, {
      expectedVersion: detail.lockVersion,
      sourceGalleryId: 'gal_next',
      displayName: '新草稿名称',
      summary: '仅在草稿中可见',
      tags: ['新标签'],
      regionCode: 'cn-sh',
      regionLabel: '上海市',
      regionPrecision: 'city',
      recommendationScore: 100,
      heatScore: 10,
    }, 1)

    expect(detail).toMatchObject({
      displayName: '新草稿名称',
      contentVersion: 2,
      liveContentVersion: 1,
      verificationStatus: 'unverified',
      publicationStatus: 'draft',
      liveProjection: { visible: true, profileVersion: 1 },
    })
    await expect(getPublicPersonProfile(
      db,
      detail.profileId,
      `https://api.test/api/v2/person-profiles/${detail.profileId}`,
      PUBLIC_QUERY_NOW,
    )).resolves.toMatchObject({ displayName: '线上名称' })
  })

  it('暂停公开投影后详情与发现列表立即不可见', async () => {
    await insertGallery('gal_pause')
    let detail = await publishCandidate('gal_pause', '待暂停人物')

    detail = await pausePersonPublication(db, detail.personId, {
      expectedVersion: detail.lockVersion,
      reasonCode: 'MANUAL_SAFETY_REVIEW',
      note: '等待人工复核',
    }, 1)

    expect(detail).toMatchObject({
      publicationStatus: 'suspended',
      liveProjection: { visible: false, visibilityStatus: 'suspended' },
    })
    await expect(getPublicPersonProfile(
      db,
      detail.profileId,
      `https://api.test/api/v2/person-profiles/${detail.profileId}`,
      PUBLIC_QUERY_NOW,
    )).resolves.toBeNull()
  })

  it('过期授权无法通过发布门禁，旧并发版本不会产生写入或审计', async () => {
    await insertGallery('gal_expired')
    let detail = await createCandidate('gal_expired', '过期授权人物')
    const staleVersion = detail.lockVersion
    detail = await grantPersonAuthorization(db, detail.personId, {
      expectedVersion: detail.lockVersion,
      evidenceRef: 'internal://expired-authorization',
      validFrom: '2020-01-01T00:00:00.000Z',
      validUntil: '2021-01-01T00:00:00.000Z',
    }, 1)

    await expect(updatePersonCandidate(db, detail.personId, {
      expectedVersion: staleVersion,
      sourceGalleryId: 'gal_expired',
      displayName: '不应写入',
    }, 1)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })

    detail = await submitPersonVerification(db, detail.personId, {
      expectedVersion: detail.lockVersion,
      evidenceRef: 'internal://verification',
    }, 1)
    detail = await reviewPersonVerification(db, detail.personId, {
      expectedVersion: detail.lockVersion,
      verificationId: detail.currentVerification!.id,
      decision: 'verified',
      verificationItems: PERSON_VERIFICATION_ITEMS,
    }, 1)
    await expect(submitPersonPublication(db, detail.personId, {
      expectedVersion: detail.lockVersion,
    }, 1)).rejects.toMatchObject({ code: 'PUBLICATION_GATES_FAILED' })

    const updateAudits = await db.prepare(`
      SELECT COUNT(*) AS count FROM admin_audit_logs WHERE action = 'app_person.update'
    `).first<{ count: number }>()
    expect(updateAudits?.count).toBe(0)
  })
})

async function createCandidate(galleryId: string, displayName: string) {
  return createPersonCandidate(db, {
    sourceGalleryId: galleryId,
    displayName,
    summary: '公开简介',
    tags: ['清新', '生活'],
    regionCode: 'cn-bj',
    regionLabel: '北京市',
    regionPrecision: 'city',
    recommendationScore: 80,
    heatScore: 20,
  }, 1)
}

async function publishCandidate(galleryId: string, displayName: string) {
  let detail = await createCandidate(galleryId, displayName)
  detail = await grantPersonAuthorization(db, detail.personId, {
    expectedVersion: detail.lockVersion,
    evidenceRef: `internal://authorization/${galleryId}`,
    validUntil: '2099-01-01T00:00:00.000Z',
  }, 1)
  detail = await submitPersonVerification(db, detail.personId, {
    expectedVersion: detail.lockVersion,
    evidenceRef: `internal://verification/${galleryId}`,
  }, 1)
  detail = await reviewPersonVerification(db, detail.personId, {
    expectedVersion: detail.lockVersion,
    verificationId: detail.currentVerification!.id,
    decision: 'verified',
    verificationItems: PERSON_VERIFICATION_ITEMS,
    validUntil: '2099-01-01T00:00:00.000Z',
  }, 1)
  detail = await submitPersonPublication(db, detail.personId, {
    expectedVersion: detail.lockVersion,
  }, 1)
  return reviewPersonPublication(db, detail.personId, {
    expectedVersion: detail.lockVersion,
    publicationId: detail.history.publications[0]!.id,
    decision: 'published',
  }, 1)
}

async function insertGallery(id: string, status = 'published') {
  await db.prepare('INSERT INTO galleries (id, title, cover_key, status) VALUES (?, ?, ?, ?)')
    .bind(id, `图库 ${id}`, `covers/${id}.jpg`, status)
    .run()
}

function executableSql(sql: string) {
  return sql
    .split(/\r?\n/u)
    .filter(line => !line.trimStart().startsWith('--'))
    .join(' ')
}
