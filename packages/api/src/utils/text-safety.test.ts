import { describe, expect, it } from 'vitest'
import {
  containsAsciiControlCharacter,
  containsForbiddenTextControlCharacter,
  containsUnsafeInvisibleCharacter,
  stripAsciiControlCharacters,
} from './text-safety'

describe('文本安全工具', () => {
  it('单行字段识别并移除 ASCII 控制字符', () => {
    expect(containsAsciiControlCharacter('a\u0000b\nc')).toBe(true)
    expect(stripAsciiControlCharacters('a\u0000b\nc\u007f')).toBe('abc')
    expect(containsAsciiControlCharacter('普通文本')).toBe(false)
  })

  it('多行正文保留常用排版字符但拒绝其他控制字符', () => {
    expect(containsForbiddenTextControlCharacter('第一行\n\t第二行\r\n')).toBe(false)
    expect(containsForbiddenTextControlCharacter('正文\u0008')).toBe(true)
    expect(containsForbiddenTextControlCharacter('正文\u007f')).toBe(true)
  })

  it('搜索和规则文本拒绝 C1、零宽与双向控制字符', () => {
    expect(containsUnsafeInvisibleCharacter('正常搜索词')).toBe(false)
    expect(containsUnsafeInvisibleCharacter('异常\u0085文本')).toBe(true)
    expect(containsUnsafeInvisibleCharacter('异常\u200b文本')).toBe(true)
    expect(containsUnsafeInvisibleCharacter('异常\u202e文本')).toBe(true)
    expect(containsUnsafeInvisibleCharacter('异常\ufeff文本')).toBe(true)
  })
})
