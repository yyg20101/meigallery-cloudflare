/**
 * 导入 manifest 解析工具
 */

export interface ManifestEntry {
  folder: string
  title: string
  slug: string
  summary?: string
  bodyMd?: string
  region?: string
  personality?: string
  style?: string
  tags?: string
  requiredLevel?: string
  status?: string
}

export interface ParseResult {
  entries: ManifestEntry[]
  errors: Array<{ line: number; error: string }>
}

/**
 * 解析 manifest CSV 文本
 * 支持带引号字段（逗号在引号内不拆分）
 */
export function parseManifestCsv(csvText: string): ParseResult {
  const lines = csvText.trim().split('\n')
  if (lines.length < 2) {
    return { entries: [], errors: [{ line: 1, error: 'CSV 至少需要表头和一行数据' }] }
  }

  const headers = parseCsvLine(lines[0]!)
  const requiredHeaders = ['folder', 'title', 'slug']
  const missingHeaders = requiredHeaders.filter(h => !headers.includes(h))
  if (missingHeaders.length > 0) {
    return { entries: [], errors: [{ line: 1, error: `缺少必填列: ${missingHeaders.join(', ')}` }] }
  }

  const entries: ManifestEntry[] = []
  const errors: Array<{ line: number; error: string }> = []

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (!line) continue

    const values = parseCsvLine(line)
    const record: Record<string, string> = {}
    headers.forEach((h, idx) => {
      record[h] = values[idx] || ''
    })

    // 校验必填字段
    if (!record['folder']) {
      errors.push({ line: i + 1, error: '缺少 folder' })
      continue
    }
    if (!record['title']) {
      errors.push({ line: i + 1, error: '缺少 title' })
      continue
    }
    if (!record['slug']) {
      errors.push({ line: i + 1, error: '缺少 slug' })
      continue
    }

    // 校验 slug 格式（仅允许小写字母、数字、中文、连字符）
    if (!/^[a-z0-9\u4e00-\u9fa5-]+$/.test(record['slug'])) {
      errors.push({ line: i + 1, error: `slug 格式无效: "${record['slug']}"` })
      continue
    }

    // 校验 requiredLevel
    const validLevels = ['', 'free', 'vip', 'svip']
    if (record['required_level'] && !validLevels.includes(record['required_level'])) {
      errors.push({ line: i + 1, error: `无效的 required_level: "${record['required_level']}"` })
      continue
    }

    // 校验 status
    const validStatuses = ['', 'draft', 'published']
    if (record['status'] && !validStatuses.includes(record['status'])) {
      errors.push({ line: i + 1, error: `无效的 status: "${record['status']}"` })
      continue
    }

    entries.push({
      folder: record['folder'],
      title: record['title'],
      slug: record['slug'],
      summary: record['summary'] || undefined,
      bodyMd: record['body_md'] || undefined,
      region: record['region'] || undefined,
      personality: record['personality'] || undefined,
      style: record['style'] || undefined,
      tags: record['tags'] || undefined,
      requiredLevel: record['required_level'] || undefined,
      status: record['status'] || undefined,
    })
  }

  return { entries, errors }
}

/**
 * 解析单行 CSV（支持引号内逗号）
 */
export function parseCsvLine(line: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const char = line[i]!
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"'
        i++ // 跳过转义引号
      } else {
        inQuotes = !inQuotes
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim())
      current = ''
    } else {
      current += char
    }
  }
  result.push(current.trim())

  return result
}

/**
 * 将 requiredLevel 字符串转换为 rank 数值
 */
export function levelToRank(level?: string): number {
  switch (level) {
    case 'vip': return 10
    case 'svip': return 20
    default: return 0
  }
}
