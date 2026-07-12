import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { promisify } from 'node:util'
import {
  APPROVED_META_DATASET_QUALITY_CONTRACT,
  verifyApprovedMetaDatasetQualityContract,
} from './meta-dataset-quality-contract-lib.mjs'

const execFile = promisify(execFileCallback)

describe('Dataset Quality approved contract gate', () => {
  it('当前仓库缺少完成态 contract 时稳定失败', async () => {
    await assert.rejects(
      verifyApprovedMetaDatasetQualityContract({ cwd: process.cwd() }),
      /缺失|tracked/,
    )
  })

  it('只接受 Git tracked、approved、带版本的 production v25.0 artifact，并计算内容 digest', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'meta-contract-gate-'))
    try {
      await execFile('git', ['init'], { cwd })
      const contractPath = path.join(cwd, APPROVED_META_DATASET_QUALITY_CONTRACT)
      await mkdir(path.dirname(contractPath), { recursive: true })
      await writeFile(contractPath, [
        '# Meta Dataset Quality 官方契约',
        '',
        '- Review status：`approved`',
        '- Contract version：`3`',
        '- 环境：`production`',
        '- Graph version：`v25.0`',
        '',
      ].join('\n'))

      await assert.rejects(verifyApprovedMetaDatasetQualityContract({ cwd }), /tracked/)
      await execFile('git', ['add', APPROVED_META_DATASET_QUALITY_CONTRACT], { cwd })
      const result = await verifyApprovedMetaDatasetQualityContract({ cwd })
      assert.equal(result.version, 3)
      assert.match(result.digest, /^sha256:[0-9a-f]{64}$/)

      await writeFile(contractPath, (await readFile(contractPath, 'utf8')).replace('`approved`', '`pending`'))
      await assert.rejects(verifyApprovedMetaDatasetQualityContract({ cwd }), /approved/)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
