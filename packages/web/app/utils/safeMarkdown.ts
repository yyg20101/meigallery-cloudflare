export function escapeHtml(input: string) {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function renderInlineMarkdown(input: string) {
  const linkPattern = /\[([^\]\n]+)\]\(([^)\s]+)\)/g
  let output = ''
  let cursor = 0

  for (const match of input.matchAll(linkPattern)) {
    const start = match.index ?? 0
    output += renderStrongText(input.slice(cursor, start))

    const label = match[1]!
    const href = normalizeMarkdownLink(match[2]!)
    if (href) {
      output += `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${renderStrongText(label)}</a>`
    } else {
      output += renderStrongText(match[0])
    }

    cursor = start + match[0].length
  }

  output += renderStrongText(input.slice(cursor))
  return output
}

function renderStrongText(input: string) {
  return escapeHtml(input).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
}

function normalizeMarkdownLink(value: string) {
  if (hasWhitespaceOrControlCharacter(value) || hasEncodedWhitespaceOrControlCharacter(value)) return null

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }

  if (url.protocol !== 'https:') return null
  return url.toString()
}

function hasEncodedWhitespaceOrControlCharacter(value: string) {
  return /%(?:0[0-9a-f]|1[0-9a-f]|20|7f)/i.test(value)
}

function hasWhitespaceOrControlCharacter(value: string) {
  for (const char of value) {
    const code = char.charCodeAt(0)
    if (code <= 0x20 || code === 0x7f) return true
  }
  return false
}

export function renderSafeMarkdown(markdown: string) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const html: string[] = []
  let listOpen = false

  function closeList() {
    if (listOpen) {
      html.push('</ul>')
      listOpen = false
    }
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) {
      closeList()
      continue
    }
    if (line.startsWith('### ')) {
      closeList()
      html.push(`<h3>${renderInlineMarkdown(line.slice(4))}</h3>`)
      continue
    }
    if (line.startsWith('## ')) {
      closeList()
      html.push(`<h2>${renderInlineMarkdown(line.slice(3))}</h2>`)
      continue
    }
    if (line.startsWith('# ')) {
      closeList()
      html.push(`<h2>${renderInlineMarkdown(line.slice(2))}</h2>`)
      continue
    }
    if (line.startsWith('- ')) {
      if (!listOpen) {
        html.push('<ul>')
        listOpen = true
      }
      html.push(`<li>${renderInlineMarkdown(line.slice(2))}</li>`)
      continue
    }
    closeList()
    html.push(`<p>${renderInlineMarkdown(line)}</p>`)
  }
  closeList()
  return html.join('\n')
}
