import { execFile as execFileCallback } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)

export const APPROVED_META_DATASET_QUALITY_CONTRACT = 'docs/superpowers/specs/2026-07-10-meta-dataset-quality-contract.md'
const MAX_CONTRACT_BYTES = 256 * 1024

export async function verifyApprovedMetaDatasetQualityContract(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd())
  const relativePath = APPROVED_META_DATASET_QUALITY_CONTRACT
  const contractPath = path.join(cwd, relativePath)

  try {
    await execFile('git', ['ls-files', '--error-unmatch', '--', relativePath], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 4096,
    })
  } catch {
    throw new Error('Dataset Quality approved contract artifact 缺失或未被 Git tracked')
  }

  const stats = await lstat(contractPath).catch(() => null)
  if (!stats?.isFile() || stats.isSymbolicLink() || stats.size <= 0 || stats.size > MAX_CONTRACT_BYTES) {
    throw new Error('Dataset Quality approved contract artifact 非法')
  }
  const document = await readFile(contractPath, 'utf8')
  const version = Number(document.match(/^- Contract version：`([1-9]\d*)`$/m)?.[1] || 0)
  const approved = /^- Review status：`approved`$/m.test(document)
  const dev = /^- 环境：`dev`$/m.test(document)
  const graphVersion = /^- Graph version：`v25\.0`$/m.test(document)
  if (!approved || !Number.isSafeInteger(version) || version < 1 || !dev || !graphVersion) {
    throw new Error('Dataset Quality contract 尚未 approved 或契约元数据非法')
  }

  return {
    path: relativePath,
    version,
    digest: `sha256:${createHash('sha256').update(document).digest('hex')}`,
  }
}
