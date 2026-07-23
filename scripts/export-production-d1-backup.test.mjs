import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { runProductionBackup, validateBackupSql } from './export-production-d1-backup.mjs'

const COMMIT = 'a'.repeat(40)

describe('production D1 备份', () => {
  it('导出 SQL、哈希和 Time Travel bookmark 到仓库外目录', async () => {
    const backupDir = await mkdtemp(path.join(tmpdir(), 'meigallery-backup-'))
    try {
      const result = await runProductionBackup({
        backupDir,
        now: () => new Date('2026-07-16T00:00:00.000Z'),
        exportDatabase: output => writeFile(output, 'CREATE TABLE example (id TEXT PRIMARY KEY);\n'),
        getBookmark: async () => 'bookmark-1',
        getCommit: async () => COMMIT,
      })
      const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'))
      assert.equal(manifest.purpose, 'production-d1-before-attribution-migration')
      assert.equal(manifest.gitCommit, COMMIT)
      assert.equal(manifest.timeTravelBookmark, 'bookmark-1')
      assert.match(manifest.sha256, /^[0-9a-f]{64}$/)
    }
    finally {
      await rm(backupDir, { recursive: true, force: true })
    }
  })

  it('拒绝不完整的 SQL 导出', () => {
    assert.throws(() => validateBackupSql('SELECT 1;'), /ATTRIBUTION_BACKUP_SQL_INVALID/)
  })
})
