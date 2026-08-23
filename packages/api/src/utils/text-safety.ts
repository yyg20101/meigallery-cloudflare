const ASCII_DELETE = 0x7f

/**
 * 检查任何不应进入标识符、文件名或单行证据的 ASCII 控制字符。
 */
export function containsAsciiControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 0x1f || codePoint === ASCII_DELETE
  })
}

/**
 * 检查多行正文中禁止的控制字符；保留制表、换行和回车。
 */
export function containsForbiddenTextControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint === ASCII_DELETE
      || (codePoint <= 0x1f && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d)
  })
}

/**
 * 检查搜索、规则和 Taxonomy 文本中会造成不可见或双向显示混淆的字符。
 */
export function containsUnsafeInvisibleCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 0x1f
      || (codePoint >= 0x7f && codePoint <= 0x9f)
      || (codePoint >= 0x200b && codePoint <= 0x200f)
      || (codePoint >= 0x202a && codePoint <= 0x202e)
      || (codePoint >= 0x2060 && codePoint <= 0x206f)
      || codePoint === 0xfeff
  })
}

export function stripAsciiControlCharacters(value: string): string {
  return Array.from(value)
    .filter(character => !containsAsciiControlCharacter(character))
    .join('')
}
