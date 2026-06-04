export interface AdminImportManifestEntry {
  folder: string
  title: string
  slug: string
  region?: string
  personality?: string
  style?: string
  tags?: string
  requiredLevel: string
  status: string
}

export interface AdminImportManifestParseResult {
  galleries: AdminImportManifestEntry[]
  errors: string[]
}

const REQUIRED_HEADERS = ['folder', 'title', 'slug']

export function parseAdminImportManifestCsv(csvText: string): AdminImportManifestParseResult {
  const parsed = parseCsvRows(csvText)
  if (parsed.errors.length > 0) return { galleries: [], errors: parsed.errors }

  const rows = parsed.rows.filter(row => row.some(cell => cell.trim()))
  if (rows.length < 2) {
    return { galleries: [], errors: ['manifest.csv 至少需要表头和一行数据'] }
  }

  const headers = rows[0]!.map(header => header.trim())
  const missingHeaders = REQUIRED_HEADERS.filter(header => !headers.includes(header))
  if (missingHeaders.length > 0) {
    return { galleries: [], errors: [`manifest.csv 缺少必填列：${missingHeaders.join(', ')}`] }
  }

  const galleries = rows.slice(1).map((values) => {
    const record: Record<string, string> = {}
    headers.forEach((header, index) => {
      record[header] = values[index]?.trim() || ''
    })

    return {
      folder: record['folder'] || '',
      title: record['title'] || '',
      slug: record['slug'] || '',
      region: record['region'] || undefined,
      personality: record['personality'] || undefined,
      style: record['style'] || undefined,
      tags: record['tags'] || undefined,
      requiredLevel: record['required_level'] || 'free',
      status: record['status'] || 'draft',
    }
  })

  return { galleries, errors: [] }
}

function parseCsvRows(csvText: string): { rows: string[][]; errors: string[] } {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQuotes = false

  for (let i = 0; i < csvText.length; i++) {
    const char = csvText[i]!

    if (char === '"') {
      if (inQuotes && csvText[i + 1] === '"') {
        cell += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
      continue
    }

    if (char === ',' && !inQuotes) {
      row.push(cell.trim())
      cell = ''
      continue
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      row.push(cell.trim())
      rows.push(row)
      row = []
      cell = ''
      if (char === '\r' && csvText[i + 1] === '\n') i++
      continue
    }

    cell += char
  }

  if (inQuotes) return { rows: [], errors: ['manifest.csv 存在未闭合的引号字段'] }

  row.push(cell.trim())
  rows.push(row)

  return { rows, errors: [] }
}
