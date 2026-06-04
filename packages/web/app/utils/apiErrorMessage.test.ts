import { describe, expect, it } from 'vitest'
import { resolveApiErrorMessage } from './apiErrorMessage'

describe('apiErrorMessage', () => {
  it('优先读取对象形态的标准 message', () => {
    expect(resolveApiErrorMessage({
      data: { statusCode: 400, message: '图库状态无效' },
    }, '操作失败')).toBe('图库状态无效')
  })

  it('兼容字符串形态的标准错误体', () => {
    expect(resolveApiErrorMessage({
      data: JSON.stringify({ statusCode: 403, message: '需要管理员权限' }),
    }, '操作失败')).toBe('需要管理员权限')
  })

  it('兼容历史 error 字段', () => {
    expect(resolveApiErrorMessage({
      data: { error: '旧格式错误' },
    }, '操作失败')).toBe('旧格式错误')
  })

  it('忽略非 JSON 响应正文并使用默认文案', () => {
    expect(resolveApiErrorMessage({
      data: '<!doctype html><title>Bad Gateway</title>',
    }, '操作失败')).toBe('操作失败')
  })

  it('缺少错误体时兼容 Error.message', () => {
    expect(resolveApiErrorMessage(new Error('网络连接失败'), '操作失败')).toBe('网络连接失败')
  })
})
