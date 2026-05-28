import { describe, expect, it } from 'vitest'
import { apiError } from './api-error'

describe('统一 API 错误响应', () => {
  it('输出 statusCode 和 message，并按需附加 code/detail', () => {
    expect(apiError(400, '参数无效')).toEqual({
      statusCode: 400,
      message: '参数无效',
    })

    expect(apiError(403, '需要管理员权限', { code: 'ADMIN_REQUIRED', detail: { role: 'user' } })).toEqual({
      statusCode: 403,
      message: '需要管理员权限',
      code: 'ADMIN_REQUIRED',
      detail: { role: 'user' },
    })
  })
})
